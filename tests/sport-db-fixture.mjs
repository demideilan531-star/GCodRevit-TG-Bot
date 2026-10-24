import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  "0001_create_tasks.sql",
  "0002_add_subtasks.sql",
  "0003_add_assistant_users_and_gmail.sql",
  "0004_add_briefing_requests.sql",
  "0005_add_sport.sql",
  "0006_add_sport_sheet_exports.sql",
];

export const OWNER = "810001";
export const OTHER_OWNER = "810002";
export const BLOCKED_OWNER = "810003";
export const UNKNOWN_OWNER = "810004";

export function createSqliteD1(t, { migrations = MIGRATIONS } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations) {
    sqlite.exec(readFileSync(new URL(`../cloudflare-worker/migrations/${name}`, import.meta.url), "utf8"));
  }

  const statements = new WeakMap();
  const plainRow = (row) => row ? { ...row } : null;
  const changes = () => Number(sqlite.prepare("SELECT total_changes() AS n").get().n);
  function execute(sql, values, mode) {
    const statement = sqlite.prepare(sql);
    if (mode === "first") return plainRow(statement.get(...values));
    const before = changes();
    if (mode === "run") {
      const result = statement.run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    const results = statement.all(...values).map(plainRow);
    return { success: true, results, meta: { changes: changes() - before } };
  }
  function prepared(sql, values = []) {
    const result = {
      bind(...bindings) { return prepared(sql, bindings); },
      async first(column) {
        const row = execute(sql, values, "first");
        return column === undefined ? row : row?.[column] ?? null;
      },
      async all() { return execute(sql, values, "all"); },
      async run() { return execute(sql, values, "run"); },
    };
    statements.set(result, { sql, values });
    return result;
  }
  const db = {
    prepare(sql) { return prepared(sql); },
    async batch(batch) {
      sqlite.exec("BEGIN TRANSACTION");
      try {
        const results = batch.map((statement) => {
          const bound = statements.get(statement);
          if (!bound) throw new TypeError("batch requires statements from this database");
          return execute(bound.sql, bound.values, "all");
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db };
}

export function signedInitData(env, ownerId = OWNER, { authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "fictional-sport-query",
    user: JSON.stringify({ id: Number(ownerId), first_name: "Fictional sport tester" }),
  });
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheck).digest("hex"));
  return params.toString();
}

export function createSportFixture(t) {
  const { sqlite, db } = createSqliteD1(t);
  sqlite.exec("DELETE FROM assistant_users");
  const now = new Date().toISOString();
  for (const [ownerId, status] of [[OWNER, "active"], [OTHER_OWNER, "active"], [BLOCKED_OWNER, "blocked"]]) {
    sqlite.prepare(`INSERT INTO assistant_users
      (id, telegram_user_id, username, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`fictional-${ownerId}`, ownerId, `fictional_${ownerId}`, status, now, now);
  }
  const env = {
    TASKS_DB: db,
    SPORT_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "810000:fictional-sport-bot-token",
    TELEGRAM_ADMIN_IDS: "819999",
    TELEGRAM_WEBHOOK_SECRET: "fictional-sport-webhook-secret",
  };
  function request(path = "", { method = "GET", body, ownerId = OWNER, initData, headers = {} } = {}) {
    const authorization = initData === null ? {} : { Authorization: `tma ${initData ?? signedInitData(env, ownerId)}` };
    return new Request(`https://sport.example.test/api/sport${path}`, {
      method,
      headers: { ...authorization, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const calls = [];
  const helpers = {
    async telegramApi(_env, method, body) {
      const messageId = 9001 + calls.length;
      calls.push({ method, body, messageId });
      return { ok: true, result: { message_id: messageId } };
    },
    async sendMessage(_env, chatId, text, ...options) {
      const messageId = 9001 + calls.length;
      calls.push({ method: "sendMessage", body: { chat_id: chatId, text }, options, messageId });
      return { ok: true, result: { message_id: messageId } };
    },
  };
  function message(text, extra = {}, ownerId = OWNER) {
    return { message: {
      message_id: 7001,
      from: { id: Number(ownerId), first_name: "Fictional sport tester" },
      chat: { id: Number(ownerId), type: "private" },
      text,
      ...extra,
    } };
  }
  function seedPrompt({
    id = "fictional-prompt-01", ownerId = OWNER, chatId = ownerId,
    messageId = 6001, kind = "sleep", date = "2026-10-22", time = "09:00",
    status = "pending", createdAt = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 18 * 3600000).toISOString(),
  } = {}) {
    sqlite.prepare(`INSERT INTO sport_prompts
      (id, owner_id, chat_id, message_id, kind, label, date, time, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, chatId, messageId, kind, "Fictional question", date, time, status, createdAt, expiresAt);
    if (messageId !== null) sqlite.prepare(`INSERT INTO sport_prompt_messages
      (owner_id, chat_id, message_id, prompt_id) VALUES (?, ?, ?, ?)`)
      .run(ownerId, chatId, messageId, id);
    return { id, ownerId, chatId, messageId, kind, date, time };
  }
  function seedReminder({
    id = "fictional-reminder-01", ownerId = OWNER, kind = "sleep", time = "09:00",
    timezone = "Europe/Moscow", due = new Date().toISOString(), enabled = true,
  } = {}) {
    const createdAt = new Date().toISOString();
    sqlite.prepare(`INSERT INTO sport_profiles (owner_id, timezone, goals_json, updated_at)
      VALUES (?, ?, '{}', ?) ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone`)
      .run(ownerId, timezone, createdAt);
    sqlite.prepare(`INSERT INTO sport_reminders
      (id, owner_id, kind, time, label, enabled, next_due_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, kind, time, `Fictional ${kind} question`, Number(enabled), due, createdAt);
    return { id, ownerId, kind, time, due };
  }
  return { sqlite, db, env, request, calls, helpers, message, seedPrompt, seedReminder };
}
