import { Buffer } from "node:buffer";

const BUTTON_TASK_CREATE = "➕ Задача";
const BUTTON_TASKS = "📅 Задачи";

export const TASK_FLAGS = [
  { id: "work", label: "Работа" },
  { id: "study", label: "Учёба" },
  { id: "gcod", label: "GCodRevit" },
  { id: "personal", label: "Личное" },
  { id: "urgent", label: "Срочно" },
];

const TASK_FLAG_IDS = new Set(TASK_FLAGS.map((flag) => flag.id));
const TASK_STATUSES = new Set(["draft", "todo", "in_progress", "done", "archived"]);
const DEFAULT_TIMEZONE = "Europe/Moscow";
const DEFAULT_APP_URL = "https://gcodrevit-telegram-bot.demideilan531.workers.dev/tasks/";
const MAX_BODY_BYTES = 12 * 1024;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_SUBTASKS = 20;

function tasksDb(env) {
  if (!env.TASKS_DB) {
    throw new Error("База задач TASKS_DB ещё не подключена.");
  }
  return env.TASKS_DB;
}

export function taskAppUrl(env, taskId = "") {
  const configured = String(env.TASKS_APP_URL || DEFAULT_APP_URL).trim();
  const url = new URL(configured);
  if (taskId) url.searchParams.set("task", taskId);
  return url.toString();
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function explicitlyRequestsUrgent(sourceText) {
  const text = String(sourceText || "");
  if (/(?:не|без)\s+(?:нужно\s+|надо\s+|ставь\s+|добавляй\s+)?срочн/i.test(text)) {
    return false;
  }
  return /(срочн|немедленно|флаж\w*\s+[«"']?срочн|помет\w*\s+как\s+срочн)/i.test(text);
}

function normalizeFlags(value, sourceText = "", { allowUrgent = false } = {}) {
  const flags = Array.isArray(value) ? value : [];
  const urgentRequested = explicitlyRequestsUrgent(sourceText);
  const urgentSelected = allowUrgent && flags.map(String).includes("urgent");
  const includeUrgent = urgentRequested || urgentSelected;
  const normalized = [
    ...new Set(
      flags
        .map(String)
        .filter((flag) => TASK_FLAG_IDS.has(flag) && (flag !== "urgent" || includeUrgent)),
    ),
  ];
  const lower = sourceText.toLowerCase();
  const fallbacks = [
    ["study", /(уч[её]б|универ|курс|экзамен|лекци)/i],
    ["gcod", /(gcod|revit|navisworks|bim)/i],
    ["work", /(работ|проект|заказчик|коллег|фасад|витраж|черт[её]ж|модел|материал)/i],
  ];
  for (const [flag, pattern] of fallbacks) {
    if (pattern.test(lower) && !normalized.includes(flag)) normalized.push(flag);
  }
  if (urgentRequested && !normalized.includes("urgent")) normalized.push("urgent");
  if (!normalized.some((flag) => flag !== "urgent")) normalized.push("personal");
  return normalized.slice(0, TASK_FLAGS.length);
}

function fallbackSubtasks(sourceText) {
  const actions = cleanText(sourceText, 3000)
    .split(
      /\s*(?:[,;]|\n|\.\s+)\s*|\s+и\s+(?=(?:создать|сделать|улучшить|разделить|проверить|подготовить|купить|отправить|добавить|исправить|обновить|настроить|протестировать|разработать)\b)/iu,
    )
    .map((item) => cleanText(item.replace(/[.!?]+$/g, ""), 240))
    .filter(Boolean);
  if (actions.length < 2) return [];
  return actions.slice(0, MAX_SUBTASKS).map((title) => ({
    id: crypto.randomUUID(),
    title,
    done: false,
  }));
}

export function normalizeSubtasks(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const candidate = item && typeof item === "object" ? item : { title: item };
    const title = cleanText(candidate.title, 240);
    const key = title.toLocaleLowerCase("ru-RU");
    if (!title || seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: cleanText(candidate.id, 80) || crypto.randomUUID(),
      title,
      done: candidate.done === true,
    });
    if (result.length >= MAX_SUBTASKS) break;
  }
  return result;
}

function normalizeDueAt(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2020 || year > 2100) return null;
  return new Date(parsed).toISOString();
}

