import { getAssistantAccess } from './access.js';

export const REFERENCE_SHEET_ID = '1apTYgJfkNRU_Cs_w9p0VtXaA41fM1N0cROG2fhoTjtk';
export const DIARY_HEADERS = ['Дата', 'Вес (кг)', 'Сон (ч)', 'Вода (л)', 'Шаги', 'Тренировка', 'Питание в норме?', 'Настроение / Стресс', 'Комментарий клиента', 'Заметка тренера'];
export const TEMPLATE_TABS = ['Дневник (Ежедневно)', 'Дашборд и Аналитика', 'Справочник и Цели'];
const TRAINING = { rest: 'Отдых', strength: 'Силовая', cardio: 'Кардио', stretch: 'Растяжка / МФР', other: 'Другое' };
const MOOD = ['', 'Ужасно', 'Плохо', 'Норма', 'Хорошо', 'Отлично'];
const ERRORS = {
  not_configured: 'Служебный доступ Google ещё не настроен.',
  google_access: 'Нет доступа редактора к выбранной таблице.',
  template: 'Нужна таблица с тремя вкладками и столбцами дневника как в примере.',
  verification: 'Не подтверждено право редактирования таблицы.',
  sync: 'Не удалось выгрузить данные. Следующая попытка будет позже.',
};
let cachedToken;

function error(code) { const e = new Error(ERRORS[code] || ERRORS.sync); e.code = code; return e; }
function hasTemplateTabs(metadata) {
  return metadata.sheets?.length === TEMPLATE_TABS.length && TEMPLATE_TABS.every(title => metadata.sheets.some(s => s.properties.title === title));
}
function credentials(env) {
  try {
    const value = JSON.parse(env.GOOGLE_SHEETS_SERVICE_ACCOUNT || '{}');
    return value.client_email && value.private_key && value.type === 'service_account' ? value : null;
  } catch { return null; }
}

export function normalizeSheetUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Вставь ссылку на Google-таблицу.'); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,100})(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || !match) throw new Error('Нужна ссылка https://docs.google.com/spreadsheets/d/...');
  if (match[1] === REFERENCE_SHEET_ID) throw new Error('Исходная таблица-пример защищена от записи. Укажи свою копию.');
  return `https://docs.google.com/spreadsheets/d/${match[1]}/edit`;
}

function configResult(row, env) {
  const account = credentials(env);
  return {
    spreadsheet_url: row ? `https://docs.google.com/spreadsheets/d/${row.spreadsheet_id}/edit` : '',
    enabled: Boolean(row?.enabled), configured: Boolean(account), service_email: account?.client_email || '',
    verification_code: row?.verification_code || null, verified: Boolean(row?.verified_at),
    last_sync_at: row?.last_sync_at || null,
    status: !account ? 'not_configured' : row?.error_code ? 'error' : row?.enabled ? 'ready' : 'disabled',
    error: row?.error_code ? ERRORS[row.error_code] || ERRORS.sync : null,
  };
}

export async function getSheetExportConfig(db, owner, env) {
  return configResult(await db.prepare('SELECT * FROM sport_sheet_exports WHERE owner_id=?').bind(String(owner)).first(), env);
}

function base64url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function accessToken(env) {
  const account = credentials(env);
  if (!account) throw error('not_configured');
  if (cachedToken?.email === account.client_email && cachedToken.expires > Date.now()) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const der = account.private_key.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(der), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}` }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw error('google_access');
  const result = await response.json();
  if (!result.access_token) throw error('google_access');
  cachedToken = { email: account.client_email, token: result.access_token, expires: Date.now() + 50 * 60000 };
  return result.access_token;
}

async function google(env, id, suffix, options = {}) {
  if (id === REFERENCE_SHEET_ID) throw error('template');
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}${suffix}`, {
    ...options, headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json', 'User-Agent': 'GCodRevit-Sport-Sheets-Sync' }, signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw error([401, 403, 404].includes(response.status) ? 'google_access' : 'sync');
  return response.json();
}

