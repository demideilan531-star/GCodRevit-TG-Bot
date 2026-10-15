import { TASK_FLAGS } from "./tasks.js";
import { buildBriefingWeatherSection } from "./briefing-weather.js";

export const BUTTON_MORNING_BRIEFING = "Утренний брифинг";
const TIMEZONE = "Europe/Moscow";
const MAX_MESSAGE_LENGTH = 3800;
const DAY_MS = 24 * 60 * 60 * 1000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const FLAG_LABELS = new Map(TASK_FLAGS.map(({ id, label }) => [id, label]));

export function moscowDayBounds(now = new Date()) {
  const local = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    MOSCOW_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

export function isMorningBriefingRequest(text) {
  const value = String(text || "").trim();
  return value === BUTTON_MORNING_BRIEFING || /^\/briefing(?:@\w+)?$/i.test(value);
}

function cleanText(value, maxLength = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function taskLine(row, group) {
  const title = cleanText(row.title) || "Без названия";
  let prefix = "";
  if (row.due_at) {
    const date = new Date(row.due_at);
    prefix = group === "today"
      ? new Intl.DateTimeFormat("ru-RU", {
          timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit",
        }).format(date)
      : new Intl.DateTimeFormat("ru-RU", {
          timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric",
        }).format(date);
    prefix += " — ";
  }
  const flags = [...new Set(parseArray(row.flags_json))]
    .filter((id) => FLAG_LABELS.has(id))
    .slice(0, 2)
    .map((id) => FLAG_LABELS.get(id));
  const subtasks = parseArray(row.subtasks_json).filter((item) => item && typeof item === "object");
  const details = [
    row.status === "in_progress" ? "В работе" : "",
    ...flags,
    subtasks.length ? `${subtasks.filter((item) => item.done === true).length}/${subtasks.length} подзадач` : "",
  ].filter(Boolean);
  return `• ${prefix}${title}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

async function taskGroup(env, ownerId, condition, values, limit) {
  const result = await env.TASKS_DB.prepare(
    `SELECT title, due_at, flags_json, subtasks_json, status, COUNT(*) OVER () AS total_count
     FROM tasks
     WHERE owner_id = ? AND status IN ('todo', 'in_progress') AND ${condition}
     ORDER BY due_at, created_at, id
     LIMIT ?`,
  ).bind(String(ownerId), ...values, limit).all();
  const rows = result.results || [];
  return { rows, total: Number(rows[0]?.total_count || 0) };
}

async function buildTasksSection({ env, ownerId, now, access }) {
  if (!access.canTasks) return ["Список задач недоступен."];
  if (!env.TASKS_DB) throw new Error("TASKS_DB is not configured");
  const { start, end } = moscowDayBounds(now);
  const [today, overdue, undated] = await Promise.all([
    taskGroup(env, ownerId, "due_at >= ? AND due_at < ?", [start, end], 8),
    taskGroup(env, ownerId, "due_at < ?", [start], 4),
    taskGroup(env, ownerId, "due_at IS NULL", [], 4),
  ]);
  const lines = ["Задачи на сегодня"];
  if (!today.total) lines.push("Задач на сегодня нет.");
  else lines.push(...groupLines(today, "today"));
  if (overdue.total) lines.push("", "Просроченные задачи", ...groupLines(overdue, "overdue"));
  if (undated.total) lines.push("", "Без срока", ...groupLines(undated, "undated"));
  return lines;
}

function groupLines(group, kind) {
  const lines = group.rows.map((row) => taskLine(row, kind));
  if (group.total > group.rows.length) {
    lines.push(`Ещё ${group.total - group.rows.length} — в календаре.`);
  }
  return lines;
}

// Each section loads its own data; a failed section must not hide the rest of the briefing.
const BRIEFING_SECTIONS = [
  { id: "weather", build: buildBriefingWeatherSection, unavailable: "Погода временно недоступна. Задачи показаны ниже." },
  { id: "tasks", build: buildTasksSection, unavailable: "Не удалось загрузить задачи. Попробуй ещё раз." },
];

export async function buildMorningBriefing(env, { ownerId, access, now = new Date(), weatherProvider }) {
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(now);
  const lines = [BUTTON_MORNING_BRIEFING, `На день: ${date} · МСК`];
  const sections = await Promise.all(BRIEFING_SECTIONS.map(async (section) => {
    try {
      return await section.build({ env, ownerId, access, now, weatherProvider });
    } catch (error) {
      console.error(`Morning briefing section ${section.id} failed`, error);
      return [section.unavailable];
    }
  }));
  for (const section of sections) if (section.length) lines.push("", ...section);
  const text = lines.join("\n");
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const suffix = "\n\nОстальные задачи — в календаре.";
  const boundary = text.lastIndexOf("\n", MAX_MESSAGE_LENGTH - suffix.length);
  return text.slice(0, boundary) + suffix;
}

export async function handleMorningBriefingUpdate(update, env, { access, sendMessage, now }) {
  const message = update.message;
  if (!isMorningBriefingRequest(message?.text)) return false;
  if (message.chat?.type !== "private") {
    await sendMessage(env, message.chat.id, "Открой брифинг в личном чате с ботом.", false);
    return true;
  }
  const text = await buildMorningBriefing(env, { ownerId: message.from.id, access, now });
  await sendMessage(env, message.chat.id, text);
  return true;
}
