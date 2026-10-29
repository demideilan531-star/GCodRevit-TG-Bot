import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyAccountService } from '../cloudflare-worker/src/account-service-auth.js';
import { handleAccountSyncApi, handleAccountArchiveApi } from '../cloudflare-worker/src/account-context.js';
import { createSqliteD1 } from './sport-db-fixture.mjs';
import { createContextFixture, CONTEXT_ADMIN as OWNER, CONTEXT_NOW as NOW, CONTEXT_ORIGIN as ORIGIN } from './context-db-fixture.mjs';

const SECRET = '1'.repeat(64);
const SERVICE = 'fictional-collector';
const RUN = '11111111-1111-4111-8111-111111111111';
const env = { TELEGRAM_ACCOUNT_SERVICE_ENABLED: 'true', TELEGRAM_ACCOUNT_SERVICE_SECRET: SECRET, TELEGRAM_ACCOUNT_SERVICE_ID: SERVICE };
const hash = body => createHash('sha256').update(body).digest('hex');

function signed(path = 'claim', body = '{}', changes = {}) {
  const time = String(Math.floor(Date.parse(NOW) / 1000));
  const pathname = `/internal/account-context/${path}`;
  const canonical = ['context-service:v1', 'POST', pathname, SERVICE, RUN, time, hash(body)].join('\n');
  return new Request(ORIGIN + pathname, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'X-Context-Service': SERVICE, 'X-Context-Run': RUN,
    'X-Context-Timestamp': time, Authorization: 'Context-HMAC ' + createHmac('sha256', Buffer.from(SECRET, 'hex')).update(canonical).digest('hex'), ...changes,
  } });
}

test('service signatures are body-bound, narrowly scoped and isolated from GitHub runs', async () => {
  assert.deepEqual(await verifyAccountService(signed(), env, hash('{}'), Date.parse(NOW)), { run: `service:${SERVICE}:${RUN}` });
  assert.equal(await verifyAccountService(signed(), env, hash('{"changed":1}'), Date.parse(NOW)), null);
  assert.equal(await verifyAccountService(signed('unknown'), env, hash('{}'), Date.parse(NOW)), null);
  assert.equal(await verifyAccountService(signed(), env, hash('{}'), Date.parse(NOW) + 61000), null);
  assert.equal(await verifyAccountService(signed(), env, hash('{}'), Date.parse(NOW) - 61000), null);
});

test('service auth is disabled by default and requires exact configured identity/key', async () => {
  for (const options of [{}, { ...env, TELEGRAM_ACCOUNT_SERVICE_ENABLED: 'false' },
    { ...env, TELEGRAM_ACCOUNT_SERVICE_ID: 'another-collector' },
    { ...env, TELEGRAM_ACCOUNT_SERVICE_SECRET: '2'.repeat(64) },
    { ...env, TELEGRAM_ACCOUNT_SERVICE_SECRET: 'weak' }]) {
    assert.equal(await verifyAccountService(signed(), options, hash('{}'), Date.parse(NOW)), null);
  }
});

test('service auth rejects path, query, timestamp, run and algorithm substitution', async () => {
  for (const changes of [{ 'X-Context-Run': 'not-a-uuid' }, { 'X-Context-Service': 'other' },
    { 'X-Context-Timestamp': '0000000000' }, { Authorization: 'Bearer not-an-hmac' },
    { Authorization: 'Context-HMAC ' + '0'.repeat(64) }]) {
    assert.equal(await verifyAccountService(signed('claim', '{}', changes), env, hash('{}'), Date.parse(NOW)), null);
  }
  const request = signed();
  assert.equal(await verifyAccountService(new Request(request.url + '?extra=1', request), env, hash('{}'), Date.parse(NOW)), null);
});

test('signed service can claim and finish only after private owner consent; pause fences it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  t.mock.method(globalThis, 'fetch', () => assert.fail('No live requests in service tests'));
  const base = createContextFixture(t);
  const archive = createSqliteD1(t, { migrations: [] });
  archive.sqlite.exec(readFileSync(new URL('../cloudflare-worker/account-migrations/0001_create_account_archive.sql', import.meta.url), 'utf8'));
  archive.sqlite.function('strftime', { varargs: true }, () => new Date().toISOString());
  const options = { ...base.env, ...env, TELEGRAM_ACCOUNT_SYNC_ENABLED: 'true', TELEGRAM_ACCOUNT_OWNER_ID: OWNER, ACCOUNT_CONTEXT_DB: archive.db };
  const post = async (endpoint, body = {}) => handleAccountSyncApi(signed(endpoint, JSON.stringify(body)), options);
  assert.equal((await post('claim')).status, 409);
  const consent = await handleAccountArchiveApi(base.request('/account/enable', { method: 'POST', body: { confirmed: true, account_id: OWNER } }), options, { id: OWNER });
  assert.equal(consent.status, 200);
  const response = await post('claim');
  assert.equal(response.status, 200);
  const lease = await response.json();
  assert.equal(lease.owner_id, OWNER);
  assert.equal((await post('state', { lease_id: lease.lease_id, generation: lease.generation })).status, 200);
  const heartbeat = await post('heartbeat', { lease_id: lease.lease_id, generation: lease.generation });
  assert.deepEqual(Object.keys(await heartbeat.json()).sort(), ['ok', 'quota_remaining']);
  const pause = await handleAccountArchiveApi(base.request('/account/pause', { method: 'POST', body: {} }), options, { id: OWNER });
  assert.equal(pause.status, 200);
  assert.equal((await post('finish', { lease_id: lease.lease_id, generation: lease.generation, status: 'idle' })).status, 409);
  assert.equal((await post('heartbeat', { lease_id: lease.lease_id, generation: lease.generation })).status, 409);
});

test('invalid service signature is rejected before any database operation', async t => {
  const options = { ...env, TELEGRAM_ACCOUNT_SYNC_ENABLED: 'true', TELEGRAM_ACCOUNT_OWNER_ID: OWNER,
    TELEGRAM_ADMIN_IDS: OWNER, ACCOUNT_CONTEXT_DB: { prepare() { assert.fail('Unauthorized database access'); } } };
  const response = await handleAccountSyncApi(signed('claim', '{}', { Authorization: 'Context-HMAC ' + '0'.repeat(64) }), options);
  assert.equal(response.status, 401);
});
