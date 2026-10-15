import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../cloudflare-worker/src/index.js";
import {
  BUTTON_MORNING_BRIEFING,
  buildMorningBriefing,
  handleMorningBriefingUpdate,
  moscowDayBounds,
} from "../cloudflare-worker/src/morning-briefing.js";

const NOW = new Date("2026-10-15T06:00:00Z");
const ACCESS = { role: "user", canTasks: true };

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const name of [
    "0001_create_tasks.sql", "0002_add_subtasks.sql", "0003_add_assistant_users_and_gmail.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../cloudflare-worker/migrations/${name}`, import.meta.url), "utf8"));
  }
  return {
    sqlite,
    env: {
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      TASKS_DB: {
        prepare(sql) {
          return {
            bind(...values) {
              const statement = sqlite.prepare(sql);
              return {
                all: async () => ({ results: statement.all(...values) }),
                first: async () => statement.get(...values) || null,
                run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
              };
            },
          };
        },
      },
    },
    add(title, { owner = "200", due = "2026-10-15T12:00:00.000Z", status = "todo", flags = "[]", subtasks = "[]" } = {}) {
      sqlite.prepare(
        `INSERT INTO tasks (id, owner_id, title, due_at, status, flags_json, subtasks_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), owner, title, due, status, flags, subtasks, NOW.toISOString(), NOW.toISOString());
    },
  };
}

test("day boundaries follow Moscow midnight rather than UTC", () => {
  assert.deepEqual(moscowDayBounds(new Date("2026-10-14T21:00:00Z")), {
    start: "2026-10-14T21:00:00.000Z", end: "2026-10-15T21:00:00.000Z",
  });
  assert.equal(moscowDayBounds(new Date("2026-10-14T20:59:59Z")).end, "2026-10-14T21:00:00.000Z");
  assert.equal(moscowDayBounds(new Date("2026-12-31T22:00:00Z")).end, "2027-01-01T21:00:00.000Z");
});

test("actual SQLite selection isolates owner, active statuses, and day boundaries", async (t) => {
  const { env, add } = fixture(t);
  add("Сегодня в полночь", { due: "2026-10-14T21:00:00.000Z" });
  add("Сегодня вечером", { due: "2026-10-15T20:59:59.000Z", status: "in_progress" });
  add("Просрочено", { due: "2026-10-14T20:59:59.000Z" });
  add("Без дедлайна", { due: null });
  add("Завтра", { due: "2026-10-15T21:00:00.000Z" });
  add("Чужая задача", { owner: "300" });
  for (const status of ["draft", "done", "archived"]) add(`Исключить ${status}`, { status });
  const text = await buildMorningBriefing(env, { ownerId: 200, access: ACCESS, now: NOW });
  assert.match(text, /15 октября 2026/);
  assert.match(text, /00:00 — Сегодня в полночь/);
  assert.match(text, /23:59 — Сегодня вечером · В работе/);
  assert.match(text, /Просроченные задачи\n• 14.10.2026 — Просрочено/);
  assert.match(text, /Без срока\n• Без дедлайна/);
  assert.doesNotMatch(text, /Завтра|Чужая|Исключить/);
  assert.ok(text.indexOf("Сегодня в полночь") < text.indexOf("Сегодня вечером"));
});

test("empty and future-only lists explicitly report no tasks for today", async (t) => {
  const { env, add } = fixture(t);
  add("Будущее", { due: "2026-10-20T12:00:00.000Z" });
  const text = await buildMorningBriefing(env, { ownerId: 200, access: ACCESS, now: NOW });
  assert.match(text, /Задач на сегодня нет\./);
  assert.doesNotMatch(text, /Просроченные|Без срока|Будущее/);
});

test("briefing includes known flags and actual subtask progress", async (t) => {
  const { env, add } = fixture(t);
  add("Фасады", {
    flags: '["work","urgent","invented"]',
    subtasks: '[{"title":"A","done":true},{"title":"B","done":false}]',
  });
  add("Повреждённые метаданные", { flags: "invalid", subtasks: "{}" });
  const text = await buildMorningBriefing(env, { ownerId: 200, access: ACCESS, now: NOW });
  assert.match(text, /Работа · Срочно · 1\/2 подзадач/);
  assert.doesNotMatch(text, /invented|Не удалось/);
});

test("large lists fit one Telegram message and retain remainder counts", async (t) => {
  const { env, add } = fixture(t);
  for (let index = 0; index < 40; index += 1) {
    add(`Сегодня ${index} ${"а".repeat(140)}`, { flags: '["gcod","personal"]' });
    add(`Вчера ${index} ${"б".repeat(140)}`, { due: "2026-10-14T12:00:00.000Z" });
    add(`Без срока ${index} ${"в".repeat(140)}`, { due: null });
  }
  const text = await buildMorningBriefing(env, { ownerId: 200, access: ACCESS, now: NOW });
  assert.ok(text.length <= 3800);
  assert.match(text, /Ещё 32 — в календаре\./);
  assert.equal((text.match(/Ещё 36 — в календаре\./g) || []).length, 2);
});

test("disabled task access does not query the database", async () => {
  const text = await buildMorningBriefing({}, {
    ownerId: 200, access: { canTasks: false }, now: NOW,
  });
  assert.match(text, /Список задач недоступен/);
});

test("database errors are not presented as an empty day", async (t) => {
  t.mock.method(console, "error", () => {});
  const text = await buildMorningBriefing({}, { ownerId: 200, access: ACCESS, now: NOW });
  assert.match(text, /Не удалось загрузить задачи/);
  assert.doesNotMatch(text, /Задач на сегодня нет/);
});

test("private button and command route to the briefing without capturing a task", async (t) => {
  const { env } = fixture(t);
  const sent = [];
  for (const text of [BUTTON_MORNING_BRIEFING, "/briefing", "/briefing@GCodRevit_bot"]) {
    assert.equal(await handleMorningBriefingUpdate({ message: {
      text, from: { id: 200 }, chat: { id: 200, type: "private" },
    } }, env, {
      access: ACCESS, now: NOW,
      sendMessage: async (_env, chatId, message) => sent.push({ chatId, message }),
    }), true);
  }
  assert.equal(sent.length, 3);
  assert.ok(sent.every(({ chatId, message }) => chatId === 200 && message.startsWith(BUTTON_MORNING_BRIEFING)));
});

test("briefing cannot publish an administrator's personal tasks into a group", async () => {
  const sent = [];
  await handleMorningBriefingUpdate({ message: {
    text: "/briefing", from: { id: 1839693017 }, chat: { id: -123, type: "group" },
  } }, {}, {
    access: { ...ACCESS, role: "admin" },
    sendMessage: async (...args) => sent.push(args),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /личном чате/);
});

test("full webhook exposes the button and sends only the authenticated user's briefing", async (t) => {
  const { env, sqlite, add } = fixture(t);
  sqlite.prepare(
    `INSERT INTO assistant_users (id, telegram_user_id, username, status, can_weather, created_at, updated_at)
     VALUES ('active-test', '200', 'testuser', 'active', 0, ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString());
  add("Чужая задача", { owner: "300", due: null });
  add("Моя задача", { due: null });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/bottest-bot-token/"));
    const payload = JSON.parse(options.body);
    if (String(url).endsWith("/sendMessage")) sent.push(payload);
    return Response.json({ ok: true, result: {} });
  });
  const ctx = { waitUntil() { assert.fail("Briefing must not launch an AI or GitHub job"); } };
  for (const text of ["/start", BUTTON_MORNING_BRIEFING]) {
    const response = await worker.fetch(new Request("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ message: { text, from: { id: 200, username: "testuser" }, chat: { id: 200, type: "private" } } }),
    }), env, ctx);
    assert.equal(response.status, 200);
  }
  assert.equal(sent.length, 2);
  assert.ok(sent[0].reply_markup.keyboard.flat().some(({ text }) => text === BUTTON_MORNING_BRIEFING));
  assert.match(sent[1].text, /Моя задача/);
  assert.doesNotMatch(sent[1].text, /Чужая задача/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM tasks").get().total, 2);
});
