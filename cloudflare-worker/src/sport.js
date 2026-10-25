import { getAssistantAccess } from './access.js';
import { validateTelegramInitData } from './tasks.js';
import { getSheetExportConfig, saveSheetExportConfig } from './sport-sheets.js';

export const SPORT_CRON = '* * * * *';
export const BUTTON_SPORT = 'Спорт';
export const TRAINING_TYPES = ['rest', 'strength', 'cardio', 'stretch', 'other'];
const DEFAULT_TIMEZONE = 'Europe/Moscow';
const MAX_BODY = 16384;
const DAY_NUMBERS = {
  weight_kg: [20, 400], sleep_hours: [0, 24], sleep_quality: [1, 5, true],
  water_ml: [0, 20000, true], steps: [0, 150000, true], mood: [1, 5, true],
};
const MEAL_NUMBERS = { calories_kcal: [0, 10000], protein_g: [0, 1000], fat_g: [0, 1000], carbs_g: [0, 2000] };
const GOAL_NUMBERS = { ...MEAL_NUMBERS, weight_kg: [20, 400], sleep_hours: [0, 24], water_ml: [0, 20000, true], steps: [0, 150000, true] };
const DAY_FIELDS = [...Object.keys(DAY_NUMBERS), 'training', 'nutrition', 'comment', 'coach_note'];
const MEAL_FIELDS = ['date', 'time', 'title', ...Object.keys(MEAL_NUMBERS), 'note'];
const REMINDER_LABELS = { sleep: 'Сон', meal: 'Приём пищи', evening: 'Итоги дня', water: 'Вода', steps: 'Шаги' };
const dateFormatters = new Map();

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ожидается объект с данными.');
  return value;
}

function text(value, max) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Текст должен быть не длиннее ${max} символов.`);
  return value.trim();
}

function number(value, [min, max, integer]) {
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Число должно быть ${integer ? 'целым, ' : ''}от ${min} до ${max}.`);
  }
  return value;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Некорректная дата.');
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Некорректная дата.');
  return value;
}

function validTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Укажи время в формате ЧЧ:ММ.');
  return value;
}

function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Некорректный часовой пояс.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new Error('Неизвестный часовой пояс.'); }
  return value;
}

