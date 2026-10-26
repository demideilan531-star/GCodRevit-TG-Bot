import { adminIdSet } from './access.js';
import { verifyContextJob } from './github-oidc.js';
import { ACCOUNT_READABLE_SQL, accountVisibilityArgs, assertAccountChatReadable } from './account-visibility.js';
import { ACCOUNT_SHARE_PREFIX, createContextShare, listContextShares, readContextShare, readShareRequest, revokeContextShare, sharedContextResponse } from './context-shares.js';

const INTERNAL = '/internal/account-context/';
const PRIVATE = '/api/context/account/';
const ID = /^-?\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = ['private', 'bot', 'group', 'supergroup', 'channel', 'saved'];
const HISTORY = ['pending', 'loading', 'complete', 'unavailable', 'paused'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
const nowIso = () => new Date().toISOString();

export function accountContextOwner(env) {
  const owner = String(env.TELEGRAM_ACCOUNT_OWNER_ID || '');
  return /^\d{1,20}$/.test(owner) && adminIdSet(env).has(owner) ? owner : null;
}
function configured(env) { return env.TELEGRAM_ACCOUNT_SYNC_ENABLED === 'true' && env.ACCOUNT_CONTEXT_DB && accountContextOwner(env); }
function database(env) {
  if (!configured(env)) throw fail(503, 'Подключение аккаунта ещё не настроено.');
  return env.ACCOUNT_CONTEXT_DB;
}
function budget(env) { return Math.min(70000, Math.max(1000, Number(env.TELEGRAM_ACCOUNT_DAILY_WRITE_BUDGET) || 45000)); }
function remaining(row, env, now = nowIso()) { return Math.max(0, budget(env) - (row.quota_day === now.slice(0, 10) ? row.quota_used : 0)); }
function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, 'Некорректные поля запроса.');
  return value;
}
function text(value, max, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw fail(400, 'Некорректное текстовое поле.');
  return value;
}
function chatId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail(400, 'Некорректный чат.');
  const numeric = BigInt(value);
  if (numeric === 0n || numeric.toString() !== value || numeric < -9223372036854775808n || numeric > 9223372036854775807n) throw fail(400, 'Некорректный чат.');
  return value;
}
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min || value > 2147483647) throw fail(400, 'Некорректный идентификатор сообщения.'); return value; }
function date(value, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > 32 || !/^\d{4}-\d\d-\d\dT/.test(value)) throw fail(400, 'Некорректная дата.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < 0 || time > Date.now() + 300000) throw fail(400, 'Некорректная дата.');
  return new Date(time).toISOString();
}
function boolean(value) { if (typeof value !== 'boolean') throw fail(400, 'Некорректный флаг.'); return value; }
function structured(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Некорректное состояние загрузки.');
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).length > 16384 || /"[^"]*(?:session|auth_key|api_hash|api_id|password|phone|token|secret)[^"]*"\s*:/i.test(result)) throw fail(400, 'Некорректное состояние загрузки.');
  return result;
}

