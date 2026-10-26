import { adminIdSet } from './access.js';
import { ACCOUNT_READABLE_SQL, accountVisibilityArgs, assertAccountChatReadable } from './account-visibility.js';

export const CONTEXT_SHARE_PREFIX = '/context-share/';
export const ACCOUNT_SHARE_PREFIX = '/account-context-share/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_SHARES = 20;

function failure(status, message) { const error = new Error(message); error.status = status; return error; }
function database(env, archive = false) {
  const db = archive ? env.ACCOUNT_CONTEXT_DB : env.CHAT_CONTEXT_DB;
  if (!db) throw failure(503, 'База контекста недоступна.');
  return db;
}

async function signingKey(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw failure(503, 'Сервис ссылок не настроен.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function signedData(row, archive = false) {
  return new TextEncoder().encode(JSON.stringify([archive ? 'account-context-share:v1' : 'context-share:v1', row.id, row.owner_id, row.chat_id, row.message_limit, row.ttl_hours, row.created_at, row.expires_at]));
}
function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decode(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
}
async function describeShare(env, row, key, archive = false) {
  const signature = encode(await crypto.subtle.sign('HMAC', key, signedData(row, archive)));
  const url = new URL(env.TASKS_APP_URL || 'https://gcodrevit-telegram-bot.demideilan531.workers.dev/tasks/');
  if (url.protocol !== 'https:' || url.username || url.password) throw failure(503, 'Адрес сервиса ссылок не настроен.');
  url.pathname = `${archive ? ACCOUNT_SHARE_PREFIX : CONTEXT_SHARE_PREFIX}${row.id}.${signature}`; url.search = ''; url.hash = '';
  return { id: row.id, chat_id: row.chat_id, url: url.toString(), message_limit: row.message_limit, created_at: row.created_at, expires_at: row.expires_at };
}

export async function readShareRequest(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure(415, 'Нужен JSON-запрос.');
  if (Number(request.headers.get('Content-Length')) > 2048) throw failure(413, 'Слишком большой запрос.');
  const reader = request.body?.getReader();
  if (!reader) throw failure(400, 'Укажи параметры ссылки.');
  const chunks = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2048) { await reader.cancel(); throw failure(413, 'Слишком большой запрос.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw failure(400, 'Некорректные параметры ссылки.'); }
}

export async function listContextShares(env, owner, chatId, { archive = false } = {}) {
  if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) throw failure(400, 'Выбери чат.');
  const key = await signingKey(env);
  const rows = (await database(env, archive).prepare(`SELECT * FROM context_shares
    WHERE owner_id=? AND chat_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 20`)
    .bind(String(owner), chatId, new Date().toISOString()).all()).results || [];
  return Promise.all(rows.map(row => describeShare(env, row, key, archive)));
}

export function validateContextShareInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, 'Укажи параметры ссылки.');
  const id = input.id === undefined ? crypto.randomUUID() : input.id;
  const chat = input.chat_id, limit = input.limit, ttl = input.ttl_hours === undefined ? 24 : input.ttl_hours;
  if (typeof id !== 'string' || !UUID.test(id) || typeof chat !== 'string' || !/^-?\d{1,20}$/.test(chat) ||
      !Number.isInteger(limit) || limit < 1 || limit > 200 || ![1, 24, 168].includes(ttl)) {
    throw failure(400, 'Проверь чат, количество сообщений и срок ссылки.');
  }
  return { id, chat_id: chat, limit, ttl_hours: ttl };
}

