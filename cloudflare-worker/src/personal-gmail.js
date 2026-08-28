const MAX_INTERNAL_BODY_BYTES = 16 * 1024;
const REQUEST_TTL_MINUTES = 20;
const FIRST_REPORT_LOOKBACK_HOURS = 2;

function db(env) {
  if (!env.TASKS_DB) throw new Error("TASKS_DB binding is not configured");
  return env.TASKS_DB;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(env) {
  const bytes = base64ToBytes(env.GMAIL_CREDENTIALS_KEY || "");
  if (bytes.byteLength !== 32) {
    throw new Error("GMAIL_CREDENTIALS_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptGmailPassword(env, ownerId, email, password) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(password);
  const additionalData = new TextEncoder().encode(`${ownerId}:${email.toLowerCase()}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    await encryptionKey(env),
    encoded,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptGmailPassword(env, account) {
  const additionalData = new TextEncoder().encode(
    `${account.owner_id}:${String(account.email).toLowerCase()}`,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(account.password_iv),
      additionalData,
    },
    await encryptionKey(env),
    base64ToBytes(account.password_ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function normalizeGmailAddress(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

export function normalizeGoogleAppPassword(value) {
  const password = String(value || "").replace(/\s+/g, "").trim();
  return /^[a-z0-9]{16}$/i.test(password) ? password : "";
}

async function session(ownerId, env) {
  return db(env)
    .prepare("SELECT mode, data_json FROM assistant_sessions WHERE owner_id = ?")
    .bind(String(ownerId))
    .first();
}

async function setSession(ownerId, mode, data, env) {
  await db(env)
    .prepare(
      `INSERT INTO assistant_sessions (owner_id, mode, data_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         mode = excluded.mode, data_json = excluded.data_json, updated_at = excluded.updated_at`,
    )
    .bind(String(ownerId), mode, JSON.stringify(data || {}), new Date().toISOString())
    .run();
}

async function clearSession(ownerId, env) {
  await db(env)
    .prepare("DELETE FROM assistant_sessions WHERE owner_id = ?")
    .bind(String(ownerId))
    .run();
}

export async function gmailAccount(ownerId, env) {
  return db(env)
    .prepare("SELECT * FROM gmail_accounts WHERE owner_id = ?")
    .bind(String(ownerId))
    .first();
}

async function createRequest(ownerId, chatId, kind, env) {
  const existing = await db(env)
    .prepare(
      `SELECT id FROM gmail_requests
       WHERE owner_id = ? AND status IN ('pending', 'claimed') AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(String(ownerId), new Date().toISOString())
    .first();
  if (existing) throw new Error("Предыдущая проверка почты ещё выполняется.");

  const account = await gmailAccount(ownerId, env);
  if (!account) throw new Error("Почта ещё не настроена.");
  const now = new Date();
  const fallback = new Date(now.getTime() - FIRST_REPORT_LOOKBACK_HOURS * 60 * 60 * 1000);
  const periodStart = kind === "report" ? account.last_checked_at || fallback.toISOString() : null;
  const id = crypto.randomUUID();
  await db(env)
    .prepare(
      `INSERT INTO gmail_requests (
         id, owner_id, chat_id, kind, status, period_start, checkpoint_at,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      String(ownerId),
      String(chatId),
      kind,
      periodStart,
      now.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + REQUEST_TTL_MINUTES * 60 * 1000).toISOString(),
    )
    .run();
  return id;
}

export async function failGmailDispatch(requestId, error, env) {
  await db(env)
    .prepare(
      `UPDATE gmail_requests
       SET status = 'failed', completed_at = ?, error = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(new Date().toISOString(), String(error || "dispatch failed").slice(0, 500), requestId)
    .run();
}

async function storeAccount(ownerId, email, encrypted, env) {
  const now = new Date().toISOString();
  await db(env)
    .prepare(
      `INSERT INTO gmail_accounts (
         owner_id, email, password_ciphertext, password_iv, status,
         state_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'verifying', '{"uids":[],"uidvalidity":null}', ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         email = excluded.email,
         password_ciphertext = excluded.password_ciphertext,
         password_iv = excluded.password_iv,
         status = 'verifying',
         state_json = '{"uids":[],"uidvalidity":null}',
         last_checked_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(String(ownerId), email, encrypted.ciphertext, encrypted.iv, now, now)
    .run();
}

export async function handlePersonalGmailUpdate(update, env, ctx, helpers) {
  const message = update.message;
  if (!message?.from?.id || !message?.chat?.id) return false;
  const { buttonText, dispatchWorkflow, sendMessage, telegramApi } = helpers;
  const ownerId = String(message.from.id);
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();

  if (text === "/gmail_cancel") {
    await clearSession(ownerId, env);
    await sendMessage(env, chatId, "Настройка почты отменена.");
    return true;
  }

  if (text === "/gmail_reset") {
    await clearSession(ownerId, env);
    await db(env).prepare("DELETE FROM gmail_accounts WHERE owner_id = ?").bind(ownerId).run();
    await sendMessage(env, chatId, "Подключение Gmail удалено. Нажми кнопку почты, чтобы настроить заново.");
    return true;
  }

  if (text === buttonText) {
    const account = await gmailAccount(ownerId, env);
    if (account?.status === "active") {
      try {
        const requestId = await createRequest(ownerId, chatId, "report", env);
        await sendMessage(env, chatId, "Собираю письма с момента предыдущей успешной проверки.");
        ctx.waitUntil(
          dispatchWorkflow(requestId).catch(async (error) => {
            await failGmailDispatch(requestId, error.message, env);
            await sendMessage(env, chatId, `Не удалось запустить анализ почты: ${error.message}`);
          }),
        );
      } catch (error) {
        await sendMessage(env, chatId, error.message);
      }
      return true;
    }
    await setSession(ownerId, "gmail_email", {}, env);
    await sendMessage(
      env,
      chatId,
      "Отправь адрес Gmail или Google Workspace. Затем бот попросит отдельный 16-значный пароль приложения Google. Обычный пароль от аккаунта присылать нельзя. Для отмены: /gmail_cancel",
    );
    return true;
  }

  const current = await session(ownerId, env);
  if (!current) return false;
  if (message.chat.type !== "private") {
    await sendMessage(env, chatId, "Настройка почты доступна только в личном чате с ботом.", false);
    return true;
  }

  if (current.mode === "gmail_email") {
    const email = normalizeGmailAddress(text);
    if (!email) {
      await sendMessage(env, chatId, "Не похоже на адрес почты. Пришли адрес вида name@gmail.com.");
      return true;
    }
    await setSession(ownerId, "gmail_password", { email }, env);
    await sendMessage(
      env,
      chatId,
      "Теперь отправь 16-значный пароль приложения Google. Сообщение будет сразу удалено. Не отправляй основной пароль Google.",
    );
    return true;
  }

  let data = {};
  try {
    data = JSON.parse(current.data_json || "{}");
  } catch {
    data = {};
  }
  const email = normalizeGmailAddress(data.email);
  try {
    if (message.message_id) {
      await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id });
    }
  } catch (error) {
    console.error("Could not delete Gmail credential message", error);
  }
  const password = normalizeGoogleAppPassword(text);
  if (!email || !password) {
    await sendMessage(
      env,
      chatId,
      "Нужен именно 16-значный пароль приложения Google. Создай его в настройках безопасности Google и пришли ещё раз.",
    );
    return true;
  }

  try {
    const encrypted = await encryptGmailPassword(env, ownerId, email, password);
    await storeAccount(ownerId, email, encrypted, env);
    await clearSession(ownerId, env);
    const requestId = await createRequest(ownerId, chatId, "validate", env);
    await sendMessage(env, chatId, "Проверяю подключение к Gmail…");
    ctx.waitUntil(
      dispatchWorkflow(requestId).catch(async (error) => {
        await failGmailDispatch(requestId, error.message, env);
        await sendMessage(env, chatId, `Не удалось проверить Gmail: ${error.message}`);
      }),
    );
  } catch (error) {
    console.error("Gmail setup failed", error);
    await sendMessage(env, chatId, "Не удалось безопасно сохранить подключение Gmail.");
  }
  return true;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function brokerAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.GMAIL_BROKER_TOKEN || ""}`;
  return Boolean(env.GMAIL_BROKER_TOKEN) && constantTimeEqual(authorization, expected);
}

async function internalJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_INTERNAL_BODY_BYTES) throw new Error("Request is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) {
    throw new Error("Request is too large");
  }
  return JSON.parse(text || "{}");
}

function internalResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function claimRequest(request, env) {
  const body = await internalJson(request);
  const requestId = String(body.request_id || "");
  const row = await db(env)
    .prepare(
      `SELECT r.*, a.email, a.password_ciphertext, a.password_iv, a.state_json
       FROM gmail_requests r
       JOIN gmail_accounts a ON a.owner_id = r.owner_id
       WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > ?`,
    )
    .bind(requestId, new Date().toISOString())
    .first();
  if (!row) return internalResponse({ error: "Request is unavailable" }, 404);
  const result = await db(env)
    .prepare(
      `UPDATE gmail_requests SET status = 'claimed', claimed_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(new Date().toISOString(), requestId)
    .run();
  if (!result.meta?.changes) return internalResponse({ error: "Request was already claimed" }, 409);
  const password = await decryptGmailPassword(env, row);
  let gmailState = { uids: [], uidvalidity: null };
  try {
    gmailState = JSON.parse(row.state_json || "{}");
  } catch {
    // A fresh state is safer than returning malformed persisted data.
  }
  return internalResponse({
    request_id: row.id,
    kind: row.kind,
    email: row.email,
    app_password: password,
    chat_id: row.chat_id,
    since_utc: row.period_start,
    checkpoint_at: row.checkpoint_at,
    state: gmailState,
  });
}

async function completeRequest(request, env, telegramApi) {
  const body = await internalJson(request);
  const requestId = String(body.request_id || "");
  const row = await db(env)
    .prepare("SELECT * FROM gmail_requests WHERE id = ? AND status = 'claimed'")
    .bind(requestId)
    .first();
  if (!row) return internalResponse({ error: "Request is unavailable" }, 404);

  const success = body.success === true;
  const now = new Date().toISOString();
  const error = String(body.error || "").slice(0, 500);
  if (success && row.kind === "validate") {
    await db(env)
      .prepare(
        `UPDATE gmail_accounts
         SET status = 'active', last_error = NULL, updated_at = ?
         WHERE owner_id = ?`,
      )
      .bind(now, row.owner_id)
      .run();
  } else if (success && row.kind === "report") {
    const stateJson = JSON.stringify(body.state || { uids: [], uidvalidity: null }).slice(0, 64000);
    await db(env)
      .prepare(
        `UPDATE gmail_accounts
         SET status = 'active', state_json = ?, last_checked_at = ?,
             last_error = NULL, updated_at = ?
         WHERE owner_id = ?`,
      )
      .bind(stateJson, row.checkpoint_at, now, row.owner_id)
      .run();
  } else {
    await db(env)
      .prepare(
        `UPDATE gmail_accounts
         SET status = CASE WHEN ? = 'validate' THEN 'error' ELSE status END,
             last_error = ?, updated_at = ?
         WHERE owner_id = ?`,
      )
      .bind(row.kind, error || "Gmail job failed", now, row.owner_id)
      .run();
  }
  await db(env)
    .prepare(
      `UPDATE gmail_requests
       SET status = ?, completed_at = ?, error = ?
       WHERE id = ?`,
    )
    .bind(success ? "completed" : "failed", now, error || null, requestId)
    .run();

  const text = success
    ? row.kind === "validate"
      ? "✅ Почта настроена, готов к анализу."
      : "✅ Отчёт по почте отправлен."
    : row.kind === "validate"
      ? "❌ Google не принял подключение. Проверь адрес и пароль приложения, затем нажми /gmail_reset."
      : "❌ Не удалось собрать отчёт Gmail. Период проверки не сброшен, попробуй ещё раз.";
  await telegramApi(env, "sendMessage", { chat_id: row.chat_id, text });
  return internalResponse({ ok: true });
}

export async function handleGmailBrokerApi(request, env, helpers) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/gmail/")) return null;
  if (request.method !== "POST") return internalResponse({ error: "Method not allowed" }, 405);
  if (!brokerAuthorized(request, env)) return internalResponse({ error: "Forbidden" }, 403);
  try {
    if (url.pathname === "/internal/gmail/claim") return await claimRequest(request, env);
    if (url.pathname === "/internal/gmail/complete") {
      return await completeRequest(request, env, helpers.telegramApi);
    }
    return internalResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Gmail broker error", error);
    return internalResponse({ error: "Broker request failed" }, 500);
  }
}