async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'Нужен JSON.');
  if (Number(request.headers.get('Content-Length')) > 1048576) throw fail(413, 'Слишком большой запрос.');
  const reader = request.body?.getReader();
  if (!reader) throw fail(400, 'Нужен JSON.');
  const chunks = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 1048576) { await reader.cancel(); throw fail(413, 'Слишком большой запрос.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail(400, 'Некорректный JSON.'); }
  return { value, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') };
}

function normalizeBatch(input) {
  record(input, ['lease_id', 'generation', 'batch_id', 'dialogs', 'messages', 'deleted', 'global_deleted', 'checkpoints', 'state']);
  if (!UUID.test(input.batch_id)) throw fail(400, 'Некорректный ID порции.');
  const groups = ['dialogs', 'messages', 'deleted', 'global_deleted', 'checkpoints'];
  for (const name of groups) if (input[name] !== undefined && (!Array.isArray(input[name]) || input[name].length > 100)) throw fail(400, 'Слишком много записей.');
  if (groups.reduce((sum, name) => sum + (input[name]?.length || 0), 0) > 200) throw fail(400, 'Слишком много записей.');
  const dialogs = (input.dialogs || []).map(row => {
    record(row, ['chat_id', 'chat_type', 'chat_title', 'archived', 'top_message_id', 'last_message_at']);
    if (!TYPES.includes(row.chat_type)) throw fail(400, 'Некорректный тип чата.');
    const id = chatId(row.chat_id), numeric = BigInt(id);
    if (['private', 'bot', 'saved'].includes(row.chat_type) ? numeric < 0n : row.chat_type === 'group' ? numeric >= 0n || numeric <= -1000000000000n : numeric > -1000000000000n) throw fail(400, 'Тип чата не соответствует его идентификатору.');
    return { chat_id: id, chat_type: row.chat_type, chat_title: text(row.chat_title, 180), archived: boolean(row.archived) ? 1 : 0, top_message_id: integer(row.top_message_id), last_message_at: date(row.last_message_at, true) };
  });
  const messages = (input.messages || []).map(row => {
    record(row, ['chat_id', 'message_id', 'sender_name', 'direction', 'content_type', 'body', 'sent_at', 'edited_at']);
    if (!['incoming', 'outgoing'].includes(row.direction)) throw fail(400, 'Некорректное направление.');
    return { chat_id: chatId(row.chat_id), message_id: integer(row.message_id, 1), sender_name: text(row.sender_name, 120), direction: row.direction, content_type: text(row.content_type, 32), body: text(row.body, 6000), sent_at: date(row.sent_at), edited_at: date(row.edited_at, true) };
  });
  const deleted = (input.deleted || []).map(row => { record(row, ['chat_id', 'message_id']); return { chat_id: chatId(row.chat_id), message_id: integer(row.message_id, 1) }; });
  const globalDeleted = (input.global_deleted || []).map(id => integer(id, 1));
  if (new Set(globalDeleted).size !== globalDeleted.length) throw fail(400, 'Дубли удалений.');
  const checkpoints = (input.checkpoints || []).map(row => {
    record(row, ['chat_id', 'latest_synced_id', 'history_before_id', 'history_complete', 'history_status', 'channel_pts']);
    const result = { chat_id: chatId(row.chat_id) };
    if (row.latest_synced_id !== undefined) result.latest_synced_id = integer(row.latest_synced_id);
    if (row.history_before_id !== undefined) result.history_before_id = row.history_before_id === null ? null : integer(row.history_before_id, 1);
    if (row.channel_pts !== undefined) result.channel_pts = row.channel_pts === null ? null : integer(row.channel_pts);
    if (row.history_complete !== undefined) result.history_complete = boolean(row.history_complete);
    if (row.history_status !== undefined) { if (!HISTORY.includes(row.history_status)) throw fail(400, 'Некорректный статус истории.'); result.history_status = row.history_status; }
    if (result.history_status === 'complete' && result.history_complete !== true) throw fail(400, 'Завершение истории нужно подтвердить явно.');
    return result;
  });
  for (const [rows, key] of [[dialogs, row => row.chat_id], [messages, row => `${row.chat_id}:${row.message_id}`], [deleted, row => `${row.chat_id}:${row.message_id}`], [checkpoints, row => row.chat_id]]) {
    if (new Set(rows.map(key)).size !== rows.length) throw fail(400, 'Дубли записей в одной порции.');
  }
  if (messages.some(row => deleted.some(item => item.chat_id === row.chat_id && item.message_id === row.message_id))) throw fail(400, 'Запись одновременно изменена и удалена.');
  const state = {};
  if (input.state !== undefined) {
    record(input.state, ['dialogs_complete', 'dialog_cursor', 'update_state']);
    if (input.state.dialogs_complete !== undefined) state.dialogs_complete = boolean(input.state.dialogs_complete);
    if (input.state.dialog_cursor !== undefined) state.dialog_cursor_json = structured(input.state.dialog_cursor === null ? {} : input.state.dialog_cursor);
    if (input.state.update_state !== undefined) state.update_state_json = structured(input.state.update_state);
  }
  return { dialogs, messages, deleted, globalDeleted, checkpoints, state };
}

async function control(env) {
  const db = database(env), owner = accountContextOwner(env), now = nowIso();
  await db.prepare(`INSERT OR IGNORE INTO account_context_sync (owner_id,quota_day,updated_at) VALUES (?,?,?)`).bind(owner, now.slice(0, 10), now).run();
  return db.prepare('SELECT * FROM account_context_sync WHERE owner_id=?').bind(owner).first();
}
function requireLease(row, input, job, now = nowIso()) {
  if (!row || row.enabled !== 1 || !UUID.test(input.lease_id) || input.lease_id !== row.lease_id || input.generation !== row.generation || row.lease_run !== job.run || !row.lease_until || row.lease_until <= now) throw fail(409, 'Задание остановлено или срок доступа истёк.');
}
async function claim(env, job) {
  const db = database(env), owner = accountContextOwner(env), row = await control(env), now = nowIso();
  if (row.enabled !== 1 || !row.owner_confirmed_at) throw fail(409, 'Синхронизация выключена владельцем.');
  if (row.reconciliation_json || JSON.parse(row.update_state_json || '{}').reconciliation_required) throw fail(409, 'Нужна проверка полноты синхронизации.');
  if (row.retry_after_at && row.retry_after_at > now) throw fail(409, 'Telegram запросил паузу.');
  if (row.lease_until > now && row.lease_run !== job.run) throw fail(409, 'Другое задание ещё работает.');
  const lease = row.lease_until > now && row.lease_run === job.run ? row.lease_id : crypto.randomUUID();
  const until = lease === row.lease_id ? row.lease_until : new Date(Date.now() + 600000).toISOString();
  const active = await db.prepare(`UPDATE account_context_sync SET
    lease_id=CASE WHEN lease_run=? AND lease_until>MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN lease_id ELSE ? END,
    lease_until=CASE WHEN lease_run=? AND lease_until>MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN lease_until ELSE ? END,
    lease_run=?,status='syncing',updated_at=? WHERE owner_id=? AND enabled=1 AND generation=?
      AND (lease_until IS NULL OR lease_until<=? OR lease_run=?) AND (retry_after_at IS NULL OR retry_after_at<=?)
      AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING *`)
    .bind(job.run, now, lease, job.run, now, until, job.run, now, owner, row.generation, now, job.run, now, until).first();
  if (!active) throw fail(409, 'Не удалось получить доступ к синхронизации.');
  return { owner_id: owner, generation: active.generation, lease_id: active.lease_id, lease_until: active.lease_until, quota_remaining: remaining(active, env), dialogs_complete: Boolean(active.dialogs_complete), dialog_cursor: JSON.parse(active.dialog_cursor_json), update_state: JSON.parse(active.update_state_json) };
}

async function readState(env, input, job) {
  record(input, ['lease_id', 'generation', 'after_chat_id']);
  const row = await control(env); requireLease(row, input, job);
  const after = input.after_chat_id === undefined ? '' : chatId(input.after_chat_id);
  const rows = (await database(env).prepare(`SELECT chat_id,chat_type,top_message_id,latest_synced_id,history_before_id,history_complete,history_status,channel_pts,deleted_before_id
    FROM account_context_chats WHERE owner_id=? AND chat_id>? ORDER BY chat_id LIMIT 201`).bind(row.owner_id, after).all()).results || [];
  return { chats: rows.slice(0, 200), next_chat_id: rows.length > 200 ? rows[199].chat_id : null };
}

async function mirrorDeletions(env, owner, data) {
  if (!env.CHAT_CONTEXT_DB) return [];
  const statements = [];
  if (data.globalDeleted.length) statements.push(env.CHAT_CONTEXT_DB.prepare(`DELETE FROM chat_context_messages
    WHERE owner_id=? AND message_id IN (SELECT value FROM json_each(?)) AND chat_type IN ('private','bot','group','saved')`).bind(owner, JSON.stringify(data.globalDeleted)));
  for (const item of data.deleted) statements.push(env.CHAT_CONTEXT_DB.prepare('DELETE FROM chat_context_messages WHERE owner_id=? AND chat_id=? AND message_id=?').bind(owner, item.chat_id, item.message_id));
  return statements.length ? env.CHAT_CONTEXT_DB.batch(statements) : [];
}

function knownWrites(results) {
  return results.every(result => Number.isFinite(result.meta?.rows_written))
    ? results.reduce((sum, result) => sum + result.meta.rows_written, 0) : null;
}

async function completeReceipt(env, owner, receipt, data, archiveResults = null) {
  const db = database(env);
  const observedArchive = archiveResults ? knownWrites(archiveResults) : null;
  if (receipt.actual_rows_written != null && (observedArchive === null || observedArchive <= (receipt.archive_rows_written || 0))) return;
  if (observedArchive !== null) {
    await db.prepare('UPDATE account_context_batches SET archive_rows_written=MAX(COALESCE(archive_rows_written,0),?) WHERE owner_id=? AND batch_id=?')
      .bind(observedArchive, owner, receipt.batch_id).run();
  }
  receipt = await db.prepare('SELECT * FROM account_context_batches WHERE owner_id=? AND batch_id=?').bind(owner, receipt.batch_id).first();
  const mirrorRows = receipt.actual_rows_written == null ? knownWrites(await mirrorDeletions(env, owner, data)) || 0 : 0;
  const day = nowIso().slice(0, 10);
  const sameDay = receipt.created_at.slice(0, 10) === day;
  const target = sameDay
    ? 'MAX(quota_cost,COALESCE(archive_rows_written,quota_cost)+MAX(COALESCE(mirror_rows_written,0),?))'
    : 'MAX(CASE WHEN quota_charged_day=? THEN COALESCE(quota_charged,0) ELSE 0 END,?)';
  const targetArgs = sameDay ? [mirrorRows] : [day, mirrorRows];
  const previous = 'CASE WHEN COALESCE(quota_charged_day,substr(created_at,1,10))=? THEN COALESCE(quota_charged,quota_cost) ELSE 0 END';
  // Delayed mirror responses can arrive after a zero-change retry; only charge the monotonic increase.
  await db.batch([
    db.prepare(`UPDATE account_context_sync SET quota_used=(CASE WHEN quota_day=? THEN quota_used ELSE 0 END)+
      (SELECT MAX(0,${target}-(${previous})) FROM account_context_batches WHERE owner_id=? AND batch_id=?),quota_day=? WHERE owner_id=?`)
      .bind(day, ...targetArgs, day, owner, receipt.batch_id, day, owner),
    db.prepare(`UPDATE account_context_batches SET actual_rows_written=COALESCE(archive_rows_written,0)+MAX(COALESCE(mirror_rows_written,0),?),
      mirror_rows_written=MAX(COALESCE(mirror_rows_written,0),?),quota_charged=${target},quota_charged_day=? WHERE owner_id=? AND batch_id=?`)
      .bind(mirrorRows, mirrorRows, ...targetArgs, day, owner, receipt.batch_id),
  ]);
}

async function applyBatch(env, input, bodyHash, job) {
  const data = normalizeBatch(input), db = database(env), row = await control(env), now = nowIso(), owner = row.owner_id;
  requireLease(row, input, job, now);
  const receipt = await db.prepare('SELECT * FROM account_context_batches WHERE owner_id=? AND batch_id=?').bind(owner, input.batch_id).first();
  if (receipt) {
    if (receipt.body_hash !== bodyHash || receipt.lease_id !== input.lease_id || receipt.generation !== input.generation) throw fail(409, 'ID порции уже использован.');
    if (receipt.applied === 1) {
      await completeReceipt(env, owner, receipt, data);
      const current = await db.prepare('SELECT * FROM account_context_sync WHERE owner_id=?').bind(owner).first();
      return { ok: true, batch_id: input.batch_id, quota_remaining: remaining(current, env) };
    }
  }
  const stored = (await db.prepare('SELECT * FROM account_context_chats WHERE owner_id=? AND chat_id IN (SELECT value FROM json_each(?))').bind(owner, JSON.stringify([...new Set([...data.messages, ...data.deleted, ...data.checkpoints].map(item => item.chat_id))])).all()).results || [];
  const known = new Map(stored.map(item => [item.chat_id, item]));
  for (const dialog of data.dialogs) if (!known.has(dialog.chat_id)) known.set(dialog.chat_id, { latest_synced_id: 0, history_before_id: null });
  for (const item of [...data.messages, ...data.deleted, ...data.checkpoints]) if (!known.has(item.chat_id)) throw fail(400, 'Сначала добавь метаданные чата.');
  for (const checkpoint of data.checkpoints) {
    const previous = known.get(checkpoint.chat_id), ids = data.messages.filter(item => item.chat_id === checkpoint.chat_id).map(item => item.message_id);
    if (checkpoint.latest_synced_id > Math.max(previous.latest_synced_id || 0, ...ids)) throw fail(400, 'Курсор опережает записанные сообщения.');
    if (checkpoint.history_before_id != null && checkpoint.history_before_id !== previous.history_before_id && (!ids.length || checkpoint.history_before_id !== Math.min(...ids) || (previous.history_before_id !== null && checkpoint.history_before_id > previous.history_before_id))) throw fail(400, 'Некорректный курсор старой истории.');
    if (checkpoint.history_before_id === null && previous.history_before_id !== null && checkpoint.history_complete !== true) throw fail(400, 'Нельзя потерять курсор истории.');
  }
  const sizeProbe = await db.prepare('SELECT owner_id FROM account_context_sync WHERE owner_id=?').bind(owner).all();
  const watermark = Math.min(450000000, Math.max(1000000, Number(env.TELEGRAM_ACCOUNT_STORAGE_WATERMARK_BYTES) || 400000000));
  if (Number(sizeProbe.meta?.size_after || 0) >= watermark) throw fail(507, 'Архив достиг безопасного лимита хранилища.');
  const globalMatches = data.globalDeleted.length ? await db.prepare(`SELECT COUNT(*) AS count FROM account_context_messages m JOIN account_context_chats c ON c.owner_id=m.owner_id AND c.chat_id=m.chat_id
    WHERE m.owner_id=? AND m.message_id IN (SELECT value FROM json_each(?)) AND c.chat_type IN ('private','bot','group','saved')`).bind(owner, JSON.stringify(data.globalDeleted)).first() : { count: 0 };
  const cost = data.messages.length * 12 + data.dialogs.length * 8 + data.deleted.length * 12 + data.globalDeleted.length * 12 + Number(globalMatches.count) * 6 + data.checkpoints.length * 4 + 64;
  if (cost > remaining(row, env, now)) throw fail(429, 'Достигнут дневной бюджет загрузки.');
  const guard = `EXISTS (SELECT 1 FROM account_context_batches b JOIN account_context_sync s ON s.owner_id=b.owner_id
    WHERE b.owner_id=? AND b.batch_id=? AND b.body_hash=? AND b.lease_id=? AND b.generation=? AND b.applied=0
    AND s.enabled=1 AND s.generation=b.generation AND s.lease_id=b.lease_id AND s.lease_run=? AND s.lease_until>?)`;
  const args = [owner, input.batch_id, bodyHash, input.lease_id, input.generation, job.run, now];
  const statements = [db.prepare(`INSERT OR IGNORE INTO account_context_batches (owner_id,batch_id,lease_id,generation,body_hash,quota_cost,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_context_sync WHERE owner_id=? AND enabled=1 AND generation=? AND lease_id=? AND lease_run=? AND lease_until>?
      AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND state_revision=?
      AND (CASE WHEN quota_day=? THEN quota_used ELSE 0 END)+?<=?)`).bind(owner, input.batch_id, input.lease_id, input.generation, bodyHash, cost, now, owner, input.generation, input.lease_id, job.run, now, row.state_revision, now.slice(0, 10), cost, budget(env)),
    db.prepare(`UPDATE account_context_sync SET quota_day=?,quota_used=(CASE WHEN quota_day=? THEN quota_used ELSE 0 END)+?,updated_at=? WHERE owner_id=? AND ${guard}`).bind(now.slice(0, 10), now.slice(0, 10), cost, now, owner, ...args)];
  for (const item of data.dialogs) statements.push(db.prepare(`INSERT INTO account_context_chats (owner_id,chat_id,chat_type,chat_title,chat_title_search,archived,top_message_id,last_message_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,chat_id) DO UPDATE SET chat_type=excluded.chat_type,chat_title=excluded.chat_title,chat_title_search=excluded.chat_title_search,archived=excluded.archived,
      top_message_id=MAX(account_context_chats.top_message_id,excluded.top_message_id),last_message_at=NULLIF(MAX(COALESCE(account_context_chats.last_message_at,''),COALESCE(excluded.last_message_at,'')),''),updated_at=excluded.updated_at
    WHERE account_context_chats.chat_title<>excluded.chat_title OR account_context_chats.chat_type<>excluded.chat_type OR account_context_chats.archived<>excluded.archived OR account_context_chats.top_message_id<excluded.top_message_id`)
    .bind(owner, item.chat_id, item.chat_type, item.chat_title, item.chat_title.normalize('NFKC').toLowerCase(), item.archived, item.top_message_id, item.last_message_at, now, ...args));
  for (const item of data.deleted) {
    statements.push(db.prepare(`UPDATE account_context_chats SET stored_count=MAX(0,stored_count-(SELECT COUNT(*) FROM account_context_messages WHERE owner_id=? AND chat_id=? AND message_id=?)) WHERE owner_id=? AND chat_id=? AND ${guard}`).bind(owner, item.chat_id, item.message_id, owner, item.chat_id, ...args));
    statements.push(db.prepare(`INSERT OR IGNORE INTO account_context_deleted_messages (owner_id,chat_id,message_id,deleted_at) SELECT ?,?,?,? WHERE ${guard}`).bind(owner, item.chat_id, item.message_id, now, ...args));
    statements.push(db.prepare(`DELETE FROM account_context_messages WHERE owner_id=? AND chat_id=? AND message_id=? AND ${guard}`).bind(owner, item.chat_id, item.message_id, ...args));
  }
  if (data.globalDeleted.length) {
    const ids = JSON.stringify(data.globalDeleted);
    statements.push(db.prepare(`UPDATE account_context_chats SET stored_count=MAX(0,stored_count-(SELECT COUNT(*) FROM account_context_messages m WHERE m.owner_id=account_context_chats.owner_id AND m.chat_id=account_context_chats.chat_id AND m.message_id IN (SELECT value FROM json_each(?))))
      WHERE owner_id=? AND chat_type IN ('private','bot','group','saved') AND EXISTS (SELECT 1 FROM account_context_messages m WHERE m.owner_id=account_context_chats.owner_id AND m.chat_id=account_context_chats.chat_id AND m.message_id IN (SELECT value FROM json_each(?))) AND ${guard}`).bind(ids, owner, ids, ...args));
    for (const id of data.globalDeleted) statements.push(db.prepare(`INSERT OR IGNORE INTO account_context_deleted_global (owner_id,message_id,deleted_at) SELECT ?,?,? WHERE ${guard}`).bind(owner, id, now, ...args));
    statements.push(db.prepare(`DELETE FROM account_context_messages WHERE owner_id=? AND message_id IN (SELECT value FROM json_each(?))
      AND chat_id IN (SELECT chat_id FROM account_context_chats WHERE owner_id=? AND chat_type IN ('private','bot','group','saved')) AND ${guard}`).bind(owner, ids, owner, ...args));
  }
  const messageGroups = new Map();
  for (const message of data.messages) { if (!messageGroups.has(message.chat_id)) messageGroups.set(message.chat_id, []); messageGroups.get(message.chat_id).push(message.message_id); }
  for (const [chat, ids] of messageGroups) statements.push(db.prepare(`UPDATE account_context_chats SET stored_count=stored_count+(
    SELECT COUNT(*) FROM json_each(?) j WHERE CAST(j.value AS INTEGER)>account_context_chats.deleted_before_id
      AND NOT EXISTS (SELECT 1 FROM account_context_messages m WHERE m.owner_id=? AND m.chat_id=? AND m.message_id=j.value)
      AND NOT EXISTS (SELECT 1 FROM account_context_deleted_messages d WHERE d.owner_id=? AND d.chat_id=? AND d.message_id=j.value)
      AND (account_context_chats.chat_type IN ('channel','supergroup') OR NOT EXISTS (SELECT 1 FROM account_context_deleted_global g WHERE g.owner_id=account_context_chats.owner_id AND g.message_id=j.value)))
    WHERE owner_id=? AND chat_id=? AND ${guard}`).bind(JSON.stringify(ids), owner, chat, owner, chat, owner, chat, ...args));
  for (const item of data.messages) statements.push(db.prepare(`INSERT INTO account_context_messages (owner_id,chat_id,message_id,sender_name,direction,content_type,body,sent_at,edited_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}
      AND EXISTS (SELECT 1 FROM account_context_chats WHERE owner_id=? AND chat_id=? AND deleted_before_id<?)
      AND NOT EXISTS (SELECT 1 FROM account_context_deleted_messages WHERE owner_id=? AND chat_id=? AND message_id=?)
      AND NOT EXISTS (SELECT 1 FROM account_context_deleted_global g JOIN account_context_chats c ON c.owner_id=g.owner_id WHERE c.owner_id=? AND c.chat_id=? AND c.chat_type IN ('private','bot','group','saved') AND g.message_id=?)
    ON CONFLICT(owner_id,chat_id,message_id) DO UPDATE SET sender_name=excluded.sender_name,direction=excluded.direction,content_type=excluded.content_type,body=excluded.body,sent_at=excluded.sent_at,edited_at=excluded.edited_at,updated_at=excluded.updated_at
    WHERE COALESCE(excluded.edited_at,excluded.sent_at)>=COALESCE(account_context_messages.edited_at,account_context_messages.sent_at)
      AND (account_context_messages.body<>excluded.body OR account_context_messages.edited_at IS NOT excluded.edited_at OR account_context_messages.sender_name<>excluded.sender_name OR account_context_messages.content_type<>excluded.content_type)`)
    .bind(owner, item.chat_id, item.message_id, item.sender_name, item.direction, item.content_type, item.body, item.sent_at, item.edited_at, now, ...args, owner, item.chat_id, item.message_id, owner, item.chat_id, item.message_id, owner, item.chat_id, item.message_id));
  for (const item of data.checkpoints) {
    const fields = ['updated_at=?'], values = [now];
    if (item.latest_synced_id !== undefined) { fields.push('latest_synced_id=MAX(latest_synced_id,?)'); values.push(item.latest_synced_id); }
    if (item.history_before_id !== undefined) { fields.push('history_before_id=?'); values.push(item.history_before_id); }
    if (item.history_complete === true) { fields.push("history_complete=1", "history_status='complete'"); }
    else if (item.history_complete === false && item.history_status === 'paused') { fields.push("history_complete=0", "history_status='paused'"); }
    else if (item.history_status !== undefined) { fields.push('history_status=CASE WHEN history_complete=1 THEN history_status ELSE ? END'); values.push(item.history_status); }
    if (item.channel_pts != null) { fields.push('channel_pts=MAX(COALESCE(channel_pts,0),?)'); values.push(item.channel_pts); }
    statements.push(db.prepare(`UPDATE account_context_chats SET ${fields.join(',')} WHERE owner_id=? AND chat_id=? AND ${guard}`).bind(...values, owner, item.chat_id, ...args));
  }
  const stateFields = ['updated_at=?', 'state_revision=state_revision+1'], stateValues = [now];
  for (const key of ['dialog_cursor_json', 'update_state_json']) if (data.state[key] !== undefined) { stateFields.push(`${key}=?`); stateValues.push(data.state[key]); }
  if (data.state.dialogs_complete !== undefined) { stateFields.push('dialogs_complete=?'); stateValues.push(data.state.dialogs_complete ? 1 : 0); }
  statements.push(db.prepare(`UPDATE account_context_sync SET ${stateFields.join(',')} WHERE owner_id=? AND ${guard}`).bind(...stateValues, owner, ...args));
  statements.push(db.prepare(`UPDATE account_context_batches SET applied=1 WHERE owner_id=? AND batch_id=? AND ${guard}`).bind(owner, input.batch_id, ...args));
  const results = await db.batch(statements);
  const saved = await db.prepare('SELECT * FROM account_context_batches WHERE owner_id=? AND batch_id=?').bind(owner, input.batch_id).first();
  if (!saved || saved.body_hash !== bodyHash || saved.applied !== 1) throw fail(409, 'Порция не принята: доступ или бюджет изменился.');
  await completeReceipt(env, owner, saved, data, results);
  const current = await db.prepare('SELECT * FROM account_context_sync WHERE owner_id=?').bind(owner).first();
  return { ok: true, batch_id: input.batch_id, quota_remaining: remaining(current, env) };
}

async function finish(env, input, job) {
  record(input, ['lease_id', 'generation', 'status', 'retry_after_seconds', 'chat_id']);
  if (!['idle', 'flood_wait', 'quota', 'error', 'reconciliation_required'].includes(input.status)) throw fail(400, 'Некорректный статус задания.');
  if (input.chat_id !== undefined && input.status !== 'reconciliation_required') throw fail(400, 'Чат допустим только для остановки неполной синхронизации.');
  const row = await control(env), now = nowIso(); requireLease(row, input, job, now);
  if (input.status === 'reconciliation_required') {
    const chat = input.chat_id === undefined ? null : chatId(input.chat_id);
    const marker = JSON.stringify(chat ? { scope: 'channel', chat_id: chat } : { scope: 'global' });
    // Privacy stops are control operations: a full ingest budget must not prevent quarantine.
    const statements = [database(env).prepare(`UPDATE account_context_sync SET
      reconciliation_json=?,state_revision=state_revision+1,
      lease_id=NULL,lease_run=NULL,lease_until=NULL,status='reconciliation_required',retry_after_at=NULL,last_error=NULL,updated_at=?
      WHERE owner_id=? AND enabled=1 AND generation=? AND state_revision=? AND lease_id=? AND lease_run=?
        AND lease_until>MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(marker, now, row.owner_id, input.generation, row.state_revision, input.lease_id, job.run, now)];
    if (chat) statements.push(database(env).prepare(`UPDATE account_context_chats SET history_status='paused',history_complete=0,updated_at=?
      WHERE owner_id=? AND chat_id=? AND EXISTS (SELECT 1 FROM account_context_sync WHERE owner_id=? AND generation=?
        AND state_revision=? AND status='reconciliation_required' AND updated_at=?)`)
      .bind(now, row.owner_id, chat, row.owner_id, input.generation, row.state_revision + 1, now));
    const results = await database(env).batch(statements);
    if (!results[0].meta?.changes) throw fail(409, 'Задание остановлено.');
    return { ok: true };
  }
  const seconds = input.retry_after_seconds === undefined ? 0 : integer(input.retry_after_seconds);
  const retry = input.status === 'flood_wait' ? new Date(Date.now() + Math.max(1, seconds) * 1000).toISOString() : null;
  const result = await database(env).prepare(`UPDATE account_context_sync SET lease_id=NULL,lease_run=NULL,lease_until=NULL,status=?,retry_after_at=?,last_sync_at=?,last_error=?,updated_at=?
    WHERE owner_id=? AND enabled=1 AND generation=? AND lease_id=? AND lease_run=? AND lease_until>MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(input.status, retry, input.status === 'idle' ? now : row.last_sync_at, input.status === 'error' ? 'Ошибка фоновой синхронизации.' : null, now, row.owner_id, input.generation, input.lease_id, job.run, now).run();
  if (!result.meta?.changes) throw fail(409, 'Задание остановлено.');
  return { ok: true };
}

export async function handleAccountSyncApi(request, env, { verifyJob = verifyContextJob } = {}) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(INTERNAL)) return null;
  if (request.method !== 'POST') return json({ error: 'Нужен POST.' }, 405);
  if (!configured(env)) return json({ error: 'Подключение аккаунта ещё не настроено.' }, 503);
  const job = await verifyJob(request, env);
  if (!job) return json({ error: 'Нет доступа.' }, 401);
  try {
    database(env);
    const { value, hash } = await readBody(request), suffix = path.slice(INTERNAL.length);
    if (suffix === 'claim') { record(value, []); return json(await claim(env, job)); }
    if (suffix === 'state') return json(await readState(env, value, job));
    if (suffix === 'batch') return json(await applyBatch(env, value, hash, job));
    if (suffix === 'finish') return json(await finish(env, value, job));
    return json({ error: 'Метод не найден.' }, 404);
  } catch (error) {
    if (!error.status) console.error('Account context internal operation failed');
    return json({ error: error.status ? error.message : 'Синхронизация временно недоступна.' }, error.status || 503);
  }
}

async function archiveStatus(env, owner) {
  const canSetup = adminIdSet(env).has(String(owner)) && (!accountContextOwner(env) || String(owner) === accountContextOwner(env));
  if (!configured(env) || String(owner) !== accountContextOwner(env)) return { available: false, can_setup: canSetup, enabled: false, status: 'setup_required' };
  const db = database(env), row = await control(env);
  const counts = await db.prepare(`SELECT COUNT(*) AS chats,COALESCE(SUM(stored_count),0) AS messages,
    COALESCE(SUM(CASE WHEN history_complete=1 THEN 1 ELSE 0 END),0) AS complete_chats,
    COALESCE(SUM(CASE WHEN history_status='unavailable' THEN 1 ELSE 0 END),0) AS unavailable_chats FROM account_context_chats WHERE owner_id=?`).bind(owner).first();
  const reconciliation = Boolean(row.reconciliation_json || JSON.parse(row.update_state_json || '{}').reconciliation_required);
  return { available: true, can_setup: true, account_id: owner, enabled: row.enabled === 1, status: reconciliation ? 'reconciliation_required' : row.status, reconciliation_required: reconciliation, dialogs_complete: row.dialogs_complete === 1, ...counts, quota_remaining: remaining(row, env), last_sync_at: row.last_sync_at, retry_after_at: row.retry_after_at, last_error: row.last_error };
}

export async function listAccountMessages(env, owner, chat, { limit = 200, before = null } = {}) {
  if (String(owner) !== accountContextOwner(env)) throw fail(403, 'Это архив другого владельца.');
  chatId(chat);
  await assertAccountChatReadable(env, owner, chat);
  limit = Math.min(200, Math.max(1, Math.round(Number(limit) || 100)));
  const values = [String(owner), chat];
  let cursorSql = '';
  if (before) {
    let cursor;
    try { cursor = JSON.parse(atob(before.replaceAll('-', '+').replaceAll('_', '/'))); } catch { throw fail(400, 'Некорректный курсор.'); }
    const time = date(cursor.sent_at), id = integer(cursor.message_id, 1);
    cursorSql = ' AND (m.sent_at<? OR (m.sent_at=? AND m.message_id<?))'; values.push(time, time, id);
  }
  const rows = (await database(env).prepare(`SELECT m.*,c.chat_title FROM account_context_messages m JOIN account_context_chats c ON c.owner_id=m.owner_id AND c.chat_id=m.chat_id
    WHERE m.owner_id=? AND m.chat_id=?${cursorSql} AND ${ACCOUNT_READABLE_SQL}
    ORDER BY m.sent_at DESC,m.message_id DESC LIMIT ?`).bind(...values, ...accountVisibilityArgs(owner, chat), limit + 1).all()).results || [];
  const selected = rows.slice(0, limit), oldest = selected.at(-1);
  const next = rows.length > limit && oldest ? btoa(JSON.stringify({ sent_at: oldest.sent_at, message_id: oldest.message_id })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') : null;
  return { messages: selected.reverse().map(({ owner_id: _owner, updated_at: _updated, ...row }) => row), next_cursor: next };
}

export async function handleAccountArchiveApi(request, env, user, { buildMarkdown } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PRIVATE)) return null;
  const path = url.pathname.slice(PRIVATE.length), owner = String(user.id);
  try {
    if (path === 'status' && request.method === 'GET') return json(await archiveStatus(env, owner));
    if (owner !== accountContextOwner(env)) throw fail(403, 'Архив доступен только владельцу аккаунта.');
    const db = database(env), now = nowIso();
    if (path === 'shares' && request.method === 'GET') return json({ shares: await listContextShares(env, owner, url.searchParams.get('chat_id'), { archive: true }) });
    if (path === 'shares' && request.method === 'POST') return json({ share: await createContextShare(env, owner, await readShareRequest(request), { archive: true }) }, 201);
    if (path.startsWith('shares/') && request.method === 'DELETE') {
      await revokeContextShare(env, owner, path.slice(7), { archive: true }); return json({ ok: true });
    }
    if (request.method === 'POST' && ['enable', 'pause'].includes(path)) {
      const input = await readShareRequest(request);
      if (path === 'enable' && (input.confirmed !== true || String(input.account_id) !== owner)) throw fail(400, 'Нужно подтвердить подключение своего аккаунта.');
      await control(env);
      await db.prepare(`UPDATE account_context_sync SET enabled=?,owner_confirmed_at=CASE WHEN ?=1 THEN ? ELSE owner_confirmed_at END,
        generation=generation+1,lease_id=NULL,lease_run=NULL,lease_until=NULL,status=?,updated_at=? WHERE owner_id=?`).bind(path === 'enable' ? 1 : 0, path === 'enable' ? 1 : 0, now, path === 'enable' ? 'pending' : 'paused', now, owner).run();
      return json(await archiveStatus(env, owner));
    }
    if (path === 'chats' && request.method === 'GET') {
      const after = url.searchParams.get('after') || '', search = (url.searchParams.get('q') || '').trim().slice(0, 40).normalize('NFKC').toLowerCase();
      const rows = (await db.prepare(`SELECT chat_id,chat_type,chat_title,archived,stored_count AS message_count,history_complete,history_status,last_message_at FROM account_context_chats
        WHERE owner_id=? AND chat_id>? AND instr(chat_title_search,?)>0 ORDER BY chat_id LIMIT 201`).bind(owner, after, search).all()).results || [];
      return json({ chats: rows.slice(0, 200), next_chat_id: rows.length > 200 ? rows[199].chat_id : null });
    }
    if (['messages', 'export'].includes(path) && request.method === 'GET') {
      const chat = chatId(url.searchParams.get('chat_id'));
      const page = await listAccountMessages(env, owner, chat, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') });
      if (path === 'messages') return json(page);
      const markdown = buildMarkdown({ chatTitle: page.messages.at(-1)?.chat_title || `Чат ${chat}`, chatId: chat, messages: page.messages });
      return new Response(markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="telegram-account-${chat}.md"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path.startsWith('chats/') && request.method === 'DELETE') {
      const chat = chatId(decodeURIComponent(path.slice(6)));
      await db.batch([
        db.prepare("UPDATE account_context_sync SET generation=generation+1,lease_id=NULL,lease_run=NULL,lease_until=NULL,status='paused',updated_at=? WHERE owner_id=?").bind(now, owner),
        db.prepare("UPDATE account_context_chats SET deleted_before_id=MAX(deleted_before_id,top_message_id,latest_synced_id),stored_count=0,history_complete=1,history_status='complete',history_before_id=NULL,updated_at=? WHERE owner_id=? AND chat_id=?").bind(now, owner, chat),
        db.prepare('DELETE FROM account_context_messages WHERE owner_id=? AND chat_id=?').bind(owner, chat),
        db.prepare('DELETE FROM context_shares WHERE owner_id=? AND chat_id=?').bind(owner, chat),
      ]);
      return json({ ok: true });
    }
    return json({ error: 'Метод не поддерживается.' }, 405);
  } catch (error) {
    if (!error.status) console.error('Account context private operation failed');
    return json({ error: error.status ? error.message : 'Архив временно недоступен.' }, error.status || 503);
  }
}

export async function handleAccountPublicShare(request, env, buildMarkdown) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(ACCOUNT_SHARE_PREFIX)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return sharedContextResponse('Только чтение.', 405, { Allow: 'GET, HEAD' });
  const unavailable = () => sharedContextResponse(request.method === 'HEAD' ? null : 'Ссылка недоступна или срок её действия истёк.', 404);
  if (!configured(env)) return unavailable();
  try {
    const share = await readContextShare(env, path.slice(ACCOUNT_SHARE_PREFIX.length), { archive: true });
    if (!share) return unavailable();
    const { messages } = await listAccountMessages(env, share.owner_id, share.chat_id, { limit: share.message_limit });
    if (!messages.length) return unavailable();
    return sharedContextResponse(request.method === 'HEAD' ? null : buildMarkdown({ chatTitle: messages.at(-1).chat_title, chatId: share.chat_id, messages }));
  } catch { console.error('Account context share read failed'); return sharedContextResponse(request.method === 'HEAD' ? null : 'Архив временно недоступен.', 503); }
}