export async function saveSheetExportConfig(db, ownerValue, env, input) {
  const owner = String(ownerValue);
  if (!input || typeof input.spreadsheet_url !== 'string' || typeof input.enabled !== 'boolean') throw new Error('Укажи ссылку и состояние выгрузки.');
  const url = normalizeSheetUrl(input.spreadsheet_url), id = url.split('/')[5];
  const old = await db.prepare('SELECT * FROM sport_sheet_exports WHERE owner_id=?').bind(owner).first();
  const occupied = await db.prepare('SELECT owner_id FROM sport_sheet_exports WHERE spreadsheet_id=? AND owner_id!=?').bind(id, owner).first();
  if (occupied) throw new Error('Таблица уже привязана к другому пользователю бота.');
  const same = old?.spreadsheet_id === id;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sheet-owner:${owner}:${id}`)));
  const code = same ? old.verification_code : `GCOD-${[...digest.slice(0, 5)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  let verified = same ? old.verified_at : null;
  if (input.enabled) {
    if (!credentials(env)) throw error('not_configured');
    const metadata = await google(env, id, '?fields=properties(title),sheets(properties(sheetId,title,gridProperties(rowCount)))');
    if (!hasTemplateTabs(metadata)) throw error('template');
    const diary = metadata.sheets.find(s => s.properties.title === TEMPLATE_TABS[0]).properties;
    if (!Number.isInteger(diary.gridProperties?.rowCount) || diary.gridProperties.rowCount < 2 || diary.gridProperties.rowCount > 20000) throw error('template');
    const header = await google(env, id, `/values/${encodeURIComponent(`'${TEMPLATE_TABS[0]}'!A1:J1`)}`);
    if (!DIARY_HEADERS.every((name, index) => header.values?.[0]?.[index] === name)) throw error('template');
    if (!verified && !metadata.properties?.title?.includes(code)) {
      throw new Error(`Для подтверждения доступа добавь ${code} в название своей таблицы и снова включи выгрузку. После подтверждения код можно убрать.`);
    }
    verified ||= new Date().toISOString();
    await google(env, id, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ setDataValidation: {
      range: { sheetId: diary.sheetId, startRowIndex: 1, endRowIndex: diary.gridProperties.rowCount, startColumnIndex: 5, endColumnIndex: 6 },
      rule: { condition: { type: 'ONE_OF_LIST', values: Object.values(TRAINING).map(userEnteredValue => ({ userEnteredValue })) }, strict: true, showCustomUi: true },
    } }] }) });
  }
  const now = new Date().toISOString();
  await db.prepare('INSERT OR IGNORE INTO sport_profiles (owner_id,updated_at) VALUES (?,?)').bind(owner, now).run();
  await db.prepare(`INSERT INTO sport_sheet_exports (owner_id,spreadsheet_id,enabled,verification_code,verified_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET spreadsheet_id=excluded.spreadsheet_id, enabled=excluded.enabled, verification_code=excluded.verification_code,
    verified_at=excluded.verified_at, lease_token=NULL, lease_until=NULL, last_sync_date=CASE WHEN spreadsheet_id=excluded.spreadsheet_id THEN last_sync_date ELSE NULL END,
    last_sync_at=CASE WHEN spreadsheet_id=excluded.spreadsheet_id THEN last_sync_at ELSE NULL END, error_code=NULL, updated_at=excluded.updated_at`)
    .bind(owner, id, Number(input.enabled), code, verified, now).run();
  return getSheetExportConfig(db, owner, env);
}

function value(v) { return v === null || v === undefined ? '' : v; }
function nutritionText(meals) {
  const lines = meals.map(m => `${m.time} ${m.title}: ${value(m.calories_kcal) === '' ? '—' : m.calories_kcal} ккал; Б ${value(m.protein_g) === '' ? '—' : m.protein_g} г, Ж ${value(m.fat_g) === '' ? '—' : m.fat_g} г, У ${value(m.carbs_g) === '' ? '—' : m.carbs_g} г${m.note ? `; ${m.note}` : ''}`);
  const fields = ['calories_kcal', 'protein_g', 'fat_g', 'carbs_g'];
  const totals = fields.map(k => {
    const known = meals.filter(m => m[k] != null);
    return known.length ? `${Math.round(known.reduce((n, m) => n + m[k], 0) * 10) / 10}${known.length < meals.length ? ' (неполные данные)' : ''}` : '—';
  });
  return meals.length ? [`Питание за день: ${totals[0]} ккал; Б ${totals[1]} г, Ж ${totals[2]} г, У ${totals[3]} г.`, ...lines].join('\n') : '';
}