export function fallbackTaskDraft(sourceText) {
  const text = cleanText(sourceText, 3000);
  const firstSentence = text.split(/[.!?\n]/)[0] || text;
  const subtasks = fallbackSubtasks(text);
  return {
    title: cleanText(firstSentence, 96) || "Новая задача",
    description: subtasks.length ? "" : text,
    subtasks,
    due_at: null,
    flags: normalizeFlags([], text),
  };
}

export function normalizeTaskDraft(value, sourceText) {
  const fallback = fallbackTaskDraft(sourceText);
  const candidate = value && typeof value === "object" ? value : {};
  const subtasks = normalizeSubtasks(
    Array.isArray(candidate.subtasks) && candidate.subtasks.length
      ? candidate.subtasks
      : fallback.subtasks,
  );
  const candidateDescription = cleanText(candidate.description, 2000);
  return {
    title: cleanText(candidate.title, 120) || fallback.title,
    description: candidateDescription || (subtasks.length ? "" : fallback.description),
    subtasks,
    due_at: normalizeDueAt(candidate.due_at),
    flags: normalizeFlags(candidate.flags, sourceText),
  };
}

function responseObject(result) {
  const candidate = result?.response ?? result?.result?.response ?? result;
  if (candidate && typeof candidate === "object") return candidate;
  if (typeof candidate !== "string") return null;
  try {
    return JSON.parse(candidate.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
}

function currentMoscowTime() {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

export async function parseTaskText(env, sourceText) {
  const text = cleanText(sourceText, 3000);
  if (!text) throw new Error("Описание задачи пустое.");
  if (!env.AI) return fallbackTaskDraft(text);

  const schema = {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 120 },
      description: { type: "string", maxLength: 2000 },
      subtasks: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        maxItems: MAX_SUBTASKS,
      },
      due_at: { type: ["string", "null"] },
      flags: {
        type: "array",
        items: { type: "string", enum: [...TASK_FLAG_IDS] },
        maxItems: TASK_FLAGS.length,
      },
    },
    required: ["title", "description", "subtasks", "due_at", "flags"],
    additionalProperties: false,
  };

  try {
    const result = await env.AI.run(
      env.TASKS_TEXT_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          {
            role: "system",
            content: [
              "Ты превращаешь русскоязычный запрос в задачу.",
              "Сформулируй короткое обобщающее название основной задачи.",
              "Если запрос содержит несколько самостоятельных действий, вынеси каждое действие в subtasks отдельной короткой строкой в повелительной форме.",
              "Не объединяй несколько действий в одну подзадачу и не дублируй их в description.",
              "Если действие только одно, верни пустой массив subtasks и сохрани детали в description.",
              `Текущее время: ${currentMoscowTime()}. Часовой пояс: ${DEFAULT_TIMEZONE}.`,
              "Если срок относительный, вычисли его. Если время не названо, используй 18:00.",
              "Верни due_at в ISO 8601 с часовым поясом или null, если срока действительно нет.",
              "Допустимые флажки: work, study, gcod, personal, urgent. Можно выбрать несколько.",
              "Флажок urgent ставь только если пользователь прямо написал, что задача срочная, требует немедленного выполнения или попросил этот флажок.",
              "Слова о важности задачи сами по себе не означают urgent.",
              "Не придумывай факты, исполнителей и сроки, которых нет в запросе.",
            ].join(" "),
          },
          { role: "user", content: text },
        ],
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0.1,
        max_tokens: 500,
      },
    );
    return normalizeTaskDraft(responseObject(result), text);
  } catch (error) {
    console.error("Task parsing fallback", error);
    return fallbackTaskDraft(text);
  }
}