function localParts(date, timezone) {
  if (!dateFormatters.has(timezone)) {
    if (dateFormatters.size >= 64) dateFormatters.clear();
    dateFormatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const values = Object.fromEntries(dateFormatters.get(timezone).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

// Resolve wall-clock times with Intl offsets. DST gaps use the next valid minute;
// repeated wall times are sent only once per local day by the delivery key.
export function nextReminderDue(reminder, timezone, after = new Date()) {
  validTime(reminder.time); validTimezone(timezone);
  const start = new Date(after);
  const local = localParts(start, timezone);
  for (let day = 0; day < 3; day++) {
    const targetDate = new Date(Date.parse(`${local.date}T00:00:00Z`) + day * 86400000).toISOString().slice(0, 10);
    const target = Date.parse(`${targetDate}T${reminder.time}:00Z`);
    const candidates = new Set();
    for (const shift of [-86400000, 0, 86400000]) {
      let guess = target + shift;
      for (let i = 0; i < 3; i++) {
        const wall = localParts(new Date(guess), timezone);
        const offset = Date.parse(`${wall.date}T${wall.time}:00Z`) - Math.floor(guess / 60000) * 60000;
        guess = target - offset;
      }
      candidates.add(guess);
    }
    const exact = [...candidates].filter(t => {
      const wall = localParts(new Date(t), timezone);
      return wall.date === targetDate && wall.time === reminder.time;
    }).sort((a, b) => a - b);
    // On a DST fall-back day the first occurrence is authoritative.
    if (exact.length && exact[0] > start.getTime()) return new Date(exact[0]).toISOString();
    if (!exact.length) {
      const guesses = [...candidates].sort((a, b) => a - b);
      const end = Math.min(guesses.at(-1), guesses[0] + 3 * 3600000);
      for (let guess = guesses[0]; guess <= end; guess += 60000) {
        const wall = localParts(new Date(guess), timezone);
        if (guess > start.getTime() && wall.date === targetDate && wall.time > reminder.time) return new Date(guess).toISOString();
      }
    }
  }
  throw new Error('Не удалось рассчитать время напоминания.');
}

export function validateDayPayload(value) {
  const body = object(value), result = {};
  for (const [key, limits] of Object.entries(DAY_NUMBERS)) if (Object.hasOwn(body, key)) result[key] = number(body[key], limits);
  if (Object.hasOwn(body, 'training')) {
    if (body.training !== null && !TRAINING_TYPES.includes(body.training)) throw new Error('Неизвестный вид тренировки.');
    result.training = body.training;
  }
  if (Object.hasOwn(body, 'nutrition')) {
    if (body.nutrition !== null && typeof body.nutrition !== 'boolean') throw new Error('Питание: да, нет или не отмечено.');
    result.nutrition = body.nutrition;
  }
  for (const key of ['comment', 'coach_note']) if (Object.hasOwn(body, key)) result[key] = text(body[key], 2000);
  if (!Object.keys(result).length) throw new Error('Нет данных для сохранения.');
  return result;
}

export function validateMealPayload(value, { partial = false } = {}) {
  const body = object(value), result = {};
  if (!partial || Object.hasOwn(body, 'date')) result.date = validDate(body.date);
  if (!partial || Object.hasOwn(body, 'time')) result.time = validTime(body.time);
  if (!partial || Object.hasOwn(body, 'title')) {
    result.title = text(body.title, 120);
    if (!result.title) throw new Error('Укажи название приёма пищи.');
  }
  for (const [key, limits] of Object.entries(MEAL_NUMBERS)) {
    if (!partial || Object.hasOwn(body, key)) result[key] = body[key] === undefined ? null : number(body[key], limits);
  }
  if (!partial || Object.hasOwn(body, 'note')) result.note = body.note === undefined ? '' : text(body.note, 2000);
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(body.id)) throw new Error('Некорректный ID приёма пищи.');
    result.id = body.id;
  }
  return result;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function bodyJson(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('Слишком большой запрос.');
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY) throw new Error('Слишком большой запрос.');
  return object(JSON.parse(body));
}

async function sportUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const user = await validateTelegramInitData(header.startsWith('tma ') ? header.slice(4) : '', env.TELEGRAM_BOT_TOKEN);
  if (!user || !await getAssistantAccess(env, user)) return null;
  return user;
}

async function profileFor(db, owner) {
  const row = await db.prepare('SELECT * FROM sport_profiles WHERE owner_id = ?').bind(owner).first();
  return { timezone: row?.timezone || DEFAULT_TIMEZONE, goals: row ? JSON.parse(row.goals_json) : {} };
}

function serializeDay(row) {
  if (!row) return null;
  const result = { date: row.date };
  for (const key of DAY_FIELDS) result[key] = key === 'nutrition' ? (row[key] == null ? null : Boolean(row[key])) : row[key];
  return result;
}

function serializeMeal(row) {
  if (!row) return null;
  return Object.fromEntries(['id', ...MEAL_FIELDS, 'source_type', 'nutrition_source'].map(k => [k, row[k]]));
}

async function saveDay(db, owner, date, changes) {
  validDate(date);
  const payload = validateDayPayload(changes), now = new Date().toISOString();
  const keys = Object.keys(payload), values = keys.map(k => k === 'nutrition' && payload[k] !== null ? Number(payload[k]) : payload[k]);
  await db.prepare(`INSERT INTO sport_days (owner_id, date, ${keys.join(',')}, created_at, updated_at)
    VALUES (?, ?, ${keys.map(() => '?').join(',')}, ?, ?)
    ON CONFLICT(owner_id,date) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}, updated_at=excluded.updated_at`)
    .bind(owner, date, ...values, now, now).run();
  return serializeDay(await db.prepare('SELECT * FROM sport_days WHERE owner_id = ? AND date = ?').bind(owner, date).first());
}

