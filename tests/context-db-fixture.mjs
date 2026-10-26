import { readFileSync } from "node:fs";
import { createSqliteD1, signedInitData } from "./sport-db-fixture.mjs";

export const CONTEXT_OWNER = "820001";
export const CONTEXT_OTHER_OWNER = "820002";
export const CONTEXT_BLOCKED_OWNER = "820003";
export const CONTEXT_NO_TASKS_OWNER = "820004";
export const CONTEXT_UNKNOWN_OWNER = "820005";
export const CONTEXT_ADMIN = "829999";
export const CONTEXT_CHAT = "830001";
export const CONTEXT_OTHER_CHAT = "830002";
export const CONTEXT_NOW = "2026-10-26T09:00:00.000Z";
export const CONTEXT_ORIGIN = "https://context.example.test";
export const shareId = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export function createContextFixture(t, { withShares = true } = {}) {
  const tasks = createSqliteD1(t, { migrations: [
    "0001_create_tasks.sql", "0002_add_subtasks.sql", "0003_add_assistant_users_and_gmail.sql",
  ] });
  const context = createSqliteD1(t, { migrations: [] });
  const migrations = ["0001_create_chat_context.sql", ...(withShares ? ["0002_create_context_shares.sql"] : [])];
  for (const name of migrations) {
    context.sqlite.exec(readFileSync(new URL(`../cloudflare-worker/chat-migrations/${name}`, import.meta.url), "utf8"));
  }
  tasks.sqlite.exec("DELETE FROM assistant_users");
  for (const [owner, status, canTasks] of [
    [CONTEXT_OWNER, "active", 1], [CONTEXT_OTHER_OWNER, "active", 1],
    [CONTEXT_BLOCKED_OWNER, "blocked", 1], [CONTEXT_NO_TASKS_OWNER, "active", 0],
  ]) {
    tasks.sqlite.prepare(`INSERT INTO assistant_users
      (id,telegram_user_id,username,role,status,can_tasks,created_at,updated_at)
      VALUES (?,?,?,'user',?,?,?,?)`)
      .run(`fictional-context-${owner}`, owner, `fictional_context_${owner}`, status, canTasks, CONTEXT_NOW, CONTEXT_NOW);
  }
  const env = {
    TASKS_DB: tasks.db,
    CHAT_CONTEXT_DB: context.db,
    CHAT_CONTEXT_RETENTION_DAYS: "30",
    TELEGRAM_BOT_TOKEN: "820000:fictional-context-only-token",
    TELEGRAM_ADMIN_IDS: CONTEXT_ADMIN,
    TASKS_APP_URL: `${CONTEXT_ORIGIN}/tasks/`,
  };

  function seedConnection(owner = CONTEXT_OWNER) {
    const connectionId = `fictional-context-connection-${owner}`;
    context.sqlite.prepare(`INSERT OR IGNORE INTO business_connections
      (connection_id,owner_id,user_chat_id,is_enabled,connected_at,updated_at) VALUES (?,?,?,1,?,?)`)
      .run(connectionId, owner, owner, CONTEXT_NOW, CONTEXT_NOW);
    return connectionId;
  }
  function seedMessage({
    owner = CONTEXT_OWNER, chatId = CONTEXT_CHAT, messageId = 1,
    body = `Fictional message ${messageId}`, sentAt = CONTEXT_NOW, editedAt = null,
    direction = "incoming", title = `Fictional chat ${chatId}`, contentType = "text",
  } = {}) {
    const connectionId = seedConnection(owner);
    context.sqlite.prepare(`INSERT INTO chat_context_messages
      (connection_id,owner_id,chat_id,message_id,chat_type,chat_title,sender_id,sender_name,
       direction,content_type,body,sent_at,edited_at,created_at,updated_at)
      VALUES (?,?,?,?,'private',?,?,?, ?,?,?,?,?,?,?)`)
      .run(connectionId, owner, chatId, messageId, title, owner, "Fictional participant",
        direction, contentType, body, sentAt, editedAt, CONTEXT_NOW, CONTEXT_NOW);
    return { connectionId, owner, chatId, messageId, body, sentAt };
  }
  function request(path, { method = "GET", body, owner = CONTEXT_OWNER, initData, origin = CONTEXT_ORIGIN, headers = {} } = {}) {
    const auth = initData === null ? {} : { Authorization: `tma ${initData ?? signedInitData(env, owner)}` };
    return new Request(`${origin}/api/context${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  function publicRequest(url, options = {}) {
    return new Request(new URL(url, CONTEXT_ORIGIN), options);
  }
  return { env, db: context.db, sqlite: context.sqlite, tasksDb: tasks.db, tasksSqlite: tasks.sqlite,
    request, publicRequest, seedConnection, seedMessage };
}
