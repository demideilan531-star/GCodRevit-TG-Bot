import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import worker from '../cloudflare-worker/src/index.js';
import { handleAccountSyncApi, handleAccountArchiveApi } from '../cloudflare-worker/src/account-context.js';
import { buildContextMarkdown } from '../cloudflare-worker/src/chat-context.js';
import { createSqliteD1 } from './sport-db-fixture.mjs';
import {
  createContextFixture, CONTEXT_ADMIN as OWNER, CONTEXT_OWNER as OTHER, CONTEXT_CHAT as CHAT,
  CONTEXT_OTHER_CHAT as OTHER_CHAT, CONTEXT_NOW as NOW, CONTEXT_ORIGIN as ORIGIN, shareId,
} from './context-db-fixture.mjs';

const JOB = { run: '930001:1' };
const SECOND_JOB = { run: '930002:1' };
const cost = (body, affectedGlobal = 0) => 64 + (body.messages?.length || 0) * 12 + (body.dialogs?.length || 0) * 8
  + (body.deleted?.length || 0) * 12 + (body.checkpoints?.length || 0) * 4
  + (body.global_deleted?.length || 0) * 12 + affectedGlobal * 6;
const dialog = (extra = {}) => ({ chat_id: CHAT, chat_type: 'private', chat_title: 'Вымышленный диалог',
  archived: false, top_message_id: 100, last_message_at: NOW, ...extra });
const message = (id = 1, extra = {}) => ({ chat_id: CHAT, message_id: id, sender_name: 'Fictional participant',
  direction: 'incoming', content_type: 'text', body: `Fictional archive message ${id}`,
  sent_at: '2015-01-01T00:00:00.000Z', edited_at: null, ...extra });

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Account QA must never access external services'));
  const base = createContextFixture(t);
  const archive = createSqliteD1(t, { migrations: [] });
  archive.sqlite.exec(readFileSync(new URL('../cloudflare-worker/account-migrations/0001_create_account_archive.sql', import.meta.url), 'utf8'));
  // Production uses SQLite's clock; tests bind that clock to t.mock.Date as well.
  archive.sqlite.function('strftime', { varargs: true }, (format, when) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ');
    assert.equal(when, 'now');
    return new Date().toISOString();
  });
  const env = { ...base.env, ACCOUNT_CONTEXT_DB: archive.db, TELEGRAM_ACCOUNT_SYNC_ENABLED: 'true',
    TELEGRAM_ACCOUNT_OWNER_ID: OWNER, TELEGRAM_ACCOUNT_DAILY_WRITE_BUDGET: '10000',
    GITHUB_REPOSITORY: 'fictional-owner/fictional-repository', TELEGRAM_CONTEXT_REPOSITORY_ID: '910001',
    TELEGRAM_CONTEXT_OIDC_AUDIENCE: `${ORIGIN}/internal/account-sync` };
  let sequence = 0;
  function internalRequest(path, body = {}, { method = 'POST', headers = {} } = {}) {
    return new Request(`${ORIGIN}/internal/account-context/${path}`, { method,
      headers: { Authorization: 'Bearer fictional-injected-job-only', 'Content-Type': 'application/json', ...headers },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body) } : {}) });
  }
  const control = () => archive.sqlite.prepare('SELECT * FROM account_context_sync WHERE owner_id=?').get(OWNER);
  return { base, ...archive, env, internalRequest, control,
    batch(lease, extra = {}) { return { lease_id: lease.lease_id, generation: lease.generation, batch_id: shareId(++sequence), ...extra }; },
  };
}