async function saveMeal(db, owner, input, source = 'mini_app') {
  const payload = validateMealPayload(input), id = payload.id || crypto.randomUUID(), now = new Date().toISOString();
  const prior = await db.prepare('SELECT * FROM sport_meals WHERE id = ? AND owner_id = ?').bind(id, owner).first();
  if (prior) return serializeMeal(prior);
  const count = await db.prepare('SELECT COUNT(*) AS total FROM sport_meals WHERE owner_id = ? AND date = ?').bind(owner, payload.date).first();
  if (count?.total >= 50) throw new Error('Не больше 50 приёмов пищи за день.');
  await db.prepare(`INSERT OR IGNORE INTO sport_meals
    (id, owner_id, ${MEAL_FIELDS.join(',')}, source_type, nutrition_source, created_at, updated_at)
    VALUES (?, ?, ${MEAL_FIELDS.map(() => '?').join(',')}, ?, 'manual', ?, ?)`)
    .bind(id, owner, ...MEAL_FIELDS.map(k => payload[k]), source, now, now).run();
  const row = await db.prepare('SELECT * FROM sport_meals WHERE id = ? AND owner_id = ?').bind(id, owner).first();
  if (!row) throw new Error('Не удалось сохранить приём пищи. Повтори с новым ID.');
  return serializeMeal(row);
}

function rangeFor(url, today) {
  const to = validDate(url.searchParams.get('to') || today);
  const from = validDate(url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10));
  if (from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) throw new Error('Выбери период не больше 93 дней.');
  return { from, to };
}

export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let result = String(value);
  if (typeof value === 'string' && /^[\s]*[=+@\-\t\r\n]/.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}

