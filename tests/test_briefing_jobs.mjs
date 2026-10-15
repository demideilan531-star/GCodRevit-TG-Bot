import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../cloudflare-worker/src/index.js";
import { handleBriefingBrokerApi, queueBriefing } from "../cloudflare-worker/src/briefing-jobs.js";
import { collectBriefingTasks } from "../cloudflare-worker/src/morning-briefing.js";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const name of ["0001_create_tasks.sql", "0002_add_subtasks.sql", "0003_add_assistant_users_and_gmail.sql", "0004_add_briefing_requests.sql"]) {
    sqlite.exec(readFileSync(new URL(`../cloudflare-worker/migrations/${name}`, import.meta.url), "utf8"));
  }
  const env = {
    GMAIL_BROKER_TOKEN: "fake-broker-token", TELEGRAM_BOT_TOKEN: "fake-bot-token", TELEGRAM_WEBHOOK_SECRET: "fake-secret",
    TASKS_DB: { prepare(sql) { return { bind(...values) {
      const statement = sqlite.prepare(sql);
      return {
        all: async () => ({ results: statement.all(...values) }),
        first: async () => statement.get(...values) || null,
        run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
      };
    } }; } },
  };
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO assistant_users (id, telegram_user_id, username, status, created_at, updated_at) VALUES ('test', '200', 'testuser', 'active', ?, ?)").run(now, now);
  for (const owner of ["200", "300"]) sqlite.prepare(
    "INSERT INTO tasks (id, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?)",
  ).run(crypto.randomUUID(), owner, `Private task ${owner}`, now, now);
  const sent = [], edited = [], dispatched = [], promises = [];
  const helpers = {
    sendMessage: async (_env, chatId, text) => { sent.push({ chatId, text }); return { result: { message_id: 22 } }; },
    telegramApi: async (_env, method, body) => { edited.push({ method, body }); },
    dispatchWorkflow: async (id) => { dispatched.push(id); },
    ctx: { waitUntil(promise) { promises.push(promise); } },
    collectBriefingTasks,
  };
  const message = { from: { id: 200 }, chat: { id: 200, type: "private" } };
  const call = (path, body, token = env.GMAIL_BROKER_TOKEN) => handleBriefingBrokerApi(new Request(`https://example.com/internal/briefing/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), env, helpers);
  return { sqlite, env, helpers, message, call, sent, edited, dispatched, promises };
}

test("queue dispatch contains only an opaque ID and one owner can have only one active request", async (t) => {
  const f = fixture(t);
  await queueBriefing(f.env, f.message, f.helpers);
  await queueBriefing(f.env, f.message, f.helpers);
  await Promise.all(f.promises);
  assert.equal(f.dispatched.length, 1);
  assert.match(f.dispatched[0], /^[\da-f-]{36}$/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM briefing_requests").get().n, 1);
  assert.doesNotMatch(JSON.stringify(f.dispatched), /Private task|"200"/);
});

test("claim uses the persisted owner not a supplied ID and can only be claimed once", async (t) => {
  const f = fixture(t);
  await queueBriefing(f.env, f.message, f.helpers);
  const body = { request_id: f.dispatched[0], owner_id: "300", chat_id: "-123" };
  const response = await f.call("claim", body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const claim = await response.json();
  assert.equal(claim.chat_id, "200");
  assert.equal(claim.message_id, 22);
  assert.match(JSON.stringify(claim.tasks), /Private task 200/);
  assert.doesNotMatch(JSON.stringify(claim.tasks), /Private task 300/);
  assert.equal((await f.call("claim", body)).status, 409);
  assert.equal((await f.call("complete", { ...body, success: true })).status, 200);
  assert.equal(f.edited.length, 0);
  assert.equal((await f.call("complete", { ...body, success: true })).status, 409);
});

test("wrong auth, blocked users, expired IDs and oversized bodies cannot expose tasks", async (t) => {
  const f = fixture(t);
  await queueBriefing(f.env, f.message, f.helpers);
  const body = { request_id: f.dispatched[0] };
  assert.equal((await f.call("claim", body, "wrong")).status, 403);
  assert.equal((await f.call("claim", { request_id: "unknown" })).status, 404);
  assert.equal((await f.call("claim", { request_id: "x".repeat(2000) })).status, 413);
  f.sqlite.exec("UPDATE assistant_users SET status = 'blocked'");
  assert.equal((await f.call("claim", body)).status, 403);
  f.sqlite.exec("UPDATE assistant_users SET status = 'active'; UPDATE briefing_requests SET expires_at = '2000-01-01T00:00:00Z'");
  assert.equal((await f.call("claim", body)).status, 404);
  await queueBriefing(f.env, f.message, f.helpers);
  assert.equal(f.dispatched.length, 2);
});

test("permissions are checked again at claim time", async (t) => {
  const f = fixture(t);
  await queueBriefing(f.env, f.message, f.helpers);
  f.sqlite.exec("UPDATE assistant_users SET can_tasks = 0, can_weather = 0");
  const claim = await (await f.call("claim", { request_id: f.dispatched[0] })).json();
  assert.equal(claim.can_weather, false);
  assert.deepEqual(claim.tasks, { unavailable: "Список задач недоступен." });
});

test("failed workflow edits the existing placeholder rather than publishing another report", async (t) => {
  const f = fixture(t);
  f.helpers.dispatchWorkflow = async () => { throw new Error("dispatch failed"); };
  t.mock.method(console, "error", () => {});
  await queueBriefing(f.env, f.message, f.helpers);
  await Promise.all(f.promises);
  assert.equal(f.sent.length, 1);
  assert.equal(f.edited[0].method, "editMessageText");
  assert.equal(f.edited[0].body.message_id, 22);
  assert.equal(f.sqlite.prepare("SELECT status FROM briefing_requests").get().status, "failed");
});

test("full webhook starts a private image job without sending private task content to GitHub", async (t) => {
  const f = fixture(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    return String(url).includes("api.github.com") ? new Response(null, { status: 204 }) : Response.json({ ok: true, result: { message_id: 22 } });
  });
  f.env.GITHUB_TOKEN = "fake-github-token";
  const response = await worker.fetch(new Request("https://example.com/", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": f.env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ message: { ...f.message, text: "Утренний брифинг" } }),
  }), f.env, f.helpers.ctx);
  await Promise.all(f.promises);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /morning-briefing.yml\/dispatches$/);
  assert.deepEqual(Object.keys(calls[1].body.inputs), ["request_id"]);
  assert.doesNotMatch(JSON.stringify(calls), /Private task/);
});
