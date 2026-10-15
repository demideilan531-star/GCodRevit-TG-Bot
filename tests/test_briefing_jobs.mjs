import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../cloudflare-worker/src/index.js";
import { handleBriefingBrokerApi, queueBriefing, runScheduledBriefing, MORNING_BRIEFING_CRON } from "../cloudflare-worker/src/briefing-jobs.js";
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
    sendMessage: async (_env, chatId, text, withKeyboard) => { sent.push({ chatId, text, withKeyboard }); return { result: { message_id: 22 } }; },
    telegramApi: async (_env, method, body) => { edited.push({ method, body }); },
    dispatchWorkflow: async (id) => { dispatched.push(id); },
    ctx: { waitUntil(promise) { promises.push(promise); } },
    collectBriefingTasks,
    keyboard: (role) => ({ keyboard: [[{ text: role === "admin" ? "GitHub" : "Почта" }]], is_persistent: true, one_time_keyboard: false }),
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
  assert.equal(f.sent[0].withKeyboard, false);
  assert.equal(claim.reply_keyboard.is_persistent, true);
  assert.equal(claim.reply_keyboard.keyboard[0][0].text, "Почта");
  assert.match(JSON.stringify(claim.tasks), /Private task 200/);
  assert.doesNotMatch(JSON.stringify(claim.tasks), /Private task 300/);
  assert.equal((await f.call("claim", body)).status, 409);
  assert.equal((await f.call("complete", { ...body, success: true })).status, 200);
  assert.equal(f.edited.length, 0);
  assert.equal((await f.call("complete", { ...body, success: true })).status, 409);
});

test("daily briefing is 08:00 Moscow, once per date, only for the configured administrator", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_USER_ID: "1839693017" });
  const event = { cron: MORNING_BRIEFING_CRON, scheduledTime: Date.parse("2026-10-16T05:00:00Z") };
  assert.equal(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit" }).format(new Date(event.scheduledTime)), "08");
  assert.equal(await runScheduledBriefing(event, f.env, f.helpers), true);
  const id = f.dispatched[0];
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(f.sent[0].chatId, "1839693017");
  assert.equal(f.sent[0].withKeyboard, false);
  f.sqlite.prepare("UPDATE briefing_requests SET status = 'completed', expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
  assert.equal(await runScheduledBriefing(event, f.env, f.helpers), false);
  assert.equal(f.sent.length, 1);
  assert.equal(f.dispatched.length, 1);
  assert.equal(await runScheduledBriefing({ ...event, scheduledTime: event.scheduledTime + 86400000 }, f.env, f.helpers), true);
  assert.equal(f.dispatched.length, 2);
});

test("disabling automatic delivery leaves the manual briefing request independent", async (t) => {
  const f = fixture(t);
  const event = { cron: MORNING_BRIEFING_CRON, scheduledTime: Date.now() };
  Object.assign(f.env, { MORNING_BRIEFING_ENABLED: "false", MORNING_BRIEFING_USER_ID: "1839693017" });
  assert.equal(await runScheduledBriefing(event, f.env, f.helpers), false);
  assert.equal(f.dispatched.length, 0);
  await queueBriefing(f.env, f.message, f.helpers);
  assert.equal(f.dispatched.length, 1);
});

test("scheduler rejects groups, ordinary recipients, and ignores unrelated cron events", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_USER_ID: "-123" });
  const event = { cron: MORNING_BRIEFING_CRON, scheduledTime: Date.now() };
  await assert.rejects(runScheduledBriefing(event, f.env, f.helpers), /private Telegram user ID/);
  f.env.MORNING_BRIEFING_USER_ID = "200";
  await assert.rejects(runScheduledBriefing(event, f.env, f.helpers), /administrator/);
  assert.equal(await runScheduledBriefing({ ...event, cron: "0 0 * * *" }, f.env, f.helpers), false);
  assert.equal(f.sent.length, 0);
});

test("production cron configuration matches 08:00 Moscow", () => {
  const config = JSON.parse(readFileSync(new URL("../cloudflare-worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, [MORNING_BRIEFING_CRON]);
  assert.equal(config.vars.MORNING_BRIEFING_ENABLED, "true");
  assert.equal(config.vars.MORNING_BRIEFING_USER_ID, "1839693017");
});

test("photo keyboard is built by the Worker from the current role, never from job input", async (t) => {
  const f = fixture(t);
  for (const ownerId of [200, 1839693017]) {
    await queueBriefing(f.env, { from: { id: ownerId }, chat: { id: ownerId, type: "private" } }, f.helpers);
    const id = f.dispatched.at(-1);
    const response = await worker.fetch(new Request("https://example.com/internal/briefing/claim", {
      method: "POST", headers: { Authorization: `Bearer ${f.env.GMAIL_BROKER_TOKEN}` },
      body: JSON.stringify({ request_id: id, role: "admin" }),
    }), f.env, f.helpers.ctx);
    assert.equal(response.status, 200);
    const claim = await response.json();
    const texts = claim.reply_keyboard.keyboard.flat().map(({ text }) => text);
    assert.equal(claim.reply_keyboard.is_persistent, true);
    assert.equal(claim.reply_keyboard.one_time_keyboard, false);
    assert.ok(!texts.includes("Утренний брифинг"));
    assert.equal(texts.some((text) => text.includes("GitHub")), ownerId === 1839693017);
    assert.equal(texts.length, ownerId === 1839693017 ? 4 : 2);
  }
});

test("native scheduled handler dispatches only the opaque ID without an incoming chat message", async (t) => {
  const f = fixture(t);
  Object.assign(f.env, { MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_USER_ID: "1839693017", GITHUB_TOKEN: "fake-github" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    return String(url).includes("api.github.com") ? new Response(null, { status: 204 }) : Response.json({ ok: true, result: { message_id: 22 } });
  });
  await worker.scheduled({ cron: MORNING_BRIEFING_CRON, scheduledTime: Date.now() }, f.env, f.helpers.ctx);
  await Promise.all(f.promises);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.chat_id, "1839693017");
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.deepEqual(Object.keys(calls[1].body.inputs), ["request_id"]);
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