async function saveSettings(db, owner, value) {
  const input = object(value), timezone = validTimezone(input.timezone), goals = {};
  object(input.goals);
  for (const [key, limits] of Object.entries(GOAL_NUMBERS)) if (Object.hasOwn(input.goals, key)) goals[key] = number(input.goals[key], limits);
  if (!Array.isArray(input.reminders) || input.reminders.length > 16) throw new Error('Можно настроить до 16 напоминаний в день.');
  const existing = (await db.prepare('SELECT id FROM sport_reminders WHERE owner_id = ?').bind(owner).all()).results || [];
  const allowedIds = new Set(existing.map(r => r.id)), ids = new Set(), slots = new Set(), now = new Date();
  const reminders = input.reminders.map(item => {
    object(item);
    if (!Object.hasOwn(REMINDER_LABELS, item.kind) || typeof item.enabled !== 'boolean') throw new Error('Некорректное напоминание.');
    const id = item.id && allowedIds.has(item.id) ? item.id : crypto.randomUUID();
    if (ids.has(id)) throw new Error('Повторное напоминание.');
    ids.add(id);
    const mode = item.mode === undefined ? 'notification' : item.mode;
    if (!['notification', 'question'].includes(mode)) throw new Error('Некорректный режим напоминания.');
    const time = validTime(item.time), label = text(item.label || '', 80) || REMINDER_LABELS[item.kind];
    const slot = `${item.kind}:${time}`;
    if (slots.has(slot)) throw new Error('Одинаковые напоминания в одно время не нужны.');
    slots.add(slot);
    return { id, kind: item.kind, mode, time, label, enabled: item.enabled, next: item.enabled ? nextReminderDue({ time }, timezone, now) : null };
  });
  await db.batch([
    db.prepare(`INSERT INTO sport_profiles (owner_id, timezone, goals_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone, goals_json=excluded.goals_json, updated_at=excluded.updated_at`)
      .bind(owner, timezone, JSON.stringify(goals), now.toISOString()),
    db.prepare('DELETE FROM sport_reminders WHERE owner_id = ?').bind(owner),
    ...reminders.map(r => db.prepare(`INSERT INTO sport_reminders (id,owner_id,kind,mode,time,label,enabled,next_due_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(r.id, owner, r.kind, r.mode, r.time, r.label, Number(r.enabled), r.next, now.toISOString())),
  ]);
  return { profile: { timezone, goals }, reminders: reminders.map(({ next, ...r }) => r) };
}

export async function handleSportApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/sport' && !url.pathname.startsWith('/api/sport/')) return null;
  const user = await sportUser(request, env);
  if (!user) return json({ error: 'Открой приложение из разрешённого Telegram-аккаунта.' }, 401);
  const owner = String(user.id), db = env.TASKS_DB;
  try {
    const profile = await profileFor(db, owner), today = localParts(new Date(), profile.timezone).date;
    const suffix = url.pathname.slice('/api/sport'.length);
    if (request.method === 'GET' && (suffix === '' || suffix === '/export')) {
      const { from, to } = rangeFor(url, today);
      const days = ((await db.prepare('SELECT * FROM sport_days WHERE owner_id = ? AND date BETWEEN ? AND ? ORDER BY date').bind(owner, from, to).all()).results || []).map(serializeDay);
      const meals = ((await db.prepare('SELECT * FROM sport_meals WHERE owner_id = ? AND date BETWEEN ? AND ? ORDER BY date, time, created_at').bind(owner, from, to).all()).results || []).map(serializeMeal);
      if (suffix === '/export') {
        const mealExport = url.searchParams.get('kind') === 'meals';
        const keys = mealExport ? ['date', 'time', 'title', ...Object.keys(MEAL_NUMBERS), 'note'] : ['date', ...DAY_FIELDS];
        const rows = mealExport ? meals : days;
        const csv = '\uFEFF' + [keys, ...rows.map(row => keys.map(k => row[k]))].map(row => row.map(csvCell).join(';')).join('\r\n');
        return new Response(csv, { headers: { 'Content-Type': 'text/csv;charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="sport-${mealExport ? 'meals' : 'days'}-${from}-${to}.csv"`, 'X-Content-Type-Options': 'nosniff' } });
      }
      const reminders = ((await db.prepare('SELECT id, kind, mode, time, label, enabled FROM sport_reminders WHERE owner_id = ? ORDER BY time').bind(owner).all()).results || []).map(r => ({ ...r, enabled: Boolean(r.enabled) }));
      return json({ days, meals, profile, reminders, today, training_types: TRAINING_TYPES, sheet_export: await getSheetExportConfig(db, owner, env) });
    }
    const day = suffix.match(/^\/days\/(20\d{2}-\d{2}-\d{2})$/);
    if (request.method === 'PUT' && day) return json({ day: await saveDay(db, owner, day[1], await bodyJson(request)) });
    if (request.method === 'PUT' && suffix === '/settings') return json(await saveSettings(db, owner, await bodyJson(request)));
    if (request.method === 'PUT' && suffix === '/sheet-export') return json({ sheet_export: await saveSheetExportConfig(db, owner, env, await bodyJson(request)) });
    if (request.method === 'POST' && suffix === '/meals') return json({ meal: await saveMeal(db, owner, await bodyJson(request)) }, 201);
    const meal = suffix.match(/^\/meals\/([a-zA-Z0-9_-]{8,80})$/);
    if (meal && ['PATCH', 'DELETE'].includes(request.method)) {
      const existing = await db.prepare('SELECT id FROM sport_meals WHERE id = ? AND owner_id = ?').bind(meal[1], owner).first();
      if (!existing) return json({ error: 'Приём пищи не найден.' }, 404);
      if (request.method === 'DELETE') { await db.prepare('DELETE FROM sport_meals WHERE id = ? AND owner_id = ?').bind(meal[1], owner).run(); return json({ ok: true }); }
      const changes = validateMealPayload(await bodyJson(request), { partial: true });
      delete changes.id;
      const keys = Object.keys(changes);
      if (!keys.length) throw new Error('Нет изменений.');
      await db.prepare(`UPDATE sport_meals SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=? AND owner_id=?`)
        .bind(...keys.map(k => changes[k]), new Date().toISOString(), meal[1], owner).run();
      return json({ meal: serializeMeal(await db.prepare('SELECT * FROM sport_meals WHERE id=? AND owner_id=?').bind(meal[1], owner).first()) });
    }
    return json({ error: 'Маршрут или метод не поддерживается.' }, 404);
  } catch (error) {
    console.error('Sport API request failed');
    return json({ error: error instanceof SyntaxError ? 'Некорректный JSON.' : error.message }, 400);
  }
}

function parsedNumber(value) { return Number(value.replaceAll(' ', '').replace(',', '.')); }