export function buildDiaryRows(days, meals) {
  const byDate = new Map(days.map(d => [d.date, d])), food = new Map();
  for (const meal of meals) { if (!food.has(meal.date)) food.set(meal.date, []); food.get(meal.date).push(meal); if (!byDate.has(meal.date)) byDate.set(meal.date, { date: meal.date }); }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => [
    day.date, value(day.weight_kg), value(day.sleep_hours), day.water_ml == null ? '' : day.water_ml / 1000,
    value(day.steps), TRAINING[day.training] || '', day.nutrition == null ? '' : Boolean(day.nutrition),
    day.mood == null ? '' : `${day.mood} - ${MOOD[day.mood]}`,
    [day.comment, nutritionText(food.get(day.date) || [])].filter(Boolean).join('\n\n').slice(0, 45000), day.coach_note || '',
  ]);
}

function dateFromCell(v) {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  if (typeof v !== 'string') return '';
  if (/^20\d{2}-\d{2}-\d{2}$/.test(v)) return v;
  const match = v.match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}

export async function exportSportSheet(db, env, config) {
  const id = config.spreadsheet_id, owner = config.owner_id;
  if (id === REFERENCE_SHEET_ID) throw error('template');
  const metadata = await google(env, id, '?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))');
  if (!hasTemplateTabs(metadata)) throw error('template');
  const diary = metadata.sheets.find(s => s.properties.title === TEMPLATE_TABS[0]).properties;
  const maxRows = Math.min(diary.gridProperties.rowCount, 20000);
  const range = `'${TEMPLATE_TABS[0]}'!A1:J${maxRows}`;
  const current = await google(env, id, `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  if (!DIARY_HEADERS.every((h, i) => current.values?.[0]?.[i] === h)) throw error('template');
  const days = (await db.prepare('SELECT * FROM sport_days WHERE owner_id=? ORDER BY date LIMIT 10000').bind(owner).all()).results || [];
  const meals = (await db.prepare('SELECT * FROM sport_meals WHERE owner_id=? ORDER BY date,time LIMIT 100000').bind(owner).all()).results || [];
  if (days.length >= 10000 || meals.length >= 100000 || diary.gridProperties.rowCount > 20000) throw error('sync');
  const rows = buildDiaryRows(days, meals), existing = new Map();
  const assertActive = async () => {
    if (!config.lease_token) return;
    const active = await db.prepare('SELECT enabled,spreadsheet_id,lease_token FROM sport_sheet_exports WHERE owner_id=?').bind(owner).first();
    if (!active?.enabled || active.spreadsheet_id !== id || active.lease_token !== config.lease_token) throw error('sync');
  };
  (current.values || []).slice(1).forEach((row, index) => { const date = dateFromCell(row[0]); if (date && !existing.has(date)) existing.set(date, { index: index + 2, row }); });
  let nextRow = Math.max(2, (current.values?.length || 1) + 1);
  const data = rows.map(row => {
    const previous = existing.get(row[0]), index = previous?.index || nextRow++;
    if (!row[9] && previous?.row[9]) row[9] = previous.row[9];
    // Native date numbers keep COUNT/AVERAGEIFS in the existing dashboard working.
    const serial = (Date.parse(`${row[0]}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
    return { range: `'${TEMPLATE_TABS[0]}'!A${index}:J${index}`, values: [[serial, ...row.slice(1)]] };
  });
  const profile = await db.prepare('SELECT goals_json FROM sport_profiles WHERE owner_id=?').bind(owner).first();
  const goals = JSON.parse(profile?.goals_json || '{}');
  [['sleep_hours', 2], ['steps', 3], ['water_ml', 4], ['weight_kg', 5]].forEach(([key, row]) => {
    if (goals[key] != null) data.push({ range: `'${TEMPLATE_TABS[2]}'!B${row}`, values: [[key === 'water_ml' ? goals[key] / 1000 : goals[key]]] });
  });
  const additions = nextRow - 1 - diary.gridProperties.rowCount;
  const formatRequests = additions > 0 ? [
    { appendDimension: { sheetId: diary.sheetId, dimension: 'ROWS', length: additions } },
    ...['PASTE_FORMAT', 'PASTE_DATA_VALIDATION'].map(pasteType => ({ copyPaste: {
      source: { sheetId: diary.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 10 },
      destination: { sheetId: diary.sheetId, startRowIndex: diary.gridProperties.rowCount, endRowIndex: nextRow - 1, startColumnIndex: 0, endColumnIndex: 10 }, pasteType,
    } })),
  ] : [];
  if (formatRequests.length) { await assertActive(); await google(env, id, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: formatRequests }) }); }
  let batch = [], bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await assertActive();
    await google(env, id, '/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: batch }) });
    batch = []; bytes = 0;
  };
  for (const item of data) {
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (batch.length >= 300 || bytes + size > 1500000) await flush();
    batch.push(item); bytes += size;
  }
  await flush();
  return rows.length;
}

