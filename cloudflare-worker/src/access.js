const DEFAULT_ADMIN_ID = "1839693017";

function db(env) {
  if (!env.TASKS_DB) throw new Error("TASKS_DB binding is not configured");
  return env.TASKS_DB;
}

export function adminIdSet(env) {
  return new Set(
    String(env.TELEGRAM_ADMIN_IDS || DEFAULT_ADMIN_ID)
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(String),
  );
}

export function normalizeTelegramUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{5,32}$/.test(username) ? username : "";
}

function accessFromRow(row) {
  if (!row) return null;
  return {
    role: row.role === "admin" ? "admin" : "user",
    status: row.status,
    canTasks: Number(row.can_tasks) === 1,
    canWeather: Number(row.can_weather) === 1,
    canGmail: Number(row.can_gmail) === 1,
    username: row.username || "",
    userId: row.telegram_user_id || "",
  };
}

export async function getAssistantAccess(env, actor) {
  const userId = String(actor?.id || "");
  if (!userId) return null;
  if (adminIdSet(env).has(userId)) {
    return {
      role: "admin",
      status: "active",
      canTasks: true,
      canWeather: true,
      canGmail: true,
      username: normalizeTelegramUsername(actor?.username),
      userId,
    };
  }

  let row = await db(env)
    .prepare("SELECT * FROM assistant_users WHERE telegram_user_id = ? LIMIT 1")
    .bind(userId)
    .first();

  const username = normalizeTelegramUsername(actor?.username);
  if (!row && username) {
    const now = new Date().toISOString();
    await db(env)
      .prepare(
        `UPDATE assistant_users
         SET telegram_user_id = ?, status = 'active', updated_at = ?, last_seen_at = ?
         WHERE username = ? AND telegram_user_id IS NULL AND status = 'pending'`,
      )
      .bind(userId, now, now, username)
      .run();
    row = await db(env)
      .prepare("SELECT * FROM assistant_users WHERE telegram_user_id = ? LIMIT 1")
      .bind(userId)
      .first();
  }

  if (!row || row.status !== "active") return null;
  const now = new Date().toISOString();
  await db(env)
    .prepare(
      `UPDATE assistant_users
       SET username = COALESCE(?, username), last_seen_at = ?, updated_at = ?
       WHERE telegram_user_id = ?`,
    )
    .bind(username || null, now, now, userId)
    .run();
  return accessFromRow({ ...row, username: username || row.username });
}

export async function allowAssistantUser(env, value) {
  const username = normalizeTelegramUsername(value);
  if (!username) {
    throw new Error("Укажи Telegram username в формате @username.");
  }
  const now = new Date().toISOString();
  await db(env)
    .prepare(
      `INSERT INTO assistant_users (
         id, telegram_user_id, username, role, status,
         can_tasks, can_weather, can_gmail, created_at, updated_at
       ) VALUES (?, NULL, ?, 'user', 'pending', 1, 1, 1, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         role = 'user',
         status = CASE
           WHEN assistant_users.telegram_user_id IS NULL THEN 'pending'
           ELSE 'active'
         END,
         can_tasks = 1,
         can_weather = 1,
         can_gmail = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), username, now, now)
    .run();
  return username;
}

export async function blockAssistantUser(env, value) {
  const username = normalizeTelegramUsername(value);
  if (!username) throw new Error("Укажи Telegram username в формате @username.");
  const result = await db(env)
    .prepare("UPDATE assistant_users SET status = 'blocked', updated_at = ? WHERE username = ?")
    .bind(new Date().toISOString(), username)
    .run();
  if (!result.meta?.changes) throw new Error(`Пользователь @${username} не найден.`);
  return username;
}

export async function listAssistantUsers(env) {
  const result = await db(env)
    .prepare(
      `SELECT username, telegram_user_id, status, last_seen_at
       FROM assistant_users
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, username
       LIMIT 100`,
    )
    .all();
  return result.results || [];
}