export function parseSportReply(kind, source) {
  const input = String(source || '').trim().slice(0, 3000), lower = input.toLowerCase();
  if (!input) return null;
  if (kind === 'water' || kind === 'steps') {
    if (kind === 'steps' && /^\d+(?:[ ]\d{3})*$/u.test(input)) return { day: validateDayPayload({ steps: parsedNumber(input) }) };
    const parsed = parseSportReply('evening', input), field = kind === 'water' ? 'water_ml' : 'steps';
    return parsed?.day?.[field] == null ? null : { day: { [field]: parsed.day[field] } };
  }
  if (kind === 'sleep') {
    if (/спал[аи]?\s+с\s+\d/u.test(lower)) return null;
    const match = lower.match(/(?:спал[аи]?|сон|сна)\D{0,15}(\d{1,2}(?:[.,]\d{1,2})?)(?:\s*(?:ч(?:ас(?:а|ов)?)?))?/u)
      || lower.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:ч(?:ас(?:а|ов)?)?)(?=[\s,.!;]|$)/u)
      || lower.match(/^(\d{1,2}(?:[.,]\d{1,2})?)$/u);
    const day = {};
    if (match) {
      const minutes = lower.match(/(\d{1,2})\s*мин/u);
      day.sleep_hours = Math.round((parsedNumber(match[1]) + (minutes ? Number(minutes[1]) / 60 : 0)) * 100) / 100;
    }
    const quality = /ужас/u.test(lower) ? 1 : /плох|не\s+(?:очень\s+)?хорош/u.test(lower) ? 2 : /отлич|прекрас/u.test(lower) ? 5 : /хорош/u.test(lower) ? 4 : /норм/u.test(lower) ? 3 : null;
    if (quality) day.sleep_quality = quality;
    if (!Object.keys(day).length) return null;
    return { day: validateDayPayload(day) };
  }
  if (kind === 'evening') {
    if (/(?:ещ[её]|добав[ьиь])/u.test(lower)) return null;
    const day = {};
    const water = lower.match(/(?:вод[ауы]?\s*[:=-]?\s*)(\d+(?:[.,]\d+)?)\s*(мл|миллилитр\w*|л|литр\w*)?/u)
      || lower.match(/(\d+(?:[.,]\d+)?)\s*(мл|миллилитр\w*|л|литр\w*)\s*(?:вод[ауы])?/u);
    const steps = lower.match(/шаг[а-я]*\s*[:=-]?\s*(\d+(?:[ .]\d{3})*(?:[.,]\d+)?)\s*(тыс)?/u)
      || lower.match(/(\d+(?:[ ]\d{3})*(?:[.,]\d+)?)\s*(тыс\.?\s*)?шаг/u);
    if (water) {
      if (!water[2]) return null;
      day.water_ml = Math.round(parsedNumber(water[1]) * (/^(?:мл|милли)/u.test(water[2]) ? 1 : 1000));
    }
    if (steps) {
      const value = /^\d{1,3}(?:[ .]\d{3})+$/u.test(steps[1]) ? Number(steps[1].replace(/[ .]/g, '')) : parsedNumber(steps[1]);
      day.steps = Math.round(value * (steps[2] ? 1000 : 1));
    }
    if (/питани[ея]\s*[:=-]?\s*(?:да|по плану|в норме)/u.test(lower)) day.nutrition = true;
    if (/питани[ея]\s*[:=-]?\s*(?:нет|не по плану|не в норме)/u.test(lower)) day.nutrition = false;
    if (!Object.keys(day).length) return null;
    return { day: validateDayPayload(day) };
  }
  if (kind === 'meal') {
    const meal = {}, spans = [];
    const expressions = {
      calories_kcal: [/(\d+(?:[.,]\d+)?)\s*(?:ккал|kcal|калори[йяи])/iu, /(?:ккал|kcal|калори[йяи])\s*[:=-]?\s*(\d+(?:[.,]\d+)?)/iu],
      protein_g: [/(?:^|[\s,;])(?:белк[аиов]*|б|protein)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)(?:\s*г)?/iu],
      fat_g: [/(?:^|[\s,;])(?:жир[аыов]*|ж|fat)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)(?:\s*г)?/iu],
      carbs_g: [/(?:^|[\s,;])(?:углевод[аыов]*|у|carbs)\s*[:=-]?\s*(\d+(?:[.,]\d+)?)(?:\s*г)?/iu],
    };
    for (const [field, patterns] of Object.entries(expressions)) {
      const match = patterns.map(pattern => pattern.exec(input)).find(Boolean);
      if (match) { meal[field] = number(parsedNumber(match[1]), MEAL_NUMBERS[field]); spans.push([match.index, match.index + match[0].length]); }
    }
    if (!Object.keys(meal).length) return null;
    let title = input;
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) title = title.slice(0, start) + ' ' + title.slice(end);
    meal.title = title.replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, '').replace(/\s+/g, ' ').slice(0, 120) || 'Приём пищи';
    return { meal };
  }
  return null;
}