async function jsonResponse(response, status = 200) {
  assert.ok(response instanceof Response);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  return body;
}
async function sync(f, path, body = {}, status = 200, job = JOB) {
  return jsonResponse(await handleAccountSyncApi(f.internalRequest(path, body), f.env,
    { verifyJob: async () => job }), status);
}
async function fetchWorker(f, request) {
  const pending = [];
  const response = await worker.fetch(request, f.env, { waitUntil(value) { pending.push(value); } });
  await Promise.all(pending);
  return response;
}
async function privateApi(f, path, { method = 'GET', body, owner = OWNER, initData } = {}, status = 200) {
  return jsonResponse(await fetchWorker(f, f.base.request(`/account/${path}`, { method, body, owner, initData })), status);
}
async function enable(f) {
  await privateApi(f, 'enable', { method: 'POST', body: { confirmed: true, account_id: OWNER } });
  return sync(f, 'claim');
}
function stored(f, table) { return f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row })); }
function counts(f) {
  return Object.fromEntries(['account_context_messages', 'account_context_chats', 'account_context_batches', 'account_context_deleted_messages']
    .map(table => [table, f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}
function holdNextBatch(t, f) {
  const batch = f.db.batch.bind(f.db);
  let notify, release;
  const reached = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  t.mock.method(f.db, 'batch', async statements => {
    if (!held) { held = true; notify(); await gate; }
    return batch(statements);
  });
  return { reached, release };
}

test('account archive is unavailable without configuration and internal disabled requests never resolve OIDC or touch a DB', async t => {
  const f = fixture(t);
  for (const changed of [
    { TELEGRAM_ACCOUNT_SYNC_ENABLED: undefined }, { TELEGRAM_ACCOUNT_SYNC_ENABLED: 'false' },
    { ACCOUNT_CONTEXT_DB: undefined }, { TELEGRAM_ACCOUNT_OWNER_ID: '' }, { TELEGRAM_ACCOUNT_OWNER_ID: OTHER },
  ]) {
    const env = { ...f.env, ...changed };
    const forbidden = { prepare() { assert.fail('Unconfigured archive must not query a DB'); }, batch() { assert.fail('Unconfigured archive must not write a DB'); } };
    env.TASKS_DB = forbidden; env.CHAT_CONTEXT_DB = forbidden;
    if (env.ACCOUNT_CONTEXT_DB) env.ACCOUNT_CONTEXT_DB = forbidden;
    const response = await handleAccountSyncApi(f.internalRequest('claim'), env, { verifyJob: async () => { assert.fail('Disabled feature must not resolve OIDC'); } });
    await jsonResponse(response, 503);
    const status = await handleAccountArchiveApi(f.base.request('/account/status', { owner: OWNER }), env, { id: OWNER }, { buildMarkdown: buildContextMarkdown });
    assert.equal((await jsonResponse(status)).available, false);
  }
});

test('configured internal endpoints have no env-only or Telegram-auth bypass for real OIDC verification', async t => {
  const f = fixture(t);
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer not-a-jwt' }]) {
    await jsonResponse(await handleAccountSyncApi(f.internalRequest('claim', {}, { headers }), f.env), 401);
  }
  await jsonResponse(await handleAccountSyncApi(f.internalRequest('claim'), f.env, { verifyJob: async () => null }), 401);
  assert.equal(f.control(), undefined);
});

test('only the signed configured administrator can explicitly enable the disabled archive', async t => {
  const f = fixture(t);
  const initial = await privateApi(f, 'status');
  assert.equal(initial.available, true); assert.equal(initial.enabled, false);
  await sync(f, 'claim', {}, 409);
  for (const body of [{}, { confirmed: false, account_id: OWNER }, { confirmed: true, account_id: OTHER }]) {
    await privateApi(f, 'enable', { method: 'POST', body }, 400);
    assert.equal(f.control().enabled, 0);
  }
  await privateApi(f, 'enable', { method: 'POST', body: { confirmed: true, account_id: OWNER }, owner: OTHER }, 403);
  await privateApi(f, 'status', { initData: null }, 401);
  const lease = await enable(f);
  assert.equal(lease.owner_id, OWNER); assert.equal(f.control().enabled, 1);
  assert.equal(f.control().owner_confirmed_at, NOW);
  assert.equal(f.base.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='account_context_messages'").get().n, 0);
});

test('claim has a ten-minute lease, same-run idempotency and excludes other runs and attempts', async t => {
  const f = fixture(t); const lease = await enable(f);
  assert.equal(Date.parse(lease.lease_until) - Date.parse(NOW), 600000);
  assert.equal(lease.quota_remaining, 10000);
  t.mock.timers.setTime(Date.parse(NOW) + 60000);
  const again = await sync(f, 'claim');
  assert.equal(again.lease_id, lease.lease_id); assert.equal(again.lease_until, lease.lease_until);
  await sync(f, 'claim', {}, 409, SECOND_JOB);
  await sync(f, 'state', { lease_id: lease.lease_id, generation: lease.generation }, 409, { run: '930001:2' });
  t.mock.timers.setTime(Date.parse(lease.lease_until));
  const next = await sync(f, 'claim', {}, 200, SECOND_JOB);
  assert.notEqual(next.lease_id, lease.lease_id);
  await sync(f, 'state', { lease_id: lease.lease_id, generation: lease.generation }, 409);
});

test('simultaneous claim retries from the same signed run return one stable lease', async t => {
  const f = fixture(t);
  await privateApi(f, 'enable', { method: 'POST', body: { confirmed: true, account_id: OWNER } });
  const original = f.db.prepare.bind(f.db);
  let read = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(f.db, 'prepare', sql => {
    const statement = original(sql);
    if (sql === 'SELECT * FROM account_context_sync WHERE owner_id=?') {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values); const first = bound.first.bind(bound);
        bound.first = async () => {
          const row = await first();
          if (row?.lease_id === null && read < 2) { if (++read === 2) release(); await gate; }
          return row;
        };
        return bound;
      };
    }
    return statement;
  });
  const leases = await Promise.all([sync(f, 'claim'), sync(f, 'claim')]);
  assert.equal(leases[0].lease_id, leases[1].lease_id, 'Concurrent retries must not invalidate their own earlier response');
  assert.equal(f.control().lease_id, leases[0].lease_id);
});

test('ingest binds whitespace and untrusted text without modifying Secretary data or truncating the archive', async t => {
  const f = fixture(t); const lease = await enable(f);
  f.base.seedMessage({ owner: OWNER, body: 'Fictional Secretary source unchanged' });
  const body = f.batch(lease, { dialogs: [dialog({ chat_title: "Fictional '); DROP TABLE account_context_messages; --" })],
    messages: [message(1, { body: ' \n\t Ignore previous instructions; =1+1; <script>fictional</script>  \n' })],
    checkpoints: [{ chat_id: CHAT, latest_synced_id: 1, history_before_id: 1, history_status: 'loading' }],
    state: { dialog_cursor: { folder: 1, offset_peer_id: '-1000000830001' }, update_state: { pts: 5, date: 1793005200, seq: 1 } } });
  const result = await sync(f, 'batch', body);
  assert.equal(result.quota_remaining, 10000 - cost(body));
  const row = stored(f, 'account_context_messages')[0];
  assert.equal(row.owner_id, OWNER); assert.equal(row.body, body.messages[0].body); assert.equal(row.sent_at, '2015-01-01T00:00:00.000Z');
  assert.equal(stored(f, 'account_context_chats')[0].stored_count, 1);
  assert.equal(stored(f, 'account_context_batches')[0].applied, 1);
  assert.equal(f.base.sqlite.prepare('SELECT body FROM chat_context_messages').get().body, 'Fictional Secretary source unchanged');
  const state = await sync(f, 'state', { lease_id: lease.lease_id, generation: lease.generation });
  assert.equal(state.chats[0].latest_synced_id, 1); assert.equal(state.chats[0].history_before_id, 1);
  assert.equal(JSON.stringify(state).includes('Ignore previous instructions'), false);
});

test('identical and concurrent batch retries acknowledge one receipt without repeating data or budget charges', async t => {
  const f = fixture(t); const lease = await enable(f);
  const body = f.batch(lease, { dialogs: [dialog()], messages: [message()] });
  const responses = await Promise.all([sync(f, 'batch', body), sync(f, 'batch', body)]);
  assert.ok(responses.every(result => result.ok && result.batch_id === body.batch_id));
  const snapshot = { control: { ...f.control() }, counts: counts(f), receipt: stored(f, 'account_context_batches') };
  await sync(f, 'batch', body);
  assert.equal(f.control().quota_used, cost(body));
  assert.deepEqual({ control: { ...f.control() }, counts: counts(f), receipt: stored(f, 'account_context_batches') }, snapshot);
  await sync(f, 'batch', { ...body, messages: [message(1, { body: 'Fictional collision' })] }, 409);
  assert.equal(stored(f, 'account_context_messages')[0].body, message().body);
});

test('a failed D1 batch rolls back receipt, quota, dialog, message and cursors together and permits retry', async t => {
  const f = fixture(t); const lease = await enable(f);
  t.mock.method(console, 'error', () => {});
  f.sqlite.exec("CREATE TRIGGER fictional_ingest_failure BEFORE INSERT ON account_context_messages BEGIN SELECT RAISE(ABORT, 'fictional fault'); END");
  const body = f.batch(lease, { dialogs: [dialog()], messages: [message()], checkpoints: [{ chat_id: CHAT, history_before_id: 1 }], state: { dialogs_complete: true, update_state: { pts: 9 } } });
  const control = { ...f.control() };
  await sync(f, 'batch', body, 503);
  assert.deepEqual({ ...f.control() }, control);
  assert.ok(Object.values(counts(f)).every(value => value === 0));
  f.sqlite.exec('DROP TRIGGER fictional_ingest_failure');
  await sync(f, 'batch', body);
  assert.equal(f.control().quota_used, cost(body));
  assert.equal(f.control().dialogs_complete, 1);
});

test('pause wins against an already validated batch before its atomic commit', async t => {
  const f = fixture(t); const lease = await enable(f);
  const held = holdNextBatch(t, f);
  const body = f.batch(lease, { dialogs: [dialog()], messages: [message()], state: { update_state: { pts: 99 } } });
  const pending = sync(f, 'batch', body, 409);
  await held.reached;
  try { await privateApi(f, 'pause', { method: 'POST', body: {} }); }
  finally { held.release(); }
  await pending;
  assert.equal(f.control().enabled, 0); assert.ok(f.control().generation > lease.generation);
  assert.equal(f.control().quota_used, 0);
  assert.ok(Object.values(counts(f)).every(value => value === 0));
});

test('a lease that expires while a batch waits to commit cannot write data or spend quota', async t => {
  const f = fixture(t); const lease = await enable(f);
  const held = holdNextBatch(t, f);
  const pending = sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }), 409);
  await held.reached;
  t.mock.timers.setTime(Date.parse(lease.lease_until) + 1);
  held.release(); await pending;
  assert.equal(f.control().quota_used, 0);
  assert.ok(Object.values(counts(f)).every(value => value === 0));
});

