import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackTaskDraft,
  normalizeTaskDraft,
  taskAppUrl,
  validateTaskPayload,
  validateTelegramInitData,
} from "../cloudflare-worker/src/tasks.js";

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(botToken, user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(user),
  });
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  params.set("hash", hex(await hmac(secret, dataCheck)));
  return params.toString();
}

test("fallback parser keeps text and infers predefined flags", () => {
  const draft = fallbackTaskDraft("Срочно подготовить модель Revit для проекта.");
  assert.equal(draft.title, "Срочно подготовить модель Revit для проекта");
  assert.deepEqual(draft.flags, ["urgent", "gcod", "work"]);
});

test("AI result is normalized and unknown flags are removed", () => {
  const draft = normalizeTaskDraft(
    {
      title: "  Подготовить отчёт  ",
      description: "Передать заказчику",
      due_at: "2026-08-25T15:00:00+03:00",
      flags: ["work", "unknown", "urgent", "work"],
    },
    "Подготовить отчёт",
  );
  assert.equal(draft.title, "Подготовить отчёт");
  assert.equal(draft.due_at, "2026-08-25T12:00:00.000Z");
  assert.deepEqual(draft.flags, ["work", "urgent"]);
});

test("Mini App URL can target a draft", () => {
  const url = taskAppUrl({ TASKS_APP_URL: "https://example.com/tasks/" }, "task-id");
  assert.equal(url, "https://example.com/tasks/?task=task-id");
});

test("task API payload validates required fields and partial updates", () => {
  assert.deepEqual(validateTaskPayload({ title: "Позвонить", flags: ["personal"] }), {
    title: "Позвонить",
    description: "",
    due_at: null,
    flags: ["personal"],
  });
  assert.deepEqual(validateTaskPayload({ status: "done" }, { partial: true }), {
    status: "done",
  });
  assert.throws(
    () => validateTaskPayload({ status: "draft" }, { partial: true }),
    /Некорректный статус/,
  );
});

test("Telegram Mini App initData accepts a valid signature", async () => {
  const botToken = "123456:TEST-TOKEN";
  const user = { id: 1839693017, first_name: "Антон" };
  const initData = await signedInitData(botToken, user);
  assert.deepEqual(await validateTelegramInitData(initData, botToken), user);

  const tampered = new URLSearchParams(initData);
  tampered.set("user", JSON.stringify({ id: 1839693017, first_name: "Иван" }));
  assert.equal(await validateTelegramInitData(tampered.toString(), botToken), null);
});

test("Telegram Mini App initData rejects an expired authorization", async () => {
  const botToken = "123456:TEST-TOKEN";
  const initData = await signedInitData(
    botToken,
    { id: 1839693017 },
    Math.floor(Date.now() / 1000) - 1000,
  );
  assert.equal(await validateTelegramInitData(initData, botToken, 60), null);
});
