import assert from "node:assert/strict";
import test from "node:test";

import {
  adminIdSet,
  getAssistantAccess,
  normalizeTelegramUsername,
} from "../cloudflare-worker/src/access.js";
import {
  decryptGmailPassword,
  encryptGmailPassword,
  normalizeGmailAddress,
  normalizeGoogleAppPassword,
} from "../cloudflare-worker/src/personal-gmail.js";

test("Telegram usernames are normalized before allowlisting", () => {
  assert.equal(normalizeTelegramUsername(" @KillTist "), "killtist");
  assert.equal(normalizeTelegramUsername("bad name"), "");
  assert.equal(normalizeTelegramUsername("abc"), "");
});

test("configured administrator bypasses the user database", async () => {
  const env = { TELEGRAM_ADMIN_IDS: "1839693017,42" };
  assert.deepEqual([...adminIdSet(env)], ["1839693017", "42"]);
  const access = await getAssistantAccess(env, { id: 1839693017, username: "Owner" });
  assert.equal(access.role, "admin");
  assert.equal(access.canGmail, true);
});

test("Gmail onboarding accepts only an address and a 16-character app password", () => {
  assert.equal(normalizeGmailAddress(" User@Gmail.com "), "user@gmail.com");
  assert.equal(normalizeGmailAddress("not-an-email"), "");
  assert.equal(normalizeGoogleAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop");
  assert.equal(normalizeGoogleAppPassword("ordinary-password"), "");
});

test("Gmail app password is encrypted with owner and email binding", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const env = { GMAIL_CREDENTIALS_KEY: key };
  const encrypted = await encryptGmailPassword(
    env,
    "12345",
    "user@gmail.com",
    "abcdefghijklmnop",
  );
  assert.notEqual(encrypted.ciphertext, "abcdefghijklmnop");
  assert.equal(
    await decryptGmailPassword(env, {
      owner_id: "12345",
      email: "user@gmail.com",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
    }),
    "abcdefghijklmnop",
  );
  await assert.rejects(
    decryptGmailPassword(env, {
      owner_id: "another-user",
      email: "user@gmail.com",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
    }),
  );
});