async function telegramFile(env, fileId, telegramApi) {
  const file = await telegramApi(env, "getFile", { file_id: fileId });
  const filePath = String(file?.result?.file_path || "");
  if (!filePath) throw new Error("Telegram не вернул файл голосового сообщения.");
  const response = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
  );
  if (!response.ok) throw new Error(`Не удалось скачать голосовое: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_VOICE_BYTES) {
    throw new Error("Голосовое сообщение слишком большое. Максимум 5 МБ.");
  }
  return buffer;
}

function isSpeechInputSchemaError(error) {
  const message = String(error?.message || error || "");
  return /(?:5006|required properties|type mismatch)/i.test(message) && /audio/i.test(message);
}

export async function transcribeAudioBuffer(env, buffer) {
  if (!env.AI) throw new Error("Workers AI ещё не подключён к боту.");
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError("Аудиозапись должна быть передана в бинарном формате.");
  }

  const model = env.TASKS_SPEECH_MODEL || "@cf/openai/whisper-large-v3-turbo";
  const result = await env.AI.run(model, {
    audio: Buffer.from(buffer).toString("base64"),
    task: "transcribe",
    language: "ru",
    vad_filter: false,
    initial_prompt: "Задача, работа, учёба, GCodRevit, Revit, Navisworks, BIM, дедлайн.",
  });
  const text = cleanText(result?.text || result?.transcription_info?.text, 3000);
  if (!text) throw new Error("Не удалось распознать речь в голосовом сообщении.");
  return text;
}

export async function transcribeVoice(env, message, telegramApi) {
  const voice = message.voice || message.audio;
  if (!voice?.file_id) throw new Error("В сообщении нет голосового файла.");
  if (Number(voice.file_size || 0) > MAX_VOICE_BYTES) {
    throw new Error("Голосовое сообщение слишком большое. Максимум 5 МБ.");
  }
  const buffer = await telegramFile(env, voice.file_id, telegramApi);
  return transcribeAudioBuffer(env, buffer);
}

function taskSubmissionErrorMessage(error) {
  if (isSpeechInputSchemaError(error)) {
    return "Не удалось распознать голосовое. Повтори запись или отправь задачу текстом.";
  }
  return cleanText(error?.message || "Неизвестная ошибка", 500);
}

function serializeTask(row) {
  if (!row) return null;
  let flags = [];
  let subtasks = [];
  try {
    flags = JSON.parse(row.flags_json || "[]");
  } catch {
    flags = [];
  }
  try {
    subtasks = JSON.parse(row.subtasks_json || "[]");
  } catch {
    subtasks = [];
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    subtasks: normalizeSubtasks(subtasks),
    due_at: row.due_at || null,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    status: row.status,
    flags: normalizeFlags(flags, "", { allowUrgent: true }),
    source_type: row.source_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

async function insertTask(env, ownerId, draft, sourceType, sourceText, status = "draft") {
  const db = tasksDb(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tasks
        (id, owner_id, title, description, subtasks_json, due_at, timezone, status, flags_json,
         source_type, source_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      String(ownerId),
      draft.title,
      draft.description,
      JSON.stringify(normalizeSubtasks(draft.subtasks)),
      draft.due_at,
      DEFAULT_TIMEZONE,
      status,
      JSON.stringify(draft.flags),
      sourceType,
      cleanText(sourceText, 3000),
      now,
      now,
    )
    .run();
  return { id, ...draft, status, created_at: now, updated_at: now };
}

function formatDueAt(value) {
  if (!value) return "Без срока";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatFlags(flags) {
  const labels = new Map(TASK_FLAGS.map((flag) => [flag.id, flag.label]));
  return flags.map((flag) => labels.get(flag)).filter(Boolean).join(" · ") || "Личное";
}

function taskPreview(task, transcript = "") {
  const lines = ["Проверь задачу", "", "Название:", task.title];
  if (task.subtasks?.length) {
    lines.push("", "Задачи:", ...task.subtasks.map((subtask) => `- ${subtask.title}`));
  } else if (task.description) {
    lines.push("", "Описание:", task.description);
  }
  lines.push(
    "",
    `Дедлайн: ${task.due_at ? formatDueAt(task.due_at) : "Не указан"}`,
    `Флажки: ${formatFlags(task.flags)}`,
  );
  if (transcript) lines.push("", `Распознано: ${cleanText(transcript, 500)}`);
  return lines.join("\n").slice(0, 3900);
}

async function sendTaskPreview(env, chatId, task, transcript, telegramApi) {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: taskPreview(task, transcript),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Сохранить", callback_data: `task:save:${task.id}` },
          { text: "Отменить", callback_data: `task:cancel:${task.id}` },
        ],
        [{ text: "✏️ Изменить", web_app: { url: taskAppUrl(env, task.id) } }],
      ],
    },
  });
}

async function processTaskSubmission(env, chatId, ownerId, message, telegramApi) {
  try {
    const isVoice = Boolean(message.voice || message.audio);
    const sourceText = isVoice
      ? await transcribeVoice(env, message, telegramApi)
      : cleanText(String(message.text || "").replace(/^\/task(?:@\w+)?\s*/i, ""), 3000);
    const draft = await parseTaskText(env, sourceText);
    const task = await insertTask(env, ownerId, draft, isVoice ? "voice" : "text", sourceText);
    await sendTaskPreview(env, chatId, task, isVoice ? sourceText : "", telegramApi);
  } catch (error) {
    console.error("Task submission failed", error);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `Не удалось разобрать задачу: ${taskSubmissionErrorMessage(error)}`,
    });
  }
}

async function handleTaskCallback(update, env, telegramApi) {
  const query = update.callback_query;
  const match = String(query?.data || "").match(/^task:(save|cancel):([0-9a-f-]{36})$/i);
  if (!match) return false;
  const [, action, taskId] = match;
  const ownerId = String(query.from.id);
  const db = tasksDb(env);
  const existing = await db
    .prepare("SELECT id, title FROM tasks WHERE id = ? AND owner_id = ? AND status = 'draft'")
    .bind(taskId, ownerId)
    .first();
  if (!existing) {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Эта задача уже обработана.",
    });
    return true;
  }

  if (action === "save") {
    await db
      .prepare("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ? AND owner_id = ?")
      .bind(new Date().toISOString(), taskId, ownerId)
      .run();
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Задача сохранена",
    });
    await telegramApi(env, "sendMessage", {
      chat_id: query.message.chat.id,
      text: `Задача «${cleanText(existing.title, 100)}» сохранена.`,
      reply_markup: {
        inline_keyboard: [[{ text: "📅 Открыть задачи", web_app: { url: taskAppUrl(env) } }]],
      },
    });
  } else {
    await db.prepare("DELETE FROM tasks WHERE id = ? AND owner_id = ?").bind(taskId, ownerId).run();
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Черновик удалён",
    });
  }
  if (query.message?.chat?.id && query.message?.message_id) {
    await telegramApi(env, "editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
  return true;
}

export async function handleTaskUpdate(update, env, ctx, helpers) {
  const { telegramApi, sendMessage, reservedTexts = new Set() } = helpers;
  if (update.callback_query) {
    return handleTaskCallback(update, env, telegramApi);
  }

  const message = update.message;
  if (!message?.from?.id || !message?.chat?.id) return false;
  const text = String(message.text || "").trim();
  const ownerId = Number(message.from.id);
  const chatId = message.chat.id;

  if (text === BUTTON_TASK_CREATE) {
    await sendMessage(
      env,
      chatId,
      "Эта кнопка больше не нужна. Просто напиши задачу обычным сообщением или отправь голосовое.",
    );
    return true;
  }

  if (text === BUTTON_TASKS) {
    await sendMessage(env, chatId, "Открой календарь кнопкой Open App в профиле бота.");
    return true;
  }

  if (!shouldCreateTaskFromMessage(message, reservedTexts)) return false;

  const voice = Boolean(message.voice || message.audio);

  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: voice ? "Распознаю голосовое и собираю задачу…" : "Разбираю задачу…",
  });
  ctx.waitUntil(processTaskSubmission(env, chatId, ownerId, message, telegramApi));
  return true;
}

export function shouldCreateTaskFromMessage(message, reservedTexts = new Set()) {
  if (message?.voice || message?.audio) return true;
  const text = String(message?.text || "").trim();
  if (!text || reservedTexts.has(text)) return false;
  if (/^\/task(?:@\w+)?\s+.+/is.test(text)) return true;
  return !text.startsWith("/");
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

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

export async function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  if (!receivedHash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const calculated = bytesToHex(await hmac(secret, dataCheck));
  if (!constantTimeEqual(calculated, receivedHash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

function adminIdSet(env) {
  return new Set(
    String(env.TELEGRAM_ADMIN_IDS || "1839693017")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(String),
  );
}

export async function authorizedMiniAppUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const initData = authorization.startsWith("tma ")
    ? authorization.slice(4)
    : request.headers.get("X-Telegram-Init-Data") || "";
  const user = await validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!user || !adminIdSet(env).has(String(user.id))) return null;
  return user;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function requestJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("Слишком большой запрос.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("Слишком большой запрос.");
  }
  return text ? JSON.parse(text) : {};
}

export function validateTaskPayload(value, { partial = false } = {}) {
  const body = value && typeof value === "object" ? value : {};
  const result = {};
  if (!partial || Object.hasOwn(body, "title")) {
    result.title = cleanText(body.title, 120);
    if (!result.title) throw new Error("Укажи название задачи.");
  }
  if (!partial || Object.hasOwn(body, "description")) {
    result.description = cleanText(body.description, 2000);
  }
  if (!partial || Object.hasOwn(body, "subtasks")) {
    result.subtasks = normalizeSubtasks(body.subtasks);
  }
  if (!partial || Object.hasOwn(body, "due_at")) {
    result.due_at = normalizeDueAt(body.due_at);
    if (body.due_at && !result.due_at) throw new Error("Некорректный срок задачи.");
  }
  if (!partial || Object.hasOwn(body, "flags")) {
    result.flags = normalizeFlags(body.flags, "", { allowUrgent: true });
  }
  if (Object.hasOwn(body, "status")) {
    const status = String(body.status);
    if (!TASK_STATUSES.has(status) || status === "draft") throw new Error("Некорректный статус.");
    result.status = status;
  }
  return result;
}

async function listTasks(env, ownerId) {
  const result = await tasksDb(env)
    .prepare(
      `SELECT * FROM tasks
       WHERE owner_id = ? AND status NOT IN ('draft', 'archived')
       ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at DESC
       LIMIT 500`,
    )
    .bind(String(ownerId))
    .all();
  return (result.results || []).map(serializeTask);
}

async function getTask(env, ownerId, taskId) {
  const row = await tasksDb(env)
    .prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ? AND status != 'archived'")
    .bind(taskId, String(ownerId))
    .first();
  return serializeTask(row);
}

async function createTaskFromApi(env, ownerId, body) {
  const draft = validateTaskPayload(body);
  return insertTask(env, ownerId, draft, "mini_app", body.description || body.title, "todo");
}

async function updateTaskFromApi(env, ownerId, taskId, body) {
  const changes = validateTaskPayload(body, { partial: true });
  const assignments = [];
  const values = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === "flags") {
      assignments.push("flags_json = ?");
      values.push(JSON.stringify(value));
    } else if (field === "subtasks") {
      assignments.push("subtasks_json = ?");
      values.push(JSON.stringify(value));
    } else {
      assignments.push(`${field} = ?`);
      values.push(value);
    }
  }
  if (!assignments.length) throw new Error("Нет изменений для сохранения.");
  if (changes.status === "done") {
    assignments.push("completed_at = ?");
    values.push(new Date().toISOString());
  } else if (changes.status) {
    assignments.push("completed_at = NULL");
  }
  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), taskId, String(ownerId));
  await tasksDb(env)
    .prepare(
      `UPDATE tasks SET ${assignments.join(", ")}
       WHERE id = ? AND owner_id = ? AND status != 'archived'`,
    )
    .bind(...values)
    .run();
  return getTask(env, ownerId, taskId);
}

export async function handleTaskApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/tasks")) return null;
  const user = await authorizedMiniAppUser(request, env);
  if (!user) return json({ error: "Открой приложение из Telegram-бота." }, 401);
  const suffix = url.pathname.slice("/api/tasks".length).replace(/^\//, "");
  const taskId = suffix || "";

  try {
    if (request.method === "GET" && !taskId) {
      return json({ tasks: await listTasks(env, user.id), flags: TASK_FLAGS });
    }
    if (request.method === "GET" && taskId) {
      const task = await getTask(env, user.id, taskId);
      return task ? json({ task }) : json({ error: "Задача не найдена." }, 404);
    }
    if (request.method === "POST" && !taskId) {
      const task = await createTaskFromApi(env, user.id, await requestJson(request));
      return json({ task }, 201);
    }
    if (request.method === "PATCH" && taskId) {
      const task = await updateTaskFromApi(env, user.id, taskId, await requestJson(request));
      return task ? json({ task }) : json({ error: "Задача не найдена." }, 404);
    }
    if (request.method === "DELETE" && taskId) {
      await updateTaskFromApi(env, user.id, taskId, { status: "archived" });
      return json({ ok: true });
    }
    return json({ error: "Метод не поддерживается." }, 405);
  } catch (error) {
    console.error("Tasks API error", error);
    return json({ error: error.message || "Ошибка задач." }, 400);
  }
}