export async function createContextShare(env, ownerValue, input, { archive = false } = {}) {
  const owner = String(ownerValue);
  if (archive && (env.TELEGRAM_ACCOUNT_SYNC_ENABLED !== 'true' || owner !== env.TELEGRAM_ACCOUNT_OWNER_ID || !adminIdSet(env).has(owner))) throw failure(403, 'Архив доступен только владельцу аккаунта.');
  if (archive && input?.consent_confirmed !== true) throw failure(400, 'Подтверди согласие участников на передачу выбранного контекста.');
  const { id, chat_id: chat, limit, ttl_hours: ttl } = validateContextShareInput(input);
  const db = database(env, archive), now = new Date(), iso = now.toISOString(), key = await signingKey(env);
  if (archive) await assertAccountChatReadable(env, owner, chat);
  const existing = await db.prepare('SELECT * FROM context_shares WHERE id=?').bind(id).first();
  const matching = row => row?.owner_id === owner && row.chat_id === chat && row.message_limit === limit && row.ttl_hours === ttl && row.expires_at > iso;
  if (existing) {
    if (!matching(existing)) throw failure(409, 'Создай новую ссылку для выбранных параметров.');
    return describeShare(env, existing, key, archive);
  }
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  await db.prepare('DELETE FROM context_shares WHERE owner_id=? AND expires_at<?').bind(owner, cutoff).run();
  const expires = new Date(now.getTime() + ttl * 3600000).toISOString();
  const configuredDays = Number(env.CHAT_CONTEXT_RETENTION_DAYS || 30);
  const days = Number.isFinite(configuredDays) ? Math.min(90, Math.max(1, Math.round(configuredDays))) : 30;
  const messageCutoff = archive ? '1970-01-01T00:00:00.000Z' : new Date(now.getTime() - days * 86400000).toISOString();
  const messagesTable = archive ? 'account_context_messages' : 'chat_context_messages';
  // The scope existence check and active-link cap must commit with the insert.
  await db.prepare(`INSERT INTO context_shares (id,owner_id,chat_id,message_limit,ttl_hours,created_at,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM context_shares WHERE owner_id=? AND expires_at>?) < ?
      AND EXISTS (SELECT 1 FROM ${messagesTable} WHERE owner_id=? AND chat_id=? AND sent_at>=?)
      ${archive ? `AND ${ACCOUNT_READABLE_SQL}` : ''}
    ON CONFLICT(id) DO NOTHING`).bind(id, owner, chat, limit, ttl, iso, expires, owner, iso, MAX_ACTIVE_SHARES, owner, chat, messageCutoff, ...(archive ? accountVisibilityArgs(owner, chat) : [])).run();
  const row = await db.prepare('SELECT * FROM context_shares WHERE id=?').bind(id).first();
  if (!row) {
    if (archive) await assertAccountChatReadable(env, owner, chat);
    const message = await db.prepare(`SELECT 1 FROM ${messagesTable} WHERE owner_id=? AND chat_id=? AND sent_at>=? LIMIT 1`).bind(owner, chat, messageCutoff).first();
    if (!message) throw failure(404, 'В выбранном чате нет доступных сообщений.');
    throw failure(429, 'Уже есть 20 активных ссылок. Сначала отключи ненужные.');
  }
  if (!matching(row)) throw failure(409, 'Создай новую ссылку для выбранных параметров.');
  return describeShare(env, row, key, archive);
}

export async function revokeContextShare(env, owner, id, { archive = false } = {}) {
  if (!UUID.test(id)) throw failure(404, 'Ссылка не найдена.');
  const result = await database(env, archive).prepare('DELETE FROM context_shares WHERE id=? AND owner_id=?').bind(id, String(owner)).run();
  if (!result.meta?.changes) throw failure(404, 'Ссылка не найдена.');
}

async function ownerIsActive(env, owner) {
  if (adminIdSet(env).has(owner)) return true;
  if (!env.TASKS_DB) return false;
  const row = await env.TASKS_DB.prepare('SELECT status,can_tasks FROM assistant_users WHERE telegram_user_id=? LIMIT 1').bind(owner).first();
  return row?.status === 'active' && Number(row.can_tasks) === 1;
}

export async function readContextShare(env, token, { archive = false } = {}) {
  const parts = token.split('.');
  if (parts.length !== 2 || !UUID.test(parts[0]) || !SIGNATURE.test(parts[1])) return null;
  const row = await database(env, archive).prepare('SELECT * FROM context_shares WHERE id=?').bind(parts[0]).first();
  if (!row || row.expires_at <= new Date().toISOString()) return null;
  const key = await signingKey(env);
  const signature = decode(parts[1]);
  if (encode(signature) !== parts[1] || !await crypto.subtle.verify('HMAC', key, signature, signedData(row, archive))) return null;
  if (archive && (env.TELEGRAM_ACCOUNT_SYNC_ENABLED !== 'true' || row.owner_id !== env.TELEGRAM_ACCOUNT_OWNER_ID || !adminIdSet(env).has(row.owner_id))) return null;
  if (!await ownerIsActive(env, row.owner_id)) return null;
  return row;
}

export function sharedContextResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  } });
}
