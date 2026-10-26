import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyContextJob } from '../cloudflare-worker/src/github-oidc.js';
import { createContextFixture, CONTEXT_OWNER, CONTEXT_CHAT } from './context-db-fixture.mjs';
import { createSqliteD1 } from './sport-db-fixture.mjs';

const require = createRequire(new URL('../cloudflare-worker/package.json', import.meta.url));
const { SignJWT, UnsecuredJWT, createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair } = await import(pathToFileURL(require.resolve('jose')).href);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(publicKey), kid: 'fictional-primary', alg: 'RS256', use: 'sig' };
const env = {
  GITHUB_REPOSITORY: 'fictional-owner/fictional-repository',
  TELEGRAM_CONTEXT_REPOSITORY_ID: '910001',
  TELEGRAM_CONTEXT_OIDC_AUDIENCE: 'https://context.example.test/internal/account-sync',
};

async function signedJob(overrides = {}, { key = privateKey, alg = 'RS256', omit = [], header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://token.actions.githubusercontent.com', aud: env.TELEGRAM_CONTEXT_OIDC_AUDIENCE,
    iat: now, nbf: now - 1, exp: now + 300, jti: 'fictional-job-token',
    repository: env.GITHUB_REPOSITORY, repository_id: env.TELEGRAM_CONTEXT_REPOSITORY_ID,
    ref: 'refs/heads/main', event_name: 'workflow_dispatch', run_id: '920001', run_attempt: '1',
    workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/telegram-context-sync.yml@refs/heads/main`,
    ...overrides,
  };
  for (const name of omit) delete payload[name];
  const jwt = await new SignJWT(payload).setProtectedHeader({ alg, ...header }).sign(key);
  return new Request('https://context.example.test/internal/account-sync', { headers: { Authorization: `Bearer ${jwt}` } });
}

function offline(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('OIDC foundation tests must never use a network JWKS'));
}

function requestWithToken(token, scheme = 'Bearer') {
  return new Request('https://context.example.test/internal/account-sync', { headers: { Authorization: `${scheme} ${token}` } });
}

test('account sync OIDC accepts only the signed, configured workflow identity', async () => {
  assert.deepEqual(await verifyContextJob(await signedJob(), env, publicKey), { run: '920001:1' });
  assert.deepEqual(await verifyContextJob(await signedJob({ event_name: 'schedule' }), env, publicKey), { run: '920001:1' });
  for (const overrides of [
    { iss: 'https://attacker.example.test' }, { aud: 'another-service' },
    { repository: 'foreign/repository' }, { repository_id: '910002' },
    { ref: 'refs/heads/feature' }, { event_name: 'pull_request' }, { event_name: 'pull_request_target' },
    { workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/untrusted.yml@refs/heads/main` },
    { run_id: '../920001' }, { run_attempt: 'not-a-number' },
  ]) assert.equal(await verifyContextJob(await signedJob(overrides), env, publicKey), null, JSON.stringify(overrides));
});

test('account sync OIDC rejects expiry, missing claims, forged signatures and missing configuration', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { iat: now - 1000, nbf: now - 1000, exp: now - 60 },
    { iat: now + 120, nbf: now + 120, exp: now + 300 },
    { iat: now, exp: now + 3600 },
  ]) assert.equal(await verifyContextJob(await signedJob(overrides), env, publicKey), null);
  for (const claim of ['exp', 'iat', 'nbf', 'jti', 'repository_id', 'workflow_ref', 'run_id', 'run_attempt']) {
    assert.equal(await verifyContextJob(await signedJob({}, { omit: [claim] }), env, publicKey), null, claim);
  }
  const otherKeys = await generateKeyPair('RS256');
  assert.equal(await verifyContextJob(await signedJob({}, { key: otherKeys.privateKey }), env, publicKey), null);
  const hmacKey = crypto.getRandomValues(new Uint8Array(32));
  assert.equal(await verifyContextJob(await signedJob({}, { key: hmacKey, alg: 'HS256' }), env, publicKey), null);
  for (const name of Object.keys(env)) {
    const missing = { ...env }; delete missing[name];
    assert.equal(await verifyContextJob(await signedJob(), missing, publicKey), null, name);
  }
  assert.equal(await verifyContextJob(new Request('https://context.example.test'), env, publicKey), null);
  assert.equal(await verifyContextJob(new Request('https://context.example.test', { headers: { Authorization: `Bearer ${'A'.repeat(17000)}` } }), env, publicKey), null);
});