function sportAppUrl(env, date) {
  const url = new URL(env.TASKS_APP_URL || 'https://gcodrevit-telegram-bot.demideilan531.workers.dev/tasks/');
  url.pathname = '/sport/'; url.search = ''; url.hash = '';
  if (date) url.searchParams.set('date', validDate(date));
  return url.toString();
}

const PROMPT_TEXT = {
  sleep: 'Как спалось? Ответь, например: «Хорошо, спал 7,5 часов».',
  meal: 'Что было на приём пищи? Пришли текст или фото с подписью: «Овсянка, 400 ккал, Б 20 Ж 10 У 55». Фото не сохраняю, КБЖУ записываю из подписи.',
  evening: 'Сколько сегодня воды и шагов? Например: «Воды 2 л, шаги 8500, питание по плану». Запишу только указанные данные.',
  water: 'Сколько всего воды выпил за день? Например: «2 л» или «1750 мл». Укажи единицы измерения.',
  steps: 'Сколько шагов прошёл за день? Например: «8500 шагов» или просто «8500».',
};

async function createPrompt(db, env, telegramApi, { owner, kind, label, date, time, id = crypto.randomUUID(), questionText }) {
  const now = new Date(), expires = new Date(now.getTime() + 18 * 3600000).toISOString();
  await db.prepare(`INSERT INTO sport_prompts (id,owner_id,chat_id,kind,label,date,time,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, owner, owner, kind, label, date, time, now.toISOString(), expires).run();
  const sent = await telegramApi(env, 'sendMessage', { chat_id: owner, text: `${label}\n${date}\n${questionText || PROMPT_TEXT[kind]}`, reply_markup: { force_reply: true, selective: true, input_field_placeholder: kind === 'meal' ? 'Название, ккал, Б, Ж, У' : 'Ответ для спортивного дневника' } });
  if (!sent?.result?.message_id) throw new Error('Telegram did not confirm reminder delivery');
  await db.prepare('UPDATE sport_prompts SET message_id = ? WHERE id = ? AND owner_id = ?').bind(sent.result.message_id, id, owner).run();
  await db.prepare('INSERT INTO sport_prompt_messages (owner_id,chat_id,message_id,prompt_id) VALUES (?,?,?,?)').bind(owner, owner, sent.result.message_id, id).run();
  return id;
}

export async function handleSportUpdate(update, env, { telegramApi, sendMessage }) {
  const message = update.message;
  if (!message?.from?.id || message.chat?.type !== 'private' || String(message.from.id) !== String(message.chat.id)) return false;
  const owner = String(message.from.id), db = env.TASKS_DB;
  const command = String(message.text || '').trim();
  if (/^\/sport(?:@\w+)?$/i.test(command) || command === BUTTON_SPORT) {
    await telegramApi(env, 'sendMessage', { chat_id: owner, text: 'Спортивный дневник: записи дня, питание, прогресс и личные напоминания.', reply_markup: { inline_keyboard: [[{ text: 'Открыть Спорт', web_app: { url: sportAppUrl(env) } }]] } });
    return true;
  }
  let prompt = null;
  if (message.reply_to_message?.message_id) prompt = await db.prepare(`SELECT p.* FROM sport_prompts p
    LEFT JOIN sport_prompt_messages m ON m.prompt_id=p.id AND m.owner_id=p.owner_id
    WHERE p.owner_id=? AND p.chat_id=? AND (p.message_id=? OR m.message_id=?) ORDER BY p.created_at DESC LIMIT 1`)
    .bind(owner, String(message.chat.id), message.reply_to_message.message_id, message.reply_to_message.message_id).first();
  const photoMeal = Boolean(message.photo?.length) && /ккал|kcal|белк|(?:^|[\s,;])[бжу]\s*[:=-]?\s*\d/iu.test(message.caption || '');
  const direct = command.match(/^\/sport(?:@\w+)?\s+(сон|sleep|еда|meal|итоги|evening|вода|water|шаги|steps)\s+([\s\S]+)$/i);
  if (!prompt && !photoMeal && !direct) return false;
  if (prompt && (prompt.status !== 'pending' || prompt.expires_at < new Date().toISOString())) {
    await sendMessage(env, owner, 'Этот вопрос уже закрыт или устарел. Открой «Спорт», чтобы изменить запись нужного дня.');
    return true;
  }
  const kind = prompt?.kind || (photoMeal ? 'meal' : { сон: 'sleep', sleep: 'sleep', еда: 'meal', meal: 'meal', итоги: 'evening', evening: 'evening', вода: 'water', water: 'water', шаги: 'steps', steps: 'steps' }[direct[1].toLowerCase()]);
  const source = direct ? direct[2] : message.text || message.caption || '';
  let parsed;
  try { parsed = parseSportReply(kind, source); } catch { parsed = null; }
  if (!parsed) {
    if (!prompt) {
      const profile = await profileFor(db, owner), local = localParts(new Date(), profile.timezone);
      await createPrompt(db, env, telegramApi, { owner, kind, label: REMINDER_LABELS[kind], ...local, questionText: `Не удалось разобрать значения. ${PROMPT_TEXT[kind]}` });
      return true;
    }
    // Keep the original question active; no partial guesses or photo references are stored.
    const clarification = await telegramApi(env, 'sendMessage', { chat_id: owner, text: `Не удалось разобрать значения. ${PROMPT_TEXT[kind]}`, reply_parameters: { message_id: message.message_id }, reply_markup: { force_reply: true, selective: true } });
    if (prompt && clarification?.result?.message_id) {
      await db.prepare('INSERT OR IGNORE INTO sport_prompt_messages (owner_id,chat_id,message_id,prompt_id) VALUES (?,?,?,?)').bind(owner, owner, clarification.result.message_id, prompt.id).run();
    }
    return true;
  }
  const profile = await profileFor(db, owner), local = localParts(new Date((message.date || Date.now() / 1000) * 1000), profile.timezone);
  const date = prompt?.date || local.date;
  const updateKey = `sport:${owner}:${update.update_id ?? message.message_id}`;
  const inserted = await db.prepare('INSERT OR IGNORE INTO sport_updates (id,owner_id,created_at) VALUES (?,?,?)').bind(updateKey, owner, new Date().toISOString()).run();
  if (!inserted.meta?.changes) return true;
  try {
    if (prompt) {
      const claim = await db.prepare("UPDATE sport_prompts SET status='processing' WHERE id=? AND owner_id=? AND status='pending'").bind(prompt.id, owner).run();
      if (!claim.meta?.changes) return true;
    }
    if (parsed.day) await saveDay(db, owner, date, parsed.day);
    if (parsed.meal) {
      const stableId = prompt ? `prompt_${prompt.id}` : `tg_${owner}_${message.message_id}`;
      await saveMeal(db, owner, { ...parsed.meal, id: stableId, date, time: prompt?.time || local.time }, 'telegram');
    }
    if (prompt) await db.prepare("UPDATE sport_prompts SET status='completed' WHERE id=? AND owner_id=?").bind(prompt.id, owner).run();
  } catch {
    if (prompt) await db.prepare("UPDATE sport_prompts SET status='pending' WHERE id=? AND owner_id=? AND status='processing'").bind(prompt.id, owner).run();
    await db.prepare('DELETE FROM sport_updates WHERE id=? AND owner_id=?').bind(updateKey, owner).run();
    await sendMessage(env, owner, 'Не удалось сохранить запись. Данные не подтверждены: повтори ответ или открой «Спорт».');
    return true;
  }
  const summary = parsed.day ? Object.entries(parsed.day).map(([k, v]) => `${{ sleep_hours: 'Сон, ч', sleep_quality: 'Качество сна', water_ml: 'Вода, мл', steps: 'Шаги', nutrition: 'Питание по плану' }[k]}: ${v === true ? 'да' : v === false ? 'нет' : v}`).join('\n')
    : `${parsed.meal.title}\n${Object.entries(MEAL_NUMBERS).filter(([k]) => parsed.meal[k] != null).map(([k]) => `${{ calories_kcal: 'ккал', protein_g: 'Б', fat_g: 'Ж', carbs_g: 'У' }[k]}: ${parsed.meal[k]}`).join(' · ')}`;
  await sendMessage(env, owner, `Сохранено за ${date}\n${summary}`);
  return true;
}

export async function runSportReminders(controller, env, { telegramApi }) {
  if (env.SPORT_ENABLED !== 'true' || controller.cron !== SPORT_CRON) return 0;
  const db = env.TASKS_DB, now = new Date(controller.scheduledTime || Date.now()), nowIso = now.toISOString();
  const rows = (await db.prepare(`SELECT r.*, p.timezone FROM sport_reminders r JOIN sport_profiles p ON p.owner_id=r.owner_id
    WHERE r.enabled=1 AND r.next_due_at <= ? ORDER BY r.next_due_at LIMIT 20`).bind(nowIso).all()).results || [];
  let sent = 0;
  for (const reminder of rows) {
    const owner = reminder.owner_id, next = nextReminderDue(reminder, reminder.timezone, now);
    const occurrenceDate = localParts(new Date(reminder.next_due_at), reminder.timezone).date;
    const id = `${reminder.id}:${occurrenceDate}:${reminder.time}`;
    const claim = await db.prepare('INSERT OR IGNORE INTO sport_deliveries (id,owner_id,created_at) VALUES (?,?,?)').bind(id, owner, nowIso).run();
    await db.prepare('UPDATE sport_reminders SET next_due_at=? WHERE id=? AND owner_id=? AND next_due_at=?').bind(next, reminder.id, owner, reminder.next_due_at).run();
    if (!claim.meta?.changes) continue;
    const access = await getAssistantAccess(env, { id: owner });
    if (!access || now.getTime() - Date.parse(reminder.next_due_at) > 30 * 60000) {
      await db.prepare("UPDATE sport_deliveries SET status='skipped' WHERE id=?").bind(id).run();
      continue;
    }
    try {
      if (reminder.mode === 'question') {
        await createPrompt(db, env, telegramApi, { owner, kind: reminder.kind, label: reminder.label, date: occurrenceDate, time: reminder.time });
      } else {
        const message = {
          sleep: 'Пора отметить сон в дневнике.', meal: 'Пора записать приём пищи и КБЖУ.',
          evening: 'Пора отметить воду, шаги и итоги дня.', water: 'Пора отметить, сколько воды выпито.', steps: 'Пора записать шаги за день.',
        };
        const sentMessage = await telegramApi(env, 'sendMessage', {
          chat_id: owner, text: `${reminder.label}\n${occurrenceDate}\n${message[reminder.kind]}`,
          reply_markup: { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: sportAppUrl(env, occurrenceDate) } }]] },
        });
        if (!sentMessage?.result?.message_id) throw new Error('Telegram did not confirm reminder delivery');
      }
      await db.prepare("UPDATE sport_deliveries SET status='sent' WHERE id=?").bind(id).run();
      sent++;
    } catch {
      // Do not auto-retry an ambiguous send: Telegram may have received it before a timeout.
      await db.prepare("UPDATE sport_deliveries SET status='failed' WHERE id=?").bind(id).run();
      console.error('Sport reminder delivery failed');
    }
  }
  if (now.getUTCMinutes() === 0) {
    const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
    await db.batch([
      db.prepare('DELETE FROM sport_deliveries WHERE created_at < ?').bind(cutoff),
      db.prepare('DELETE FROM sport_updates WHERE created_at < ?').bind(cutoff),
      db.prepare('DELETE FROM sport_prompts WHERE expires_at < ?').bind(cutoff),
    ]);
  }
  return sent;
}