test('a batch admitted before lease expiry stays fully atomic if time crosses expiry inside the transaction', async t => {
  const f = fixture(t); const lease = await enable(f);
  t.mock.timers.setTime(Date.parse(lease.lease_until) - 1);
  f.sqlite.function('fictional_cross_lease_deadline', () => {
    t.mock.timers.setTime(Date.parse(lease.lease_until) + 1);
    return 1;
  });
  f.sqlite.exec(`CREATE TRIGGER fictional_tick_after_receipt AFTER INSERT ON account_context_batches
    BEGIN SELECT fictional_cross_lease_deadline(); END`);
  const body = f.batch(lease, { dialogs: [dialog()], messages: [message()],
    checkpoints: [{ chat_id: CHAT, history_before_id: 1 }], state: { update_state: { pts: 1 } } });
  await sync(f, 'batch', body);
  assert.equal(stored(f, 'account_context_messages').length, 1);
  assert.equal(stored(f, 'account_context_chats')[0].history_before_id, 1);
  assert.equal(stored(f, 'account_context_batches')[0].applied, 1);
  assert.equal(f.control().quota_used, cost(body));
  assert.deepEqual(JSON.parse(f.control().update_state_json), { pts: 1 });
});

test('a stale concurrent history checkpoint cannot move the committed frontier backwards', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()] }));
  const held = holdNextBatch(t, f);
  const stale = handleAccountSyncApi(f.internalRequest('batch', f.batch(lease, {
    messages: [message(50)], checkpoints: [{ chat_id: CHAT, history_before_id: 50, latest_synced_id: 50 }],
    state: { update_state: { pts: 50, seq: 5 } },
  })), f.env, { verifyJob: async () => JOB });
  await held.reached;
  try {
    await sync(f, 'batch', f.batch(lease, { messages: [message(10)], checkpoints: [{ chat_id: CHAT, history_before_id: 10, latest_synced_id: 10 }],
      state: { update_state: { pts: 100, seq: 10 } } }));
  } finally { held.release(); }
  const result = await stale;
  assert.ok([200, 409].includes(result.status));
  const chat = stored(f, 'account_context_chats')[0];
  assert.deepEqual({ before: chat.history_before_id, updates: JSON.parse(f.control().update_state_json) },
    { before: 10, updates: { pts: 100, seq: 10 } }, 'A stale request cannot replace committed history or global update checkpoints');
});