test('account sync OIDC uses injected local JWKS and selects the exact signing kid without network', async t => {
  offline(t);
  const other = await generateKeyPair('RS256');
  const secondary = { ...await exportJWK(other.publicKey), kid: 'fictional-secondary', alg: 'RS256', use: 'sig' };
  const resolve = createLocalJWKSet({ keys: [secondary, publicJwk] });
  const calls = [];
  const keySet = async (...args) => { calls.push(args[0]); return resolve(...args); };
  const request = await signedJob({}, { header: { kid: publicJwk.kid } });
  assert.deepEqual(await verifyContextJob(request, env, keySet), { run: '920001:1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kid, publicJwk.kid);
  assert.equal(calls[0].alg, 'RS256');
  assert.equal(await verifyContextJob(await signedJob({}, { header: { kid: 'fictional-unknown' } }), env, keySet), null);
  assert.equal(await verifyContextJob(await signedJob({}, { key: other.privateKey, header: { kid: publicJwk.kid } }), env, keySet), null);
  assert.deepEqual(await verifyContextJob(await signedJob({}, { key: other.privateKey, header: { kid: secondary.kid } }), env, keySet), { run: '920001:1' });
});

test('account sync OIDC fails closed for unusable, ambiguous or malformed injected JWKS', async t => {
  offline(t);
  const request = await signedJob({}, { header: { kid: publicJwk.kid } });
  for (const keys of [
    [], [{ ...publicJwk, kid: 'fictional-other' }],
    [{ ...publicJwk, alg: 'RS512' }], [{ ...publicJwk, use: 'enc' }],
    [{ ...publicJwk, key_ops: ['encrypt'] }],
    [publicJwk, { ...publicJwk }],
    [{ kty: 'EC', kid: publicJwk.kid, crv: 'P-256', x: 'invalid', y: 'invalid', alg: 'RS256' }],
  ]) {
    assert.equal(await verifyContextJob(request, env, createLocalJWKSet({ keys })), null);
  }
  for (const malformed of [{}, { keys: null }, { keys: 'not-an-array' }]) {
    const keySet = (...args) => createLocalJWKSet(malformed)(...args);
    assert.equal(await verifyContextJob(request, env, keySet), null);
  }
});

test('account sync OIDC ignores attacker-supplied key URLs and embedded keys instead of changing trust roots', async t => {
  offline(t);
  const attacker = await generateKeyPair('RS256');
  const attackerJwk = { ...await exportJWK(attacker.publicKey), kid: 'fictional-attacker' };
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  const untrustedHeaders = {
    kid: publicJwk.kid, jku: 'https://untrusted.example.test/jwks.json',
    x5u: 'https://untrusted.example.test/certificate', jwk: attackerJwk,
  };
  assert.equal(await verifyContextJob(await signedJob({}, { key: attacker.privateKey, header: untrustedHeaders }), env, keySet), null);
  assert.deepEqual(await verifyContextJob(await signedJob({}, { header: untrustedHeaders }), env, keySet), { run: '920001:1' });
});

test('account sync OIDC returns only a run identity and neither logs nor throws resolver failures', async t => {
  offline(t);
  const request = await signedJob({}, { header: { kid: publicJwk.kid } });
  const logs = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  const failure = new Error('Fictional JWKS outage; this text must not be logged');
  for (const keySet of [async () => { throw failure; }, () => { throw failure; }, async () => null]) {
    assert.equal(await verifyContextJob(request, env, keySet), null);
  }
  const verified = await verifyContextJob(await signedJob({
    arbitrary_private_field: 'Fictional metadata must not become receiver authorization', owner_id: '999999',
  }), env, createLocalJWKSet({ keys: [publicJwk] }));
  assert.deepEqual(verified, { run: '920001:1' });
  assert.deepEqual(logs, []);
});

test('account sync OIDC rejects missing identity claims and malformed numeric dates with a real local signature', async t => {
  offline(t);
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  for (const claim of ['iss', 'aud', 'repository', 'repository_id', 'ref', 'workflow_ref', 'event_name', 'run_id', 'run_attempt']) {
    assert.equal(await verifyContextJob(await signedJob({}, { omit: [claim], header: { kid: publicJwk.kid } }), env, keySet), null, claim);
  }
  for (const overrides of [
    { exp: '9999999999' }, { exp: null }, { iat: 'now' }, { iat: null },
    { nbf: '0' }, { nbf: null }, { aud: [] }, { aud: ['foreign-audience'] },
    { repository_id: 910001 }, { ref: 'refs/tags/main' }, { ref: 'refs/pull/1/merge' },
    { workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/telegram-context-sync.yml@refs/heads/feature` },
    { event_name: 'push' }, { event_name: 'workflow_run' }, { run_id: '-1' }, { run_attempt: '1.5' },
  ]) {
    assert.equal(await verifyContextJob(await signedJob(overrides, { header: { kid: publicJwk.kid } }), env, keySet), null, JSON.stringify(overrides));
  }
});

test('account sync OIDC enforces age, not-before, expiry skew and maximum issued lifetime deterministically', async t => {
  offline(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T09:00:00.000Z') });
  const now = Date.now() / 1000;
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  for (const overrides of [
    { iat: now - 631, nbf: now - 631, exp: now + 100 },
    { nbf: now + 31 }, { iat: now + 31 },
    { iat: now - 100, nbf: now - 100, exp: now - 30 },
    { iat: now, exp: now + 901 },
  ]) assert.equal(await verifyContextJob(await signedJob(overrides, { header: { kid: publicJwk.kid } }), env, keySet), null, JSON.stringify(overrides));
  for (const overrides of [
    { iat: now - 100, nbf: now - 100, exp: now - 29 },
    { nbf: now + 29 }, { iat: now, exp: now + 900 },
  ]) assert.deepEqual(await verifyContextJob(await signedJob(overrides, { header: { kid: publicJwk.kid } }), env, keySet), { run: '920001:1' });
});

test('account sync OIDC rejects unsigned, corrupted, alternate-algorithm and non-Bearer tokens offline', async t => {
  offline(t);
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  const signed = await signedJob({}, { header: { kid: publicJwk.kid } });
  const token = signed.headers.get('Authorization').slice(7);
  const [header, payload, signature] = token.split('.');
  const changedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), repository_id: '910002' })).toString('base64url');
  const changedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  for (const malformed of [
    '', 'not-a-jwt', `${header}.${payload}`, `${header}.${payload}.${signature}.extra`,
    `${header}.${changedPayload}.${signature}`, `${header}.${payload}.${changedSignature}`,
    new UnsecuredJWT(decodeJwt(token)).encode(),
  ]) assert.equal(await verifyContextJob(requestWithToken(malformed), env, keySet), null);
  const alternate = await generateKeyPair('PS256');
  assert.equal(await verifyContextJob(await signedJob({}, { key: alternate.privateKey, alg: 'PS256' }), env, alternate.publicKey), null);
  for (const scheme of ['Basic', 'bearer', 'Token']) assert.equal(await verifyContextJob(requestWithToken(token, scheme), env, keySet), null);
});

test('account sync OIDC missing configuration or invalid Authorization never invokes key resolution', async t => {
  offline(t);
  let calls = 0;
  const keySet = async () => { calls++; return publicKey; };
  const signed = await signedJob();
  for (const field of Object.keys(env)) {
    for (const value of [undefined, '']) {
      assert.equal(await verifyContextJob(signed, { ...env, [field]: value }, keySet), null);
    }
  }
  for (const authorization of ['', 'Basic fictional', `Bearer ${'A'.repeat(17000)}`]) {
    assert.equal(await verifyContextJob(new Request('https://context.example.test/internal/account-sync', {
      headers: { Authorization: authorization },
    }), env, keySet), null);
  }
  assert.equal(calls, 0);
});

test('draft account schema isolates old archive records from Secretary retention and keeps deduplication keys', t => {
  const fixture = createContextFixture(t);
  const archive = createSqliteD1(t, { migrations: [] });
  const sql = readFileSync(new URL('../cloudflare-worker/account-migrations/0001_create_account_archive.sql', import.meta.url), 'utf8');
  archive.sqlite.exec(sql);
  archive.sqlite.exec(sql);
  fixture.seedMessage({ messageId: 1, sentAt: '2015-01-01T00:00:00.000Z' });
  archive.sqlite.prepare(`INSERT INTO account_context_chats (owner_id,chat_id,chat_type,chat_title,updated_at)
    VALUES (?,?,'private','Fictional archive','2026-10-26T00:00:00.000Z')`).run(CONTEXT_OWNER, CONTEXT_CHAT);
  const insert = archive.sqlite.prepare(`INSERT INTO account_context_messages
    (owner_id,chat_id,message_id,sender_name,direction,content_type,body,sent_at,updated_at)
    VALUES (?,?,1,'Fictional participant','incoming','text','Fictional old message','2015-01-01T00:00:00.000Z','2026-10-26T00:00:00.000Z')`);
  insert.run(CONTEXT_OWNER, CONTEXT_CHAT);
  assert.throws(() => insert.run(CONTEXT_OWNER, CONTEXT_CHAT), /UNIQUE constraint/);
  assert.throws(() => insert.run('foreign-owner', CONTEXT_CHAT), /FOREIGN KEY constraint/);
  fixture.sqlite.exec("DELETE FROM chat_context_messages WHERE sent_at < '2026-09-26T00:00:00.000Z'");
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM chat_context_messages').get().n, 0);
  assert.equal(archive.sqlite.prepare('SELECT COUNT(*) AS n FROM account_context_messages').get().n, 1);
  assert.throws(() => fixture.sqlite.prepare('SELECT COUNT(*) FROM account_context_messages').get(), /no such table/);
  const info = archive.sqlite.prepare('PRAGMA table_info(account_context_sync)').all();
  const columns = info.map(row => row.name);
  for (const required of ['generation', 'lease_id', 'lease_run', 'lease_until', 'quota_day', 'quota_used', 'dialogs_complete', 'dialog_cursor_json', 'update_state_json', 'owner_confirmed_at']) assert.ok(columns.includes(required), required);
  assert.equal(String(info.find(row => row.name === 'enabled').dflt_value), '0');
  assert.ok(!/api_hash|auth_key|session_string|login_code|password|access_hash/i.test(sql));
});
