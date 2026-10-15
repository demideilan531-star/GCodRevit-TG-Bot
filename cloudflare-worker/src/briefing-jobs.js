import { getAssistantAccess } from "./access.js";

const TTL_MS = 20 * 60 * 1000;
const FAILED = "Не удалось собрать брифинг. Попробуй нажать кнопку ещё раз.";

function response(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authorized(request, env) {
  const expected = `Bearer ${env.GMAIL_BROKER_TOKEN || ""}`;
  const actual = request.headers.get("Authorization") || "";
  if (!env.GMAIL_BROKER_TOKEN || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}

async function fail(env, id, telegramApi) {
  const row = await env.TASKS_DB.prepare("SELECT * FROM briefing_requests WHERE id = ?")
    .bind(id).first();
  if (!row || !["pending", "claimed"].includes(row.status)) return;
  await env.TASKS_DB.prepare(
    "UPDATE briefing_requests SET status = 'failed', completed_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), id).run();
  if (row.message_id) await telegramApi(env, "editMessageText", {
    chat_id: row.chat_id, message_id: row.message_id, text: FAILED,
  });
}

export async function queueBriefing(env, message, helpers) {
  const { sendMessage, telegramApi, dispatchWorkflow, ctx } = helpers;
  const now = new Date();
  const ownerId = String(message.from.id);
  await env.TASKS_DB.prepare(
    "DELETE FROM briefing_requests WHERE expires_at < ? AND status IN ('completed', 'failed')",
  ).bind(now.toISOString()).run();
  // Expired jobs release the unique per-owner slot; private task content is never stored here.
  await env.TASKS_DB.prepare(
    "UPDATE briefing_requests SET status = 'failed', completed_at = ? WHERE expires_at <= ? AND status IN ('pending', 'claimed')",
  ).bind(now.toISOString(), now.toISOString()).run();
  const id = crypto.randomUUID();
  const inserted = await env.TASKS_DB.prepare(
    `INSERT OR IGNORE INTO briefing_requests (id, owner_id, chat_id, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).bind(id, ownerId, String(message.chat.id), now.toISOString(), new Date(now.getTime() + TTL_MS).toISOString()).run();
  if (!inserted.meta?.changes) {
    await sendMessage(env, message.chat.id, "Предыдущий брифинг ещё собирается.");
    return;
  }
  try {
    const sent = await sendMessage(env, message.chat.id, "Собираю погоду и задачи в один брифинг…");
    const messageId = sent?.result?.message_id;
    if (!messageId) throw new Error("No placeholder message ID");
    await env.TASKS_DB.prepare("UPDATE briefing_requests SET message_id = ? WHERE id = ?")
      .bind(messageId, id).run();
    ctx.waitUntil(dispatchWorkflow(id).catch(async () => {
      await fail(env, id, telegramApi);
      console.error("Morning briefing dispatch failed");
    }));
  } catch {
    await fail(env, id, telegramApi);
    console.error("Morning briefing queue failed");
  }
}

export async function handleBriefingBrokerApi(request, env, { telegramApi, collectBriefingTasks }) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/internal/briefing/")) return null;
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  if (!authorized(request, env)) return response({ error: "Forbidden" }, 403);
  if (!["/internal/briefing/claim", "/internal/briefing/complete"].includes(path)) {
    return response({ error: "Not found" }, 404);
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 1024) return response({ error: "Too large" }, 413);
    const body = JSON.parse(text);
    const id = String(body.request_id || "");
    const row = await env.TASKS_DB.prepare("SELECT * FROM briefing_requests WHERE id = ?")
      .bind(id).first();
    if (!row || row.expires_at <= new Date().toISOString()) return response({ error: "Unavailable" }, 404);
    const access = await getAssistantAccess(env, { id: row.owner_id });
    if (!access) return response({ error: "Forbidden" }, 403);
    if (path.endsWith("/complete")) {
      if (row.status !== "claimed") return response({ error: "Already completed" }, 409);
      if (body.success !== true) await fail(env, id, telegramApi);
      else await env.TASKS_DB.prepare(
        "UPDATE briefing_requests SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'claimed'",
      ).bind(new Date().toISOString(), id).run();
      return response({ ok: true });
    }
    if (!row.message_id || row.status !== "pending") return response({ error: "Already claimed" }, 409);
    const result = await env.TASKS_DB.prepare(
      "UPDATE briefing_requests SET status = 'claimed' WHERE id = ? AND status = 'pending'",
    ).bind(id).run();
    if (!result.meta?.changes) return response({ error: "Already claimed" }, 409);
    const now = new Date();
    let tasks;
    try {
      tasks = await collectBriefingTasks(env, { ownerId: row.owner_id, access, now });
    } catch {
      tasks = { unavailable: "Не удалось загрузить задачи." };
    }
    return response({
      request_id: id, chat_id: row.chat_id, message_id: row.message_id,
      generated_at: now.toISOString(), expires_at: row.expires_at,
      can_weather: access.canWeather, tasks,
    });
  } catch {
    console.error("Morning briefing broker failed");
    return response({ error: "Broker request failed" }, 500);
  }
}