export async function runSportSheetExports(controller, env) {
  if (env.SPORT_ENABLED !== 'true' || controller.cron !== '* * * * *' || !credentials(env)) return 0;
  const now = new Date(controller.scheduledTime || Date.now()), iso = now.toISOString(), db = env.TASKS_DB;
  const rows = (await db.prepare(`SELECT e.*, p.timezone FROM sport_sheet_exports e JOIN sport_profiles p ON p.owner_id=e.owner_id
    WHERE e.enabled=1 AND e.verified_at IS NOT NULL AND (e.lease_until IS NULL OR e.lease_until < ?) ORDER BY e.last_attempt_at LIMIT 100`).bind(iso).all()).results || [];
  let count = 0, attempted = 0;
  for (const row of rows) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
    const initialSync = !row.last_sync_at;
    if ((time < '03:15' && !initialSync) || row.last_sync_date === date || (row.error_code && row.last_attempt_at && now.getTime() - Date.parse(row.last_attempt_at) < 3600000)) continue;
    if (!await getAssistantAccess(env, { id: row.owner_id })) continue;
    const token = crypto.randomUUID(), until = new Date(now.getTime() + 10 * 60000).toISOString();
    // A completed parallel tick must invalidate this snapshot before another claim.
    const claimed = await db.prepare(`UPDATE sport_sheet_exports SET lease_token=?,lease_until=?,last_attempt_at=?
      WHERE owner_id=? AND enabled=1 AND (lease_until IS NULL OR lease_until < ?)
      AND spreadsheet_id=? AND verified_at IS ? AND last_sync_at IS ? AND last_sync_date IS ?
      AND last_attempt_at IS ? AND error_code IS ?`).bind(token, until, iso, row.owner_id, iso,
      row.spreadsheet_id, row.verified_at ?? null, row.last_sync_at ?? null, row.last_sync_date ?? null,
      row.last_attempt_at ?? null, row.error_code ?? null).run();
    if (!claimed.meta?.changes) continue;
    attempted++;
    try {
      await exportSportSheet(db, env, { ...row, lease_token: token });
      const scheduledDate = time < '03:15' ? row.last_sync_date : date;
      await db.prepare('UPDATE sport_sheet_exports SET last_sync_at=?,last_sync_date=?,error_code=NULL,lease_until=NULL,lease_token=NULL WHERE owner_id=? AND lease_token=? AND spreadsheet_id=?').bind(iso, scheduledDate, row.owner_id, token, row.spreadsheet_id).run();
      count++;
    } catch (e) {
      await db.prepare('UPDATE sport_sheet_exports SET error_code=?,lease_until=NULL,lease_token=NULL WHERE owner_id=? AND lease_token=?').bind(e.code || 'sync', row.owner_id, token).run();
      console.error('Sport sheet export failed');
    }
    if (attempted >= 5) break;
  }
  return count;
}
