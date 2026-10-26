import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyContextJob } from '../cloudflare-worker/src/github-oidc.js';
import { createContextFixture, CONTEXT_OWNER, CONTEXT_CHAT } from './context-db-fixture.mjs';
import { createSqliteD1 } from './sport-db-fixture.mjs';

const require = createRequire(new URL('../cloudflare-worker/package.json', import.meta.url));
const { SignJWT, generateKeyPair } = await import(pathToFileURL(require.resolve('jose')).href);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const env = {
  GITHUB_REPOSITORY: 'fictional-owner/fictional-repository',
  TELEGRAM_CONTEXT_REPOSITORY_ID: '910001',
  TELEGRAM_CONTEXT_OIDC_AUDIENCE: 'https://context.example.test/internal/account-sync',
};

async function signedJob(overrides = {}, { key = privateKey, alg = 'RS256', omit = [] } = {}) {
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
  const jwt = await new SignJWT(payload).setProtectedHeader({ alg }).sign(key);
  return new Request('https://context.example.test/internal/account-sync', { headers: { Authorization: `Bearer ${jwt}` } });
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