test('internal JSON guards enforce POST, content type, actual/declared byte limits and structured objects', async t => {
  const f = fixture(t);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    await jsonResponse(await handleAccountSyncApi(f.internalRequest('claim', {}, { method }), f.env, { verifyJob: async () => JOB }), 405);
  }
  assert.equal(await handleAccountSyncApi(new Request(`${ORIGIN}/unrelated`), f.env), null);
  const verify = { verifyJob: async () => JOB };
  for (const [body, type, length, expected] of [
    ['{}', 'text/plain', undefined, 415], ['{}', 'application/json', '1048577', 413],
    [' '.repeat(1048577), 'application/json', '1', 413], ['{', 'application/json', undefined, 400],
    ['null', 'application/json', undefined, 400], ['[]', 'application/json', undefined, 400],
    ['{"owner_id":"other"}', 'application/json', undefined, 400],
  ]) {
    const request = new Request(`${ORIGIN}/internal/account-context/claim`, { method: 'POST',
      headers: { 'Content-Type': type, ...(length ? { 'Content-Length': length } : {}) }, body });
    await jsonResponse(await handleAccountSyncApi(request, f.env, verify), expected);
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ padding: 'я'.repeat(524288) }));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 900000)); controller.enqueue(bytes.slice(900000)); controller.close(); } });
  await jsonResponse(await handleAccountSyncApi(new Request(`${ORIGIN}/internal/account-context/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half',
  }), f.env, verify), 413);
  assert.equal(f.control(), undefined);
});

test('batch metadata validation rejects unknown fields, duplicates, unowned chats and array overflows without partial writes', async t => {
  const f = fixture(t); const lease = await enable(f);
  const initial = { ...f.control() };
  for (const extra of [
    { owner_id: OTHER }, { batch_id: '../not-a-uuid' }, { dialogs: {} },
    { dialogs: Array.from({ length: 101 }, (_, index) => dialog({ chat_id: String(index + 10000) })) },
    { dialogs: [dialog(), dialog()] }, { messages: [message()] },
    { dialogs: [dialog()], messages: [message(), message()] },
    { dialogs: [dialog()], messages: [message()], deleted: [{ chat_id: CHAT, message_id: 1 }] },
    { dialogs: [dialog({ api_hash: 'fictional-forbidden-field' })] },
    { dialogs: [dialog()], messages: [message(0)] },
    { dialogs: [dialog()], messages: [message(2147483648)] },
    { dialogs: [dialog()], messages: [message(1, { message_id: '1' })] },
    { dialogs: [dialog()], messages: [message(1, { media_id: 'fictional-file-id' })] },
    { dialogs: [dialog({ chat_id: 830001 })] }, { dialogs: [dialog({ chat_id: '1 OR 1=1' })] },
    { dialogs: [dialog({ chat_type: 'secret' })] }, { dialogs: [dialog({ archived: 1 })] },
    { dialogs: [dialog()], messages: [message(1, { direction: 'unknown' })] },
    { dialogs: [dialog()], messages: [message(1, { body: 'x'.repeat(6001) })] },
    { dialogs: [dialog()], messages: [message(1, { sender_name: 'x'.repeat(121) })] },
  ]) {
    await sync(f, 'batch', f.batch(lease, extra), 400);
    assert.ok(Object.values(counts(f)).every(value => value === 0));
    assert.deepEqual({ ...f.control() }, initial);
  }
});

test('a maximum 200-record batch commits without exceeding D1 binding limits', async t => {
  const f = fixture(t); const lease = await enable(f);
  const dialogs = Array.from({ length: 100 }, (_, index) => dialog({ chat_id: String(840000 + index) }));
  const messages = dialogs.map(row => message(1, { chat_id: row.chat_id }));
  const body = f.batch(lease, { dialogs, messages });
  await sync(f, 'batch', body);
  assert.equal(stored(f, 'account_context_messages').length, 100);
  assert.equal(stored(f, 'account_context_chats').length, 100);
  const before = { ...f.control() };
  await sync(f, 'batch', f.batch(lease, { dialogs, messages, checkpoints: [{ chat_id: dialogs[0].chat_id }] }), 400);
  assert.deepEqual({ ...f.control() }, before);
});

test('structured state accepts resumable metadata but rejects oversized UTF-8, arrays, nested credentials and unknown state fields', async t => {
  const f = fixture(t); const lease = await enable(f);
  const good = f.batch(lease, { state: { dialog_cursor: { folder: 1, offset_id: 3, offset_peer: '-1000000830001' }, update_state: { pts: 9, qts: 0, seq: 2, date: 1793005200 } } });
  await sync(f, 'batch', good);
  assert.deepEqual(JSON.parse(f.control().dialog_cursor_json), good.state.dialog_cursor);
  assert.deepEqual(JSON.parse(f.control().update_state_json), good.state.update_state);
  const before = { ...f.control() };
  for (const state of [
    { dialog_cursor: [] }, { update_state: null }, { update_state: { value: 'я'.repeat(8192) } },
    { dialog_cursor: { api_hash: 'fictional-secret' } }, { update_state: { nested: { auth_key: 'fictional-secret' } } },
    { update_state: { session_string: 'fictional-not-a-session' } }, { unknown: {} },
    { dialog_cursor: { nested: { apiHashSecret: 'fictional-secret' } } },
    { update_state: { nested: { refresh_token: 'fictional-secret' } } },
    { dialog_cursor: { phone_number: 'fictional-phone' } },
  ]) {
    await sync(f, 'batch', f.batch(lease, { state }), 400);
    assert.deepEqual({ ...f.control() }, before);
  }
  await sync(f, 'batch', f.batch(lease, { state: { dialogs_complete: true, dialog_cursor: null } }));
  assert.deepEqual(JSON.parse(f.control().dialog_cursor_json), {});
  assert.equal(f.control().dialogs_complete, 1);
});

test('checkpoints cannot jump ahead or increase history boundaries and finish does not fabricate completion', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(50), message(40)],
    checkpoints: [{ chat_id: CHAT, latest_synced_id: 50, history_before_id: 40, history_status: 'loading', channel_pts: 10 }] }));
  const before = stored(f, 'account_context_chats');
  for (const extra of [
    { checkpoints: [{ chat_id: CHAT, latest_synced_id: 51 }] },
    { messages: [message(30)], checkpoints: [{ chat_id: CHAT, history_before_id: 31 }] },
    { messages: [message(41)], checkpoints: [{ chat_id: CHAT, history_before_id: 41 }] },
    { checkpoints: [{ chat_id: CHAT, history_before_id: null }] },
    { checkpoints: [{ chat_id: CHAT, history_status: 'complete' }] },
  ]) {
    await sync(f, 'batch', f.batch(lease, extra), 400);
    assert.deepEqual(stored(f, 'account_context_chats'), before);
  }
  await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'idle' });
  assert.equal(stored(f, 'account_context_chats')[0].history_complete, 0);
  assert.equal(f.control().dialogs_complete, 0);
  const next = await sync(f, 'claim', {}, 200, SECOND_JOB);
  await sync(f, 'batch', f.batch(next, { messages: [message(1)], checkpoints: [{ chat_id: CHAT, history_before_id: 1, history_complete: true, history_status: 'complete' }] }), 200, SECOND_JOB);
  const chat = stored(f, 'account_context_chats')[0];
  assert.equal(chat.history_before_id, 1); assert.equal(chat.history_complete, 1); assert.equal(chat.latest_synced_id, 50);
});

test('explicit deletion tombstones block old backfill and older edits cannot replace a newer stored version', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(1), message(2)] }));
  await sync(f, 'batch', f.batch(lease, { messages: [message(2, { body: 'Fictional newest edit', edited_at: NOW })], deleted: [{ chat_id: CHAT, message_id: 1 }] }));
  await sync(f, 'batch', f.batch(lease, { messages: [message(1), message(2, { body: 'Fictional stale edit', edited_at: '2020-01-01T00:00:00.000Z' })] }));
  assert.deepEqual(stored(f, 'account_context_messages').map(row => row.body), ['Fictional newest edit']);
  assert.equal(stored(f, 'account_context_chats')[0].stored_count, 1);
  assert.equal(stored(f, 'account_context_deleted_messages')[0].message_id, 1);
});

test('state paginates more than 200 dialogs lexically without body text or cross-owner records', async t => {
  const f = fixture(t); const lease = await enable(f);
  const insert = f.sqlite.prepare(`INSERT INTO account_context_chats (owner_id,chat_id,chat_type,chat_title,updated_at)
    VALUES (?,?,'private','Fictional paging chat',?)`);
  for (let index = 0; index < 405; index++) insert.run(OWNER, String(840000 + index), NOW);
  insert.run(OTHER, '800000', NOW);
  const all = []; let after;
  do {
    const page = await sync(f, 'state', { lease_id: lease.lease_id, generation: lease.generation, ...(after ? { after_chat_id: after } : {}) });
    assert.ok(page.chats.length <= 200);
    assert.ok(page.chats.every(row => row.body === undefined && row.chat_id !== '800000'));
    all.push(...page.chats.map(row => row.chat_id)); after = page.next_chat_id;
  } while (after);
  assert.equal(all.length, 405); assert.equal(new Set(all).size, 405);
  assert.deepEqual(all, [...all].sort());
});

test('daily quota reserves conservative cost, pauses before data writes and resets at UTC midnight', async t => {
  const f = fixture(t);
  t.mock.timers.setTime(Date.parse('2026-10-26T23:59:00.000Z'));
  const lease = await enable(f);
  f.sqlite.prepare('UPDATE account_context_sync SET quota_used=10000 WHERE owner_id=?').run(OWNER);
  const body = f.batch(lease, { dialogs: [dialog()], messages: [message()] });
  await sync(f, 'batch', body, 429);
  assert.ok(Object.values(counts(f)).every(value => value === 0));
  t.mock.timers.setTime(Date.parse('2026-10-27T00:00:00.000Z'));
  await sync(f, 'batch', body);
  assert.equal(f.control().quota_day, '2026-10-27'); assert.equal(f.control().quota_used, cost(body));
});

test('known D1 rows_written reconciles upward and never refunds a conservative reservation', async t => {
  const f = fixture(t); const lease = await enable(f);
  const original = f.db.batch.bind(f.db);
  let actual = 200;
  t.mock.method(f.db, 'batch', async statements => {
    const result = await original(statements);
    return result.map((row, index) => ({ ...row, meta: { ...row.meta, rows_written: index === 0 ? actual : 0 } }));
  });
  const first = f.batch(lease, { dialogs: [dialog()], messages: [message()] });
  await sync(f, 'batch', first);
  assert.equal(f.control().quota_used, 200);
  assert.equal(stored(f, 'account_context_batches')[0].actual_rows_written, 200);
  actual = 1;
  const second = f.batch(lease, { messages: [message(2)] });
  await sync(f, 'batch', second);
  assert.equal(f.control().quota_used, 200 + cost(second));
});

test('storage watermark rejects a batch before spending credits or leaving a receipt', async t => {
  const f = fixture(t); const lease = await enable(f);
  const original = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', sql => {
    const statement = original(sql);
    if (sql.startsWith('SELECT owner_id FROM account_context_sync')) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values); const all = bound.all.bind(bound);
        bound.all = async () => { const result = await all(); return { ...result, meta: { ...result.meta, size_after: 400000000 } }; };
        return bound;
      };
    }
    return statement;
  });
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()] }), 507);
  assert.equal(f.control().quota_used, 0);
  assert.ok(Object.values(counts(f)).every(value => value === 0));
});

test('finish enforces FloodWait without fabricating history completion and rejects generic-error payload leaks', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'error', exception: 'Fictional raw private error' }, 400);
  await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'flood_wait', retry_after_seconds: 90 });
  assert.equal(f.control().retry_after_at, new Date(Date.parse(NOW) + 90000).toISOString());
  assert.equal(f.control().last_sync_at, null); assert.equal(f.control().dialogs_complete, 0);
  await sync(f, 'claim', {}, 409, SECOND_JOB);
  t.mock.timers.setTime(Date.parse(NOW) + 90000);
  const next = await sync(f, 'claim', {}, 200, SECOND_JOB);
  assert.notEqual(next.lease_id, lease.lease_id);
  await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'idle' }, 409);
});

test('private archive keeps old history, paginates timestamp ties, preserves canonical string IDs and searches Cyrillic', async t => {
  const f = fixture(t); const lease = await enable(f);
  const channel = '-1009007199254740993';
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog(), dialog({ chat_id: channel, chat_type: 'channel', chat_title: 'ЁЖ Контекст', archived: true })],
    messages: [message(1), message(2), message(3), message(4), message(5), message(1, { chat_id: channel })] }));
  let next; const ids = [];
  do {
    const page = await privateApi(f, `messages?chat_id=${CHAT}&limit=2${next ? `&before=${encodeURIComponent(next)}` : ''}`);
    ids.push(...page.messages.map(row => row.message_id)); next = page.next_cursor;
    assert.ok(page.messages.every(row => row.owner_id === undefined));
  } while (next);
  assert.deepEqual(ids, [4, 5, 2, 3, 1]); assert.equal(new Set(ids).size, 5);
  assert.equal((await privateApi(f, `messages?chat_id=${channel}`)).messages[0].chat_id, channel);
  const search = await privateApi(f, `chats?q=${encodeURIComponent('ёж кон')}`);
  assert.deepEqual(search.chats.map(row => row.chat_id), [channel]);
  assert.equal(search.chats[0].archived, 1);
  assert.deepEqual((await privateApi(f, `chats?q=${encodeURIComponent("' OR 1=1 --")}`)).chats, []);
  await privateApi(f, `messages?chat_id=${CHAT}&before=not-a-cursor`, {}, 400);
  await privateApi(f, `messages?chat_id=${CHAT}`, { owner: OTHER }, 403);
  const exported = await fetchWorker(f, f.base.request(`/account/export?chat_id=${CHAT}`, { owner: OWNER }));
  assert.equal(exported.status, 200); assert.match(await exported.text(), /Fictional archive message 1/);
  assert.equal(stored(f, 'account_context_messages').length, 6);
});

async function accountShare(f, extra = {}) {
  return (await privateApi(f, 'shares', { method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1, consent_confirmed: true, ...extra } }, 201)).share;
}
async function readPublic(f, url, status = 200, method = 'GET') {
  const response = await fetchWorker(f, new Request(url, { method }));
  assert.equal(response.status, status); assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.match(response.headers.get('Content-Type'), /^text\/plain/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  return response.text();
}

test('account sharing requires explicit consent and owner authorization without storing an implicit link', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  for (const consent_confirmed of [undefined, false, 'true', 1]) {
    await privateApi(f, 'shares', { method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1, consent_confirmed } }, 400);
  }
  await privateApi(f, 'shares', { owner: OTHER }, 403);
  await privateApi(f, 'shares', { owner: OTHER, method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1, consent_confirmed: true } }, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM context_shares').get().n, 0);
  assert.match((await readPublic(f, (await accountShare(f)).url)), /Fictional archive message/);
});

test('Secretary v1 and account links cannot cross data sources or signature purposes even with identical metadata IDs', async t => {
  const f = fixture(t); const lease = await enable(f);
  f.base.seedMessage({ owner: OWNER, body: 'Fictional Secretary-only marker' });
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(1, { body: 'Fictional archive-only marker' })] }));
  const id = shareId(999);
  const source = await jsonResponse(await fetchWorker(f, f.base.request('/shares', { owner: OWNER, method: 'POST',
    body: { id, chat_id: CHAT, limit: 1, ttl_hours: 1 } })), 201);
  const archive = await accountShare(f, { id });
  assert.ok((await readPublic(f, source.share.url)).includes('Fictional Secretary-only marker'));
  assert.ok(!(await readPublic(f, source.share.url)).includes('Fictional archive-only marker'));
  assert.ok((await readPublic(f, archive.url)).includes('Fictional archive-only marker'));
  assert.ok(!(await readPublic(f, archive.url)).includes('Fictional Secretary-only marker'));
  const row = f.sqlite.prepare('SELECT * FROM context_shares WHERE id=?').get(id);
  const signature = createHmac('sha256', f.env.TELEGRAM_BOT_TOKEN).update(JSON.stringify([
    'account-context-share:v1', row.id, row.owner_id, row.chat_id, row.message_limit, row.ttl_hours, row.created_at, row.expires_at,
  ])).digest('base64url');
  assert.equal(new URL(archive.url).pathname, `/account-context-share/${id}.${signature}`);
  await readPublic(f, source.share.url.replace('/context-share/', '/account-context-share/'), 404);
  await readPublic(f, archive.url.replace('/account-context-share/', '/context-share/'), 404);
  assert.equal(await readPublic(f, archive.url, 200, 'HEAD'), '');
});

test('account links expire, revoke and disappear when the owner is no longer configured', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  const share = await accountShare(f);
  await privateApi(f, `shares/${share.id}`, { owner: OTHER, method: 'DELETE' }, 403);
  await readPublic(f, share.url);
  await privateApi(f, `shares/${share.id}`, { method: 'DELETE' });
  await readPublic(f, share.url, 404);
  const next = await accountShare(f);
  f.env.TELEGRAM_ACCOUNT_SYNC_ENABLED = 'false'; await readPublic(f, next.url, 404);
  f.env.TELEGRAM_ACCOUNT_SYNC_ENABLED = 'true';
  t.mock.timers.setTime(Date.parse(next.expires_at));
  await readPublic(f, next.url, 404);
  assert.equal(await readPublic(f, next.url, 404, 'HEAD'), '');
});

test('deleting an account chat atomically revokes only its account links and blocks stale backfill', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(50)] }));
  const share = await accountShare(f);
  f.base.seedMessage({ owner: OWNER, body: 'Fictional preserved Secretary marker' });
  await privateApi(f, `chats/${CHAT}`, { method: 'DELETE' });
  await readPublic(f, share.url, 404);
  assert.equal(f.control().lease_id, null); assert.ok(f.control().generation > lease.generation);
  await sync(f, 'batch', f.batch(lease, { messages: [message(50)] }), 409);
  const next = await sync(f, 'claim', {}, 200, SECOND_JOB);
  await sync(f, 'batch', f.batch(next, { messages: [message(50)] }), 200, SECOND_JOB);
  assert.equal(stored(f, 'account_context_messages').length, 0);
  assert.equal(f.base.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_context_messages').get().n, 1);
});

test('global deletion removes all matching common messages but never channels or supergroups with the same message ID', async t => {
  const f = fixture(t); const lease = await enable(f);
  const chats = [
    ['860001', 'private'], ['860002', 'bot'], [OWNER, 'saved'], ['-860003', 'group'],
    ['-1000000860004', 'channel'], ['-1000000860005', 'supergroup'],
  ];
  await sync(f, 'batch', f.batch(lease, {
    dialogs: chats.map(([chat_id, chat_type]) => dialog({ chat_id, chat_type, top_message_id: 7 })),
    messages: chats.map(([chat_id]) => message(7, { chat_id })),
  }));
  const deletion = f.batch(lease, { global_deleted: [7] });
  const before = f.control().quota_used;
  await sync(f, 'batch', deletion);
  const charged = f.control().quota_used - before;
  assert.ok(charged <= cost(deletion, 4), 'Global-delete charges must fit the declared conservative reservation');
  assert.ok(charged >= cost(deletion));
  assert.deepEqual(stored(f, 'account_context_messages').map(row => row.chat_id).sort(), ['-1000000860004', '-1000000860005']);
  const metadata = stored(f, 'account_context_chats');
  for (const row of metadata) assert.equal(row.stored_count, ['channel', 'supergroup'].includes(row.chat_type) ? 1 : 0);
  const tombstone = stored(f, 'account_context_deleted_global');
  assert.equal(tombstone.length, 1); assert.equal(tombstone[0].owner_id, OWNER); assert.equal(tombstone[0].message_id, 7);
  const used = f.control().quota_used;
  await sync(f, 'batch', deletion);
  assert.equal(f.control().quota_used, used);
});

test('global tombstones protect unknown common chats discovered later without blocking a future channel copy', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { global_deleted: [77] }));
  await sync(f, 'batch', f.batch(lease, {
    dialogs: [dialog({ chat_id: '860077', top_message_id: 77 }), dialog({ chat_id: '-1000000860077', chat_type: 'channel', top_message_id: 77 })],
    messages: [message(77, { chat_id: '860077' }), message(77, { chat_id: '-1000000860077' })],
  }));
  assert.deepEqual(stored(f, 'account_context_messages').map(row => row.chat_id), ['-1000000860077']);
  assert.equal(f.sqlite.prepare('SELECT stored_count FROM account_context_chats WHERE owner_id=? AND chat_id=?').get(OWNER, '860077').stored_count, 0);
});

test('global tombstones and deletion effects are isolated by owner', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(9)] }));
  f.sqlite.prepare(`INSERT INTO account_context_chats (owner_id,chat_id,chat_type,chat_title,stored_count,updated_at)
    VALUES (?,?,'private','Fictional other owner',1,?)`).run(OTHER, CHAT, NOW);
  f.sqlite.prepare(`INSERT INTO account_context_messages
    (owner_id,chat_id,message_id,sender_name,direction,content_type,body,sent_at,updated_at)
    VALUES (?,?,9,'Fictional other participant','incoming','text','Fictional other owner message',?,?)`).run(OTHER, CHAT, NOW, NOW);
  await sync(f, 'batch', f.batch(lease, { global_deleted: [9] }));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_context_messages WHERE owner_id=?').get(OWNER).n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_context_messages WHERE owner_id=?').get(OTHER).n, 1);
  f.sqlite.prepare('INSERT INTO account_context_deleted_global (owner_id,message_id,deleted_at) VALUES (?,10,?)').run(OTHER, NOW);
  await sync(f, 'batch', f.batch(lease, { messages: [message(10)] }));
  assert.equal(f.sqlite.prepare('SELECT message_id FROM account_context_messages WHERE owner_id=?').get(OWNER).message_id, 10);
});

test('global deletion validates integer IDs and participates in array and total batch caps without partial effects', async t => {
  const f = fixture(t); const lease = await enable(f);
  const before = { ...f.control() };
  for (const global_deleted of [[0], [-1], [1.5], ['1'], [2147483648], [1, 1], Array.from({ length: 101 }, (_, i) => i + 1)]) {
    await sync(f, 'batch', f.batch(lease, { global_deleted }), 400);
    assert.deepEqual({ ...f.control() }, before);
  }
  await sync(f, 'batch', f.batch(lease, { global_deleted: Array.from({ length: 100 }, (_, i) => i + 1),
    dialogs: Array.from({ length: 100 }, (_, i) => dialog({ chat_id: String(870000 + i) })),
    checkpoints: [{ chat_id: '870000' }],
  }), 400);
  assert.equal(stored(f, 'account_context_deleted_global').length, 0);
  assert.deepEqual({ ...f.control() }, before);
});

test('a failed cross-DB deletion mirror returns 503 but tombstones keep old Secretary links private until replay repairs it', async t => {
  const f = fixture(t); const lease = await enable(f);
  t.mock.method(console, 'error', () => {});
  assert.notEqual(f.db, f.base.db);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(2)] }));
  f.base.seedMessage({ owner: OWNER, messageId: 1, body: 'Fictional allowed Secretary survivor' });
  f.base.seedMessage({ owner: OWNER, messageId: 2, body: 'Fictional removed Secretary secret' });
  const { share } = await jsonResponse(await fetchWorker(f, f.base.request('/shares', {
    owner: OWNER, method: 'POST', body: { chat_id: CHAT, limit: 2, ttl_hours: 1 },
  })), 201);
  const original = f.base.db.batch.bind(f.base.db);
  let failing = true, attempts = 0;
  t.mock.method(f.base.db, 'batch', statements => {
    attempts++;
    if (failing) throw new Error('Fictional mirror outage');
    return original(statements);
  });
  const deletion = f.batch(lease, { deleted: [{ chat_id: CHAT, message_id: 2 }] });
  await sync(f, 'batch', deletion, 503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_context_messages').get().n, 0);
  assert.equal(stored(f, 'account_context_batches').at(-1).applied, 1);
  assert.equal(f.base.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_context_messages').get().n, 2);
  const quota = f.control().quota_used;
  for (const enabled of ['true', 'false']) {
    f.env.TELEGRAM_ACCOUNT_SYNC_ENABLED = enabled;
    const body = await readPublic(f, share.url);
    assert.ok(body.includes('Fictional allowed Secretary survivor'));
    assert.ok(!body.includes('Fictional removed Secretary secret'));
    const response = await fetchWorker(f, f.base.request(`/messages?chat_id=${CHAT}`, { owner: OWNER }));
    assert.deepEqual((await jsonResponse(response)).messages.map(row => row.message_id), [1]);
  }
  f.env.TELEGRAM_ACCOUNT_SYNC_ENABLED = 'true';
  failing = false;
  await sync(f, 'batch', deletion);
  assert.equal(attempts, 2);
  assert.equal(f.control().quota_used, quota, 'Mirror retry must not charge the committed account batch twice');
  assert.deepEqual(f.base.sqlite.prepare('SELECT message_id FROM chat_context_messages').all().map(row => row.message_id), [1]);
});

test('global deletion mirrors only common namespaces for the exact owner and never selects Secretary bodies', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { global_deleted: [19] }));
  const sourceRows = [
    { owner: OWNER, chatId: CHAT }, { owner: OWNER, chatId: OTHER_CHAT },
    { owner: OTHER, chatId: CHAT }, { owner: OWNER, chatId: '-1000000860019' },
  ];
  for (const row of sourceRows) f.base.seedMessage({ ...row, messageId: 19, body: 'Fictional mirror scope marker' });
  f.base.sqlite.prepare("UPDATE chat_context_messages SET chat_type='channel' WHERE chat_id='-1000000860019'").run();
  const prepare = f.base.db.prepare.bind(f.base.db);
  const queries = [];
  t.mock.method(f.base.db, 'prepare', sql => {
    queries.push(sql);
    assert.doesNotMatch(sql, /SELECT[\s\S]*\bbody\b/i);
    return prepare(sql);
  });
  await sync(f, 'batch', f.batch(lease, { global_deleted: [19] }));
  assert.ok(queries.some(sql => /^DELETE FROM chat_context_messages/.test(sql)));
  const remaining = f.base.sqlite.prepare('SELECT owner_id,chat_id FROM chat_context_messages ORDER BY owner_id,chat_id').all();
  assert.deepEqual(remaining.map(row => [row.owner_id, row.chat_id]), [[OTHER, CHAT], [OWNER, '-1000000860019']]);
});

test('an unavailable tombstone lookup fails closed rather than exposing a failed-mirror Secretary message', async t => {
  const f = fixture(t); const lease = await enable(f);
  t.mock.method(console, 'error', () => {});
  f.base.seedMessage({ owner: OWNER, body: 'Fictional never expose on tombstone outage' });
  const { share } = await jsonResponse(await fetchWorker(f, f.base.request('/shares', {
    owner: OWNER, method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1 },
  })), 201);
  await sync(f, 'batch', f.batch(lease, { global_deleted: [1] }));
  f.base.seedMessage({ owner: OWNER, body: 'Fictional never expose on tombstone outage' });
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', sql => {
    if (sql.includes('FROM account_context_deleted_messages') && sql.includes('UNION')) throw new Error('Fictional tombstone DB outage');
    return prepare(sql);
  });
  const response = await fetchWorker(f, new Request(share.url));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('Fictional never expose on tombstone outage'));
});

test('known mirror rows_written is reconciled when an already-committed batch succeeds on retry', async t => {
  const f = fixture(t); const lease = await enable(f);
  t.mock.method(console, 'error', () => {});
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(1)] }));
  f.base.seedMessage({ owner: OWNER, body: 'Fictional mirrored cost message' });
  const baseline = f.control().quota_used;
  const original = f.base.db.batch.bind(f.base.db);
  let failing = true;
  t.mock.method(f.base.db, 'batch', async statements => {
    if (failing) throw new Error('Fictional mirror outage before metrics');
    const result = await original(statements);
    return result.map((row, index) => ({ ...row, meta: { ...row.meta, rows_written: index === 0 ? 200 : 0 } }));
  });
  const deletion = f.batch(lease, { deleted: [{ chat_id: CHAT, message_id: 1 }] });
  await sync(f, 'batch', deletion, 503);
  failing = false; await sync(f, 'batch', deletion);
  const receipt = f.sqlite.prepare('SELECT * FROM account_context_batches WHERE batch_id=?').get(deletion.batch_id);
  assert.ok(receipt.actual_rows_written >= 200, 'Mirror metrics must not be lost through the applied-receipt replay fast path');
  assert.ok(f.control().quota_used - baseline >= 200);
  const used = f.control().quota_used;
  await sync(f, 'batch', deletion);
  assert.equal(f.control().quota_used, used);
});

for (const order of ['zero-replay-first', 'positive-initial-first']) {
  test(`delayed positive mirror metrics and zero-change replay converge to one ledger: ${order}`, async t => {
    const f = fixture(t); const lease = await enable(f);
    await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(1)] }));
    f.base.seedMessage({ owner: OWNER, body: 'Fictional delayed mirror metrics' });
    const baseline = f.control().quota_used;
    const archiveWrites = 140, mirrorWrites = 200;
    const archiveBatch = f.db.batch.bind(f.db);
    let firstArchive = true;
    t.mock.method(f.db, 'batch', async statements => {
      const result = await archiveBatch(statements);
      if (!firstArchive) return result;
      firstArchive = false;
      return result.map((row, index) => ({ ...row, meta: { ...row.meta, rows_written: index === 0 ? archiveWrites : 0 } }));
    });
    let initialReady, replayReady, releaseInitial, releaseReplay;
    const initialReached = new Promise(resolve => { initialReady = resolve; });
    const replayReached = new Promise(resolve => { replayReady = resolve; });
    const initialGate = new Promise(resolve => { releaseInitial = resolve; });
    const replayGate = new Promise(resolve => { releaseReplay = resolve; });
    const mirrorBatch = f.base.db.batch.bind(f.base.db);
    let mirrorCalls = 0;
    t.mock.method(f.base.db, 'batch', async statements => {
      const call = ++mirrorCalls;
      const result = await mirrorBatch(statements);
      assert.ok(call <= 2, 'Settled identical replays must not execute another mirror DELETE');
      assert.equal(result.reduce((sum, row) => sum + row.meta.changes, 0), call === 1 ? 1 : 0);
      // The first DELETE has committed, but its positive metric response is still in flight.
      if (call === 1) { initialReady(); await initialGate; }
      else { replayReady(); await replayGate; }
      return result.map((row, index) => ({ ...row, meta: { ...row.meta, rows_written: index === 0 && call === 1 ? mirrorWrites : 0 } }));
    });
    const body = f.batch(lease, { deleted: [{ chat_id: CHAT, message_id: 1 }] });
    const initial = sync(f, 'batch', body);
    let replay;
    try {
      await Promise.race([initialReached, initial.then(() => assert.fail('Initial request acknowledged before its mirror result'))]);
      const receipt = f.sqlite.prepare('SELECT * FROM account_context_batches WHERE batch_id=?').get(body.batch_id);
      assert.equal(receipt.archive_rows_written, archiveWrites);
      assert.equal(receipt.actual_rows_written, null);
      replay = sync(f, 'batch', body);
      await Promise.race([replayReached, replay.then(() => assert.fail('Concurrent replay skipped the unfinished mirror'))]);
      if (order === 'zero-replay-first') {
        releaseReplay(); await replay;
        assert.equal(f.control().quota_used - baseline, archiveWrites);
        releaseInitial(); await initial;
      } else {
        releaseInitial(); await initial;
        assert.equal(f.control().quota_used - baseline, archiveWrites + mirrorWrites);
        releaseReplay(); await replay;
      }
    } finally {
      releaseInitial(); releaseReplay();
      await Promise.allSettled([initial, ...(replay ? [replay] : [])]);
    }
    const receipt = { ...f.sqlite.prepare('SELECT * FROM account_context_batches WHERE batch_id=?').get(body.batch_id) };
    assert.equal(receipt.archive_rows_written, archiveWrites);
    assert.equal(receipt.mirror_rows_written, mirrorWrites);
    assert.equal(receipt.actual_rows_written, archiveWrites + mirrorWrites);
    assert.equal(receipt.quota_charged, archiveWrites + mirrorWrites);
    assert.equal(receipt.quota_charged_day, NOW.slice(0, 10));
    assert.equal(f.control().quota_used - baseline, archiveWrites + mirrorWrites);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_context_messages').get().n, 0);
    assert.equal(f.base.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_context_messages').get().n, 0);
    const control = { ...f.control() };
    const settled = await Promise.all(Array.from({ length: 4 }, () => sync(f, 'batch', body)));
    assert.ok(settled.every(reply => reply.quota_remaining === 10000 - control.quota_used));
    assert.equal(mirrorCalls, 2);
    assert.deepEqual({ ...f.control() }, control);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM account_context_batches WHERE batch_id=?').get(body.batch_id) }, receipt);
  });
}

test('late initial archive metrics correct a zero-metric completed replay without another mirror or double charge', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message(1)] }));
  const baseline = f.control().quota_used;
  const archiveWrites = 200;
  let committed, release;
  const reached = new Promise(resolve => { committed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const archiveBatch = f.db.batch.bind(f.db);
  let delayed = false;
  t.mock.method(f.db, 'batch', async statements => {
    const result = await archiveBatch(statements);
    if (delayed) return result;
    delayed = true;
    committed(); await gate;
    return result.map((row, index) => ({ ...row, meta: { ...row.meta, rows_written: index === 0 ? archiveWrites : 0 } }));
  });
  const mirrorBatch = f.base.db.batch.bind(f.base.db);
  let mirrorCalls = 0;
  t.mock.method(f.base.db, 'batch', async statements => {
    mirrorCalls++;
    const result = await mirrorBatch(statements);
    assert.equal(result.reduce((sum, row) => sum + row.meta.changes, 0), 0);
    return result.map(row => ({ ...row, meta: { ...row.meta, rows_written: 0 } }));
  });
  const body = f.batch(lease, { deleted: [{ chat_id: CHAT, message_id: 1 }] });
  const initial = sync(f, 'batch', body);
  try {
    await Promise.race([reached, initial.then(() => assert.fail('Expected delayed archive metric response'))]);
    await sync(f, 'batch', body);
    assert.equal(f.control().quota_used - baseline, cost(body));
  } finally { release(); await initial; }
  const receipt = f.sqlite.prepare('SELECT * FROM account_context_batches WHERE batch_id=?').get(body.batch_id);
  assert.equal(receipt.archive_rows_written, archiveWrites);
  assert.equal(receipt.mirror_rows_written, 0);
  assert.equal(receipt.actual_rows_written, archiveWrites);
  assert.equal(receipt.quota_charged, archiveWrites);
  assert.equal(f.control().quota_used - baseline, archiveWrites);
  const used = f.control().quota_used;
  await sync(f, 'batch', body);
  assert.equal(f.control().quota_used, used);
  assert.equal(mirrorCalls, 1);
});

test('canonical account chat IDs enforce signed64 strings, no leading zeros and the peer-type namespace', async t => {
  const f = fixture(t); const lease = await enable(f);
  const before = { ...f.control() };
  for (const [chat_type, chat_id] of [
    ['private', '-1'], ['bot', '-830001'], ['saved', '-1000000830001'],
    ['group', '830001'], ['group', '-1000000000000'], ['group', '-1000000860004'],
    ['channel', '830001'], ['channel', '-860004'], ['supergroup', '-999999999999'],
    ['private', '0'], ['group', '-0'], ['private', '0830001'], ['group', '-0860003'],
    ['channel', '-01000000860004'], ['private', '9223372036854775808'], ['channel', '-9223372036854775809'],
  ]) {
    await sync(f, 'batch', f.batch(lease, { dialogs: [dialog({ chat_type, chat_id })] }), 400);
    assert.deepEqual({ ...f.control() }, before);
  }
  const valid = [
    ['private', '9223372036854775807'], ['group', '-999999999999'],
    ['channel', '-1009007199254740993'], ['supergroup', '-9223372036854775808'],
  ];
  await sync(f, 'batch', f.batch(lease, { dialogs: valid.map(([chat_type, chat_id]) => dialog({ chat_type, chat_id })),
    messages: valid.map(([, chat_id]) => message(1, { chat_id })) }));
  assert.deepEqual(stored(f, 'account_context_messages').map(row => row.chat_id), valid.map(([, id]) => id));
});

test('a privacy gap persists with zero ingest credits and a full state cursor without losing old checkpoints', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  const base = { v: 1, pts: 42, padding: '' };
  base.padding = 'x'.repeat(16384 - JSON.stringify(base).length);
  const oldState = JSON.stringify(base);
  assert.equal(oldState.length, 16384);
  f.sqlite.prepare('UPDATE account_context_sync SET quota_used=10000,update_state_json=? WHERE owner_id=?').run(oldState, OWNER);
  await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'reconciliation_required' });
  const row = f.control();
  assert.equal(row.update_state_json, oldState);
  assert.deepEqual(JSON.parse(row.reconciliation_json), { scope: 'global' });
  assert.equal(row.quota_used, 10000); assert.equal(row.lease_id, null);
  assert.equal(row.last_sync_at, null); assert.equal(row.dialogs_complete, 0);
  await sync(f, 'claim', {}, 409, SECOND_JOB);
  assert.equal((await privateApi(f, 'status')).status, 'reconciliation_required');
  assert.equal((await privateApi(f, 'chats')).chats.length, 1);
});

for (const scope of ['global', 'channel']) {
  test(`a ${scope} gap blocks affected private bodies, exports and existing links from both sources`, async t => {
    const f = fixture(t); const lease = await enable(f);
    f.base.seedMessage({ owner: OWNER, body: 'Fictional guarded Secretary marker' });
    await sync(f, 'batch', f.batch(lease, { dialogs: [dialog(), dialog({ chat_id: OTHER_CHAT })],
      messages: [message(), message(2, { chat_id: OTHER_CHAT })] }));
    const old = await jsonResponse(await fetchWorker(f, f.base.request('/shares', { owner: OWNER, method: 'POST',
      body: { chat_id: CHAT, limit: 1, ttl_hours: 1 } })), 201);
    const shared = await accountShare(f);
    await sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation,
      status: 'reconciliation_required', ...(scope === 'channel' ? { chat_id: CHAT } : {}) });
    await privateApi(f, `messages?chat_id=${CHAT}`, {}, 409);
    await privateApi(f, `export?chat_id=${CHAT}`, {}, 409);
    await privateApi(f, 'shares', { method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1, consent_confirmed: true } }, 409);
    for (const url of [shared.url, old.share.url]) {
      assert.doesNotMatch(await readPublic(f, url, 503), /Fictional/);
      assert.equal(await readPublic(f, url, 503, 'HEAD'), '');
    }
    if (scope === 'channel') {
      assert.equal((await privateApi(f, `messages?chat_id=${OTHER_CHAT}`)).messages.length, 1);
      assert.equal(f.sqlite.prepare('SELECT history_status FROM account_context_chats WHERE owner_id=? AND chat_id=?').get(OWNER, CHAT).history_status, 'paused');
    } else await privateApi(f, `messages?chat_id=${OTHER_CHAT}`, {}, 409);
    assert.equal((await privateApi(f, 'chats')).chats.length, 2);
  });
}

test('legacy reconciliation flags and unavailable histories deny bodies without leaking them through old shares', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  f.sqlite.prepare("UPDATE account_context_chats SET history_status='unavailable' WHERE owner_id=?").run(OWNER);
  await privateApi(f, `messages?chat_id=${CHAT}`, {}, 409);
  f.sqlite.prepare("UPDATE account_context_chats SET history_status='loading' WHERE owner_id=?").run(OWNER);
  f.sqlite.prepare('UPDATE account_context_sync SET update_state_json=? WHERE owner_id=?')
    .run(JSON.stringify({ reconciliation_required: { scope: 'global' } }), OWNER);
  await privateApi(f, `messages?chat_id=${CHAT}`, {}, 409);
  await sync(f, 'claim', {}, 409);
});

test('a lease expiring while the privacy stop waits cannot change its control row or another chat', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  const old = { ...f.control() }, chats = stored(f, 'account_context_chats');
  const hold = holdNextBatch(t, f);
  const response = sync(f, 'finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'reconciliation_required', chat_id: CHAT }, 409);
  await hold.reached;
  t.mock.timers.setTime(Date.parse(lease.lease_until)); hold.release();
  await response;
  assert.deepEqual({ ...f.control() }, old);
  assert.deepEqual(stored(f, 'account_context_chats'), chats);
});

test('the archive-share insert rechecks a gap that appeared after preliminary validation', async t => {
  const f = fixture(t); const lease = await enable(f);
  await sync(f, 'batch', f.batch(lease, { dialogs: [dialog()], messages: [message()] }));
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', sql => {
    const result = prepare(sql);
    if (!sql.startsWith('INSERT INTO context_shares')) return result;
    const bind = result.bind.bind(result);
    result.bind = (...values) => {
      const bound = bind(...values), run = bound.run.bind(bound);
      bound.run = async () => {
        f.sqlite.prepare('UPDATE account_context_sync SET reconciliation_json=? WHERE owner_id=?').run('{"scope":"global"}', OWNER);
        return run();
      };
      return bound;
    };
    return result;
  });
  await privateApi(f, 'shares', { method: 'POST', body: { chat_id: CHAT, limit: 1, ttl_hours: 1, consent_confirmed: true } }, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM context_shares').get().n, 0);
});
