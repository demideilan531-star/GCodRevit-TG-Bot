const telegram = window.Telegram?.WebApp;
const demoMode = new URLSearchParams(location.search).get("demo") === "1";
const $ = (id) => document.getElementById(id);
const dayNumbers = ["weight_kg", "sleep_hours", "sleep_quality", "water_ml", "steps", "mood"];
const dayTexts = ["training", "comment", "coach_note"];
const macroKeys = ["calories_kcal", "protein_g", "fat_g", "carbs_g"];
const goalKeys = ["weight_kg", "sleep_hours", "water_ml", "steps", ...macroKeys];
const trainingLabels = { rest: "Отдых", strength: "Силовая", cardio: "Кардио", stretch: "Растяжка", other: "Другое" };
const reminderLabels = { sleep: "Сон утром", meal: "Приём пищи", evening: "Вода и шаги вечером", water: "Вода", steps: "Шаги" };
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const shortDateFormat = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

function zonedToday(timezone = browserZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function utcDate(value) { return new Date(`${value}T12:00:00Z`); }
function addDays(value, count) {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function validDate(value) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(utcDate(value).getTime()) && utcDate(value).toISOString().slice(0, 10) === value;
}
function dayRange(from, to) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error("Проверьте диапазон дат.");
  const count = Math.round((utcDate(to) - utcDate(from)) / 86400000) + 1;
  if (count > 93) throw new Error("Допустимый диапазон: до 93 дней.");
  return Array.from({ length: count }, (_, index) => addDays(from, index));
}
function monthRange(month) {
  const first = `${month}-01`;
  if (!validDate(first)) throw new Error("Проверьте месяц.");
  const last = utcDate(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return [first, last.toISOString().slice(0, 10)];
}
function numeric(value) { return value === "" || value === null || value === undefined ? null : Number(value); }
function isValue(value) { return typeof value === "number" && Number.isFinite(value); }
function fmt(value) { return isValue(value) ? numberFormat.format(value) : "—"; }
function average(values) {
  const observed = values.filter(isValue);
  return { value: observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null, count: observed.length };
}
function totals(meals, key) {
  const observed = meals.map((meal) => numeric(meal[key])).filter(isValue);
  return observed.length ? observed.reduce((sum, value) => sum + value, 0) : null;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name) {
  const element = node("i");
  element.dataset.lucide = name;
  element.setAttribute("aria-hidden", "true");
  return element;
}
function renderIcons() { window.lucide?.createIcons({ attrs: { "aria-hidden": "true", focusable: "false" } }); }
function status(id, text, kind = "") {
  $(id).textContent = text;
  $(id).dataset.state = kind;
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3500);
}
function errorText(error) { return error instanceof Error ? error.message : "Не удалось выполнить запрос."; }
function confirmDiscard() { return window.confirm("Есть несохранённые изменения. Отменить их?"); }

function emptySheetExport() {
  return { spreadsheet_url: "", enabled: false, configured: false, service_email: "", verification_code: null, verified: false, last_sync_at: null, status: "not_configured", error: null };
}

function sheetDestination(value) {
  if (!value) throw new Error("Укажите ссылку на копию шаблона.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Укажите корректную ссылку Google Sheets."); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,100})(?:\/|$)/);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.port || url.username || url.password || !match) {
    throw new Error("Нужна ссылка https://docs.google.com/spreadsheets/d/…");
  }
  if (match[1] === "1apTYgJfkNRU_Cs_w9p0VtXaA41fM1N0cROG2fhoTjtk") {
    throw new Error("Исходный шаблон защищён. Укажите ссылку на свою копию.");
  }
  return match[1];
}

const state = {
  today: zonedToday(), selected: zonedToday(), month: zonedToday().slice(0, 7),
  days: new Map(), meals: new Map(), loaded: new Set(), requests: new Map(),
  profile: { timezone: browserZone, goals: Object.fromEntries(goalKeys.map((key) => [key, null])) },
  reminders: [], trainingTypes: Object.keys(trainingLabels), view: "today", period: 7,
  dayBaseline: {}, dayTouched: new Set(), dayBusy: false, navigationBusy: false,
  settingsDirty: false, settingsBusy: false, mealBusy: false, mealDirty: false,
  sheetExport: emptySheetExport(), sheetExportDirty: false, sheetExportBusy: false,
  mealId: null, mealIsNew: false, dataEpoch: 0, calendarRequest: 0, progressRequest: 0,
};

// Demo data never touches production storage or fetch. All values are fictional.
function makeDemo() {
  const today = zonedToday("Europe/Moscow");
  const days = new Map();
  const meals = new Map();
  for (let i = 0; i < 45; i++) {
    const date = addDays(today, -i);
    if (i % 9 === 5) continue;
    days.set(date, {
      date, weight_kg: i % 6 === 0 ? null : Math.round((73.2 + i * .025 + Math.sin(i) * .2) * 10) / 10,
      sleep_hours: Math.round((6.5 + (i % 5) * .3) * 10) / 10, sleep_quality: 3 + i % 3,
      water_ml: i === 0 ? 1250 : 1500 + (i % 5) * 250, steps: i === 0 ? 4820 : 5100 + (i * 731) % 6200,
      training: ["rest", "strength", "cardio", "rest", "stretch"][i % 5],
      mood: i % 3 === 0 ? 4 : null, nutrition: i % 4 === 0 ? null : i % 4 !== 3,
      comment: i === 0 ? "Прогулка после обеда" : "",
      coach_note: i === 2 ? "Лёгкая нагрузка, без спешки" : "",
    });
    if (i % 5 === 4) continue;
    const examples = [
      ["08:30", "Овсянка с ягодами", 380, 14, 11, 55],
      ["13:15", "Рис, овощи и индейка", 540, 39, 16, 60],
      ["19:00", "Омлет и салат", 410, 27, 25, 18],
    ];
    for (let m = 0; m < (i === 0 ? 2 : 3); m++) {
      const [time, title, calories_kcal, protein_g, fat_g, carbs_g] = examples[m];
      const id = `fictional-${date}-${m}`;
      meals.set(id, { id, date, time, title, calories_kcal, protein_g, fat_g, carbs_g, note: "", source_type: "manual", nutrition_source: "manual" });
    }
  }
  return { today, days, meals, profile: { timezone: "Europe/Moscow", goals: Object.fromEntries(goalKeys.map((key) => [key, null])) }, reminders: [], sheet_export: emptySheetExport() };
}
const demoStore = demoMode ? makeDemo() : null;

function csvText(rows, keys) {
  const cell = (value) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+@\-\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\ufeff" + [keys, ...rows.map((row) => keys.map((key) => row[key]))].map((row) => row.map(cell).join(";")).join("\r\n");
}

async function demoRequest(path, options) {
  const url = new URL(`/api/sport${path}`, location.origin);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  const date = decodeURIComponent(url.pathname.split("/").at(-1));
  if (url.pathname.endsWith("/export")) {
    const kind = url.searchParams.get("kind");
    const store = kind === "days" ? demoStore.days : demoStore.meals;
    const rows = [...store.values()].filter((row) => row.date >= url.searchParams.get("from") && row.date <= url.searchParams.get("to")).sort((a, b) => a.date.localeCompare(b.date));
    const keys = kind === "days" ? ["date", ...dayNumbers, ...dayTexts, "nutrition"] : ["id", "date", "time", "title", ...macroKeys, "note", "source_type", "nutrition_source"];
    return new Blob([csvText(rows, keys)], { type: "text/csv;charset=utf-8" });
  }
  if (method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    dayRange(from, to);
    return structuredClone({
      days: [...demoStore.days.values()].filter((day) => day.date >= from && day.date <= to),
      meals: [...demoStore.meals.values()].filter((meal) => meal.date >= from && meal.date <= to),
      today: demoStore.today, profile: demoStore.profile, reminders: demoStore.reminders, training_types: Object.keys(trainingLabels),
      sheet_export: demoStore.sheet_export,
    });
  }
  if (url.pathname.includes("/days/") && method === "PUT") {
    const day = { ...demoStore.days.get(date), date, ...body };
    demoStore.days.set(date, day);
    return structuredClone({ day });
  }
  if (url.pathname.endsWith("/settings") && method === "PUT") {
    demoStore.profile = { timezone: body.timezone, goals: body.goals };
    demoStore.reminders = body.reminders.map((reminder) => ({ ...reminder, id: reminder.id || crypto.randomUUID() }));
    demoStore.today = zonedToday(body.timezone);
    return structuredClone({ profile: demoStore.profile, reminders: demoStore.reminders });
  }
  if (url.pathname.endsWith("/sheet-export") && method === "PUT") {
    const id = sheetDestination(body.spreadsheet_url);
    if (body.enabled && !demoStore.sheet_export.configured) throw new Error("Google не подключён. Можно сохранить ссылку с выключенной выгрузкой.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sheet-owner:fictional-demo:${id}`)));
    const verification_code = `GCOD-DEMO-${[...digest.slice(0, 5)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    demoStore.sheet_export = { ...emptySheetExport(), spreadsheet_url: `https://docs.google.com/spreadsheets/d/${id}/edit`, verification_code };
    return structuredClone({ sheet_export: demoStore.sheet_export });
  }
  if (method === "DELETE") { demoStore.meals.delete(date); return {}; }
  const id = method === "POST" ? body.id : date;
  // POST repeats with the same id return the original, just like the server contract.
  const meal = method === "POST" && demoStore.meals.has(id) ? demoStore.meals.get(id) : { ...demoStore.meals.get(id), ...body, id, source_type: "manual", nutrition_source: "manual" };
  demoStore.meals.set(id, meal);
  return structuredClone({ meal });
}

async function api(path, options = {}, blob = false) {
  if (demoMode) return demoRequest(path, options);
  const initData = telegram?.initData;
  if (!initData) throw new Error("Откройте дневник кнопкой в Telegram-боте.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/sport${path}`, {
      ...options, signal: controller.signal, cache: "no-store", credentials: "same-origin",
      headers: { Authorization: `tma ${initData}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(typeof result.error === "string" ? result.error : `Ошибка HTTP ${response.status}. Повторите запрос.`);
    }
    if (blob) return await response.blob();
    if (response.status === 204) return {};
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Сервер не ответил вовремя. Повторите сохранение; введённые данные остались в форме.");
    if (error instanceof TypeError) throw new Error("Нет связи с сервером. Проверьте подключение и повторите запрос.");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function loadRange(from, to, { force = false, metadata = false } = {}) {
  const dates = dayRange(from, to);
  if (!force && dates.every((date) => state.loaded.has(date))) return;
  const key = `${from}:${to}`;
  if (state.requests.has(key)) {
    const accepted = await state.requests.get(key);
    if (accepted === false) return loadRange(from, to, { force: true, metadata });
    return;
  }
  const epoch = state.dataEpoch;
  const request = (async () => {
    const result = await api(`?${new URLSearchParams({ from, to })}`);
    if (!Array.isArray(result.days) || !Array.isArray(result.meals)) throw new Error("Сервер вернул некорректный дневник.");
    if (epoch !== state.dataEpoch) return false;
    for (const date of dates) state.days.delete(date);
    for (const [id, meal] of state.meals) if (meal.date >= from && meal.date <= to) state.meals.delete(id);
    result.days.forEach((day) => state.days.set(day.date, day));
    result.meals.forEach((meal) => state.meals.set(meal.id, meal));
    dates.forEach((date) => state.loaded.add(date));
    if (validDate(result.today)) state.today = result.today;
    if (metadata) {
      if (result.profile) state.profile = { timezone: result.profile.timezone || browserZone, goals: { ...state.profile.goals, ...result.profile.goals } };
      state.reminders = Array.isArray(result.reminders) ? result.reminders : [];
      state.trainingTypes = Array.isArray(result.training_types) ? result.training_types : Object.keys(trainingLabels);
      state.sheetExport = { ...emptySheetExport(), ...result.sheet_export };
    }
    return true;
  })();
  state.requests.set(key, request);
  let accepted;
  try { accepted = await request; }
  finally { if (state.requests.get(key) === request) state.requests.delete(key); }
  // A mutation completed during this read. Fetch again instead of overwriting it.
  if (accepted === false) return loadRange(from, to, { force: true, metadata });
}

function mealsOn(date) { return [...state.meals.values()].filter((meal) => meal.date === date).sort((a, b) => (a.time || "").localeCompare(b.time || "") || String(a.id).localeCompare(String(b.id))); }
function dayControl(name) { return $("dayForm").elements.namedItem(name); }
function dayValue(name) {
  const value = dayControl(name).value;
  if (name === "nutrition") return value === "" ? null : value === "yes";
  if (dayNumbers.includes(name)) return numeric(value);
  return name === "training" ? value || null : value.trim();
}
function dayPayload() { return Object.fromEntries([...state.dayTouched].map((name) => [name, dayValue(name)])); }
function dayHasData(day) { return day && [...dayNumbers, ...dayTexts, "nutrition"].some((key) => day[key] !== null && day[key] !== undefined && day[key] !== ""); }

function markDayChanged(name) {
  if (![...dayNumbers, ...dayTexts, "nutrition"].includes(name)) return;
  if (dayValue(name) === (state.dayBaseline[name] ?? null)) state.dayTouched.delete(name);
  else state.dayTouched.add(name);
  $("saveDay").disabled = !state.dayTouched.size || state.dayBusy;
  status("daySaveStatus", state.dayTouched.size ? "Не сохранено" : "Нет изменений", state.dayTouched.size ? "dirty" : "");
}

function renderDay() {
  const day = state.days.get(state.selected) || {};
  state.dayBaseline = structuredClone(day);
  state.dayTouched.clear();
  $("dayDate").value = state.selected;
  $("dayRelation").textContent = state.selected === state.today ? "СЕГОДНЯ" : "ДНЕВНИК";
  $("dayHeading").textContent = dateFormat.format(utcDate(state.selected));
  $("backToday").hidden = state.selected === state.today;
  $("dayDate").setAttribute("aria-label", `Дата записи: ${state.selected}`);
  for (const name of [...dayNumbers, ...dayTexts]) dayControl(name).value = day[name] ?? "";
  dayControl("nutrition").value = day.nutrition === true || day.nutrition === 1 ? "yes" : day.nutrition === false || day.nutrition === 0 ? "no" : "";
  // Compare against normalized controls: nullable numbers, boolean nutrition, string notes.
  state.dayBaseline = Object.fromEntries([...dayNumbers, ...dayTexts, "nutrition"].map((name) => [name, dayValue(name)]));
  $("dayRecordState").textContent = dayHasData(day) ? "Запись сохранена" : "Нет записи";
  $("saveDay").disabled = true;
  status("daySaveStatus", dayHasData(day) ? "Данные с сервера" : "Нет изменений");
  renderDaySummary();
  renderMeals();
}

function renderDaySummary() {
  const day = state.days.get(state.selected) || {};
  const specs = [["water_ml", "Вода", "мл"], ["steps", "Шаги", ""], ["sleep_hours", "Сон", "ч"]];
  $("daySummary").replaceChildren(...specs.map(([key, label, unit]) => {
    const item = node("div", "summary-item");
    const goal = numeric(state.profile.goals[key]);
    const value = numeric(day[key]);
    item.append(node("span", "", label), node("strong", "", fmt(value)), node("small", "", isValue(goal) ? `Цель ${fmt(goal)} ${unit}`.trim() : unit || "Цель не задана"));
    const meter = node("div", "mini-meter");
    const bar = node("b");
    bar.style.width = `${goal > 0 && isValue(value) ? Math.max(0, Math.min(100, value / goal * 100)) : 0}%`;
    meter.append(bar); item.append(meter);
    return item;
  }));
}

async function selectDate(date) {
  if (!validDate(date) || state.navigationBusy || state.dayBusy) { $("dayDate").value = state.selected; return; }
  if (date === state.selected) return;
  if (state.dayTouched.size && !confirmDiscard()) { $("dayDate").value = state.selected; return; }
  state.navigationBusy = true;
  $("dayFields").disabled = true;
  $("saveDay").disabled = true;
  status("daySaveStatus", "Загрузка…");
  try {
    await loadRange(date, date);
    state.selected = date;
    renderDay();
    await showView("today");
  } catch (error) {
    $("dayDate").value = state.selected;
    status("daySaveStatus", errorText(error), "error");
    toast(errorText(error));
  } finally {
    state.navigationBusy = false;
    $("dayFields").disabled = false;
    $("saveDay").disabled = !state.dayTouched.size;
  }
}

async function saveDay(event) {
  event.preventDefault();
  if (state.dayBusy || state.navigationBusy || !state.dayTouched.size || !$("dayForm").reportValidity()) return;
  const payload = dayPayload();
  const date = state.selected;
  state.dayBusy = true;
  $("dayFields").disabled = true;
  $("saveDay").disabled = true;
  status("daySaveStatus", "Сохранение…");
  try {
    const result = await api(`/days/${date}`, { method: "PUT", body: JSON.stringify(payload) });
    if (!result.day || result.day.date !== date) throw new Error("Нет подтверждения сервера. Повторите сохранение.");
    state.dataEpoch++;
    state.days.set(date, result.day);
    renderDay();
    status("daySaveStatus", demoMode ? "Сохранено в демо" : "Сохранено на сервере", "saved");
    telegram?.HapticFeedback?.notificationOccurred?.("success");
  } catch (error) { status("daySaveStatus", errorText(error), "error"); }
  finally {
    state.dayBusy = false;
    $("dayFields").disabled = false;
    $("saveDay").disabled = !state.dayTouched.size;
  }
}

function renderMeals() {
  const meals = mealsOn(state.selected);
  $("mealCount").textContent = `Приёмов: ${meals.length}`;
  const labels = ["ккал", "белки, г", "жиры, г", "углеводы, г"];
  $("macroTotals").replaceChildren(...macroKeys.map((key, index) => {
    const item = node("div");
    const observed = meals.filter((meal) => isValue(numeric(meal[key]))).length;
    item.append(node("strong", "", fmt(totals(meals, key))), node("span", "", labels[index]));
    if (meals.length) item.append(node("small", "", `${observed} из ${meals.length} приёмов`));
    if (observed < meals.length) item.append(node("small", "partial-note", "Неполная сумма"));
    return item;
  }));
  $("mealList").replaceChildren();
  if (!meals.length) $("mealList").append(node("p", "empty-state", "Приёмов пищи пока нет"));
  for (const meal of meals) {
    const row = node("button", "meal-row");
    row.type = "button";
    row.setAttribute("aria-label", `Изменить: ${meal.title}, ${meal.time?.slice(0, 5) || "время не указано"}`);
    const main = node("div");
    main.append(node("strong", "", meal.title), node("p", "", `${fmt(numeric(meal.calories_kcal))} ккал · Б ${fmt(numeric(meal.protein_g))} · Ж ${fmt(numeric(meal.fat_g))} · У ${fmt(numeric(meal.carbs_g))}`));
    if (meal.note) main.append(node("p", "meal-note", meal.note));
    row.append(node("span", "meal-time", meal.time?.slice(0, 5) || "—"), main, icon("pencil"));
    row.addEventListener("click", () => openMeal(meal));
    $("mealList").append(row);
  }
  renderIcons();
}

function mealControl(name) { return $("mealForm").elements.namedItem(name); }
function openMeal(meal = null) {
  state.mealId = meal?.id || crypto.randomUUID();
  state.mealIsNew = !meal;
  state.mealDirty = false;
  $("mealForm").reset();
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: state.profile.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  mealControl("date").value = meal?.date || state.selected;
  mealControl("time").value = meal?.time?.slice(0, 5) || time;
  for (const key of ["title", ...macroKeys, "note"]) mealControl(key).value = meal?.[key] ?? "";
  $("mealDialogTitle").textContent = meal ? "Приём пищи" : "Новый приём пищи";
  $("deleteMeal").hidden = !meal;
  status("mealSaveStatus", "");
  $("mealDialog").showModal();
}

function closeMeal() {
  if (state.mealBusy || (state.mealDirty && !confirmDiscard())) return;
  $("mealDialog").close();
  state.mealDirty = false;
}

function setMealBusy(busy) {
  state.mealBusy = busy;
  $("mealFields").disabled = busy;
  for (const id of ["saveMeal", "deleteMeal", "cancelMeal", "closeMeal"]) $(id).disabled = busy;
}

async function saveMeal(event) {
  event.preventDefault();
  if (state.mealBusy || !$("mealForm").reportValidity()) return;
  const title = mealControl("title").value.trim();
  if (!title) { status("mealSaveStatus", "Введите название приёма пищи.", "error"); return; }
  const body = Object.fromEntries(["date", "time", "title", "note"].map((key) => [key, mealControl(key).value.trim()]));
  macroKeys.forEach((key) => { body[key] = numeric(mealControl(key).value); });
  if (state.mealIsNew) body.id = state.mealId;
  setMealBusy(true);
  status("mealSaveStatus", "Сохранение…");
  try {
    let result = await api(state.mealIsNew ? "/meals" : `/meals/${encodeURIComponent(state.mealId)}`, { method: state.mealIsNew ? "POST" : "PATCH", body: JSON.stringify(body) });
    if (!result.meal || result.meal.id !== state.mealId) throw new Error("Нет подтверждения сервера. Повторите сохранение.");
    const wasNew = state.mealIsNew;
    state.mealIsNew = false;
    $("deleteMeal").hidden = false;
    state.meals.set(result.meal.id, result.meal);
    state.dataEpoch++;
    // A POST retry may return the earlier accepted version. Preserve edits made after a timeout.
    if (wasNew && !mealMatches(result.meal, body)) {
      const { id, ...changes } = body;
      result = await api(`/meals/${encodeURIComponent(state.mealId)}`, { method: "PATCH", body: JSON.stringify(changes) });
      if (!result.meal || result.meal.id !== state.mealId) throw new Error("Нет подтверждения сервера. Повторите сохранение.");
      state.dataEpoch++;
    }
    if (!mealMatches(result.meal, body)) throw new Error("Сервер вернул другие значения. Проверьте запись и повторите сохранение.");
    state.meals.set(result.meal.id, result.meal);
    state.mealDirty = false;
    $("mealDialog").close();
    renderMeals();
    toast(demoMode ? "Приём пищи сохранён в демо" : "Приём пищи сохранён на сервере");
  } catch (error) { status("mealSaveStatus", errorText(error), "error"); }
  finally { setMealBusy(false); }
}

function mealMatches(meal, body) {
  return ["date", "title", "note"].every((key) => (meal[key] ?? "") === body[key]) &&
    (meal.time || "").slice(0, 5) === body.time && macroKeys.every((key) => numeric(meal[key]) === body[key]);
}

async function deleteMeal() {
  if (state.mealBusy || !window.confirm("Удалить этот приём пищи?")) return;
  setMealBusy(true);
  status("mealSaveStatus", "Удаление…");
  try {
    await api(`/meals/${encodeURIComponent(state.mealId)}`, { method: "DELETE" });
    state.dataEpoch++;
    state.meals.delete(state.mealId);
    state.mealDirty = false;
    $("mealDialog").close();
    renderMeals();
    toast("Приём пищи удалён");
  } catch (error) { status("mealSaveStatus", errorText(error), "error"); }
  finally { setMealBusy(false); }
}

function renderCalendar(loading = false) {
  const [first, last] = monthRange(state.month);
  $("calendarMonth").value = state.month;
  const grid = $("calendarGrid");
  grid.replaceChildren();
  grid.setAttribute("aria-busy", String(loading));
  const offset = (utcDate(first).getUTCDay() + 6) % 7;
  for (let i = 0; i < offset; i++) { const spacer = node("span"); spacer.setAttribute("aria-hidden", "true"); grid.append(spacer); }
  for (const date of dayRange(first, last)) {
    const hasDay = !loading && dayHasData(state.days.get(date));
    const hasMeal = !loading && mealsOn(date).length > 0;
    const button = node("button", `calendar-cell${date === state.today ? " is-today" : ""}${date === state.selected ? " is-selected" : ""}`);
    button.type = "button";
    button.disabled = loading;
    button.setAttribute("aria-label", `${dateFormat.format(utcDate(date))}${hasDay ? ", есть запись" : ""}${hasMeal ? ", есть питание" : ""}`);
    if (date === state.today) button.setAttribute("aria-current", "date");
    button.append(node("span", "", String(Number(date.slice(-2)))));
    const dots = node("span", "dots");
    dots.setAttribute("aria-hidden", "true");
    if (hasDay) dots.append(node("b", "data-dot"));
    if (hasMeal) dots.append(node("b", "data-dot meal-dot"));
    button.append(dots);
    button.addEventListener("click", () => {
      if (date === state.selected) showView("today").catch((error) => toast(errorText(error)));
      else selectDate(date);
    });
    grid.append(button);
  }
  const monthDays = dayRange(first, last);
  $("monthSummary").replaceChildren();
  for (const [count, label] of [[monthDays.filter((date) => dayHasData(state.days.get(date))).length, "дней с записями"], [monthDays.filter((date) => mealsOn(date).length).length, "дней с питанием"]]) {
    const item = node("div"); item.append(node("strong", "", loading ? "—" : String(count)), node("span", "", label)); $("monthSummary").append(item);
  }
}

async function loadCalendar(force = false) {
  const request = ++state.calendarRequest;
  $("calendarError").hidden = true;
  $("calendarRetry").hidden = true;
  renderCalendar(true);
  try {
    await loadRange(...monthRange(state.month), { force });
    if (request === state.calendarRequest) renderCalendar();
  } catch (error) {
    if (request !== state.calendarRequest) return;
    $("calendarError").textContent = errorText(error);
    $("calendarError").hidden = false;
    $("calendarRetry").hidden = false;
    $("calendarGrid").setAttribute("aria-busy", "false");
  }
}

function changeMonth(offset) {
  const date = utcDate(`${state.month}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  state.month = date.toISOString().slice(0, 7);
  loadCalendar();
}

const chartSpecs = [
  { key: "weight_kg", label: "Вес", unit: "кг", color: "#237453" },
  { key: "sleep_hours", label: "Сон", unit: "ч", color: "#be5145" },
  { key: "water_ml", label: "Вода", unit: "мл", color: "#237453" },
  { key: "steps", label: "Шаги", unit: "шагов", color: "#be5145" },
  { key: "calories_kcal", label: "Энергия", unit: "ккал", color: "#237453", meal: true },
  { key: "protein_g", label: "Белки", unit: "г", color: "#be5145", meal: true },
  { key: "fat_g", label: "Жиры", unit: "г", color: "#237453", meal: true },
  { key: "carbs_g", label: "Углеводы", unit: "г", color: "#be5145", meal: true },
];
let chartObserver;
function progressDates() {
  const to = $("progressEnd").value;
  if (!validDate(to)) throw new Error("Выберите конечную дату.");
  return dayRange(addDays(to, 1 - state.period), to);
}

function chartValues(dates, spec) {
  return dates.map((date) => spec.meal ? totals(mealsOn(date), spec.key) : numeric(state.days.get(date)?.[spec.key]));
}

function chartPartial(dates, spec) {
  return dates.map((date) => {
    if (!spec.meal) return false;
    const meals = mealsOn(date);
    return meals.length > 0 && (date === state.today || meals.some((meal) => !isValue(numeric(meal[spec.key]))));
  });
}

function periodSummary(dates) {
  const days = dates.map((date) => state.days.get(date)).filter(Boolean);
  const trainings = days.filter((day) => state.trainingTypes.includes(day.training));
  const nutrition = days.filter((day) => day.nutrition === true || day.nutrition === false || day.nutrition === 1 || day.nutrition === 0);
  const yes = nutrition.filter((day) => day.nutrition === true || day.nutrition === 1).length;
  const mood = average(days.map((day) => numeric(day.mood)));
  return { trainingCount: trainings.filter((day) => day.training !== "rest").length, trainingObserved: trainings.length, nutritionYes: yes, nutritionObserved: nutrition.length, mood };
}

function renderProgressSummary(dates) {
  const summary = periodSummary(dates);
  const items = [
    ["Тренировки", summary.trainingObserved ? String(summary.trainingCount) : "—", `Отмечено: ${summary.trainingObserved}/${dates.length}`],
    ["Питание по плану", summary.nutritionObserved ? `${summary.nutritionYes} из ${summary.nutritionObserved}` : "—", "отмеченных дней"],
    ["Самочувствие", isValue(summary.mood.value) ? `${fmt(summary.mood.value)} / 5` : "—", `Отмечено: ${summary.mood.count}/${dates.length}`],
  ];
  $("progressSummary").replaceChildren(...items.map(([label, value, meta]) => {
    const item = node("div", "summary-item"); item.append(node("span", "", label), node("strong", "", value), node("small", "", meta)); return item;
  }));
}

function drawChart(canvas, dates, values, color, goal, partial = []) {
  const width = canvas.getBoundingClientRect().width;
  if (width < 1) return;
  const height = 140;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const observed = values.filter(isValue);
  if (!observed.length) return;
  const bounds = [...observed, ...(isValue(goal) ? [goal] : [])];
  let min = Math.min(...bounds), max = Math.max(...bounds);
  const span = max - min || Math.max(1, max * .04);
  min = Math.max(0, min - span * .2); max += span * .2;
  const left = 44, right = width - 7, top = 12, bottom = 114;
  const x = (index) => left + (right - left) * index / Math.max(1, dates.length - 1);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = "middle";
  for (const value of [min, (min + max) / 2, max]) {
    const yy = y(value);
    ctx.strokeStyle = "#e3e8e5"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = "#69716d"; ctx.textAlign = "left";
    ctx.fillText(numberFormat.format(Math.round(value * 10) / 10), 0, yy);
  }
  if (isValue(goal)) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = "#8b948e";
    ctx.beginPath(); ctx.moveTo(left, y(goal)); ctx.lineTo(right, y(goal)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  // Null calendar dates break the line instead of implying unobserved measurements.
  let started = false;
  ctx.beginPath();
  values.forEach((value, index) => {
    if (!isValue(value)) { started = false; return; }
    if (started) ctx.lineTo(x(index), y(value)); else ctx.moveTo(x(index), y(value));
    started = true;
  });
  ctx.stroke();
  values.forEach((value, index) => {
    if (!isValue(value)) return;
    ctx.beginPath(); ctx.arc(x(index), y(value), partial[index] ? 3.3 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = partial[index] ? "#ffffff" : color; ctx.fill();
    if (partial[index]) { ctx.lineWidth = 1.8; ctx.strokeStyle = color; ctx.stroke(); }
  });
  ctx.fillStyle = "#69716d"; ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left"; ctx.fillText(shortDateFormat.format(utcDate(dates[0])), left, 137);
  ctx.textAlign = "right"; ctx.fillText(shortDateFormat.format(utcDate(dates.at(-1))), right, 137);
}

function renderProgress(dates) {
  chartObserver?.disconnect();
  renderProgressSummary(dates);
  $("progressCharts").replaceChildren();
  const redraws = new Map();
  for (const spec of chartSpecs) {
    const values = chartValues(dates, spec);
    const partial = chartPartial(dates, spec);
    const avg = average(values);
    const goal = numeric(state.profile.goals[spec.key]);
    const section = node("section", "chart-section");
    const heading = node("div", "chart-heading");
    heading.append(node("h3", "", spec.label), node("span", "", `Наблюдений: ${avg.count}/${dates.length}`));
    const value = node("p", "chart-value", fmt(avg.value));
    value.append(node("small", "", ` ${spec.unit} · среднее`));
    section.append(heading, value);
    const info = [isValue(goal) ? `Цель: ${fmt(goal)} ${spec.unit}` : "Цель не задана"];
    if (spec.meal) info.push("По записанным приёмам");
    section.append(node("p", "chart-meta", info.join(" · ")));
    const partialCount = partial.filter((value, index) => value && isValue(values[index])).length;
    if (partialCount) {
      const legend = node("p", "chart-partial-legend");
      legend.append(node("b", "chart-partial-marker"), node("span", "", `Частичных сумм: ${partialCount}${dates.includes(state.today) ? " · сегодня — неполный день" : ""}`));
      section.append(legend);
    }
    if (avg.count) {
      const canvas = node("canvas", "chart-canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${spec.label}. Среднее ${fmt(avg.value)} ${spec.unit}. Наблюдений ${avg.count} из ${dates.length}. Частичных сумм: ${partialCount}.`);
      section.append(canvas);
      redraws.set(canvas, () => drawChart(canvas, dates, values, spec.color, goal, partial));
      const details = node("details", "chart-details");
      details.append(node("summary", "", "Значения по датам"));
      const list = node("div", "chart-data");
      dates.forEach((date, index) => { const row = node("span"); row.append(node("time", "", shortDateFormat.format(utcDate(date))), node("b", "", `${fmt(values[index])}${partial[index] && isValue(values[index]) ? " · частично" : ""}`)); list.append(row); });
      details.append(list); section.append(details);
    } else section.append(node("p", "chart-empty", "Нет записей за период"));
    $("progressCharts").append(section);
  }
  if (window.ResizeObserver) {
    chartObserver = new ResizeObserver((entries) => entries.forEach((entry) => redraws.get(entry.target)?.()));
    redraws.forEach((_, canvas) => chartObserver.observe(canvas));
  }
  requestAnimationFrame(() => redraws.forEach((draw) => draw()));
}

async function loadProgress(force = false) {
  const request = ++state.progressRequest;
  $("progressError").hidden = true;
  $("progressRetry").hidden = true;
  document.querySelectorAll("[data-period]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.period) === state.period)));
  let dates;
  try {
    dates = progressDates();
    $("progressRange").textContent = `${dateFormat.format(utcDate(dates[0]))} — ${dateFormat.format(utcDate(dates.at(-1)))} · ${dates.length} календарных дней`;
    $("progressSummary").replaceChildren();
    $("progressCharts").replaceChildren(node("p", "empty-state", "Загрузка…"));
    await loadRange(dates[0], dates.at(-1), { force });
    if (request === state.progressRequest) renderProgress(dates);
  } catch (error) {
    if (request !== state.progressRequest) return;
    $("progressCharts").replaceChildren();
    $("progressSummary").replaceChildren();
    $("progressError").textContent = errorText(error);
    $("progressError").hidden = false;
    $("progressRetry").hidden = false;
  }
}

function defaultReminders() {
  return [
    { kind: "sleep", time: "09:00", label: "Сон", enabled: false },
    { kind: "meal", time: "13:00", label: "Обед", enabled: false },
    { kind: "evening", time: "21:00", label: "Вода и шаги", enabled: false },
  ];
}
function markSettingsChanged() {
  state.settingsDirty = true;
  $("saveSettings").disabled = state.settingsBusy;
  status("settingsSaveStatus", "Не сохранено", "dirty");
}
function renderReminder(reminder = { kind: "meal", time: "13:00", label: "", enabled: false }) {
  const row = node("div", "reminder");
  if (reminder.id) row.dataset.id = reminder.id;
  const top = node("div", "reminder-top");
  const toggleLabel = node("label", "reminder-label");
  const toggle = node("input"); toggle.type = "checkbox"; toggle.name = "enabled"; toggle.checked = !!reminder.enabled;
  toggle.setAttribute("aria-label", "Включить напоминание");
  const kindLabel = node("span", "", reminderLabels[reminder.kind] || "Напоминание");
  toggleLabel.append(toggle, kindLabel);
  const remove = node("button", "icon-button"); remove.type = "button"; remove.title = "Удалить напоминание"; remove.setAttribute("aria-label", "Удалить напоминание"); remove.append(icon("x"));
  remove.addEventListener("click", () => { row.remove(); markSettingsChanged(); });
  top.append(toggleLabel, remove);
  const fields = node("div", "field-grid");
  const kindField = node("label", "field"); kindField.append(node("span", "", "Когда"));
  const kind = node("select"); kind.name = "kind";
  Object.entries(reminderLabels).forEach(([key, label]) => kind.add(new Option(label, key)));
  kind.value = reminder.kind;
  kind.addEventListener("change", () => { kindLabel.textContent = reminderLabels[kind.value]; });
  kindField.append(kind);
  const timeField = node("label", "field"); timeField.append(node("span", "", "Время"));
  const time = node("input"); time.name = "time"; time.type = "time"; time.required = true; time.value = reminder.time; timeField.append(time);
  fields.append(kindField, timeField);
  const nameField = node("label", "field reminder-name"); nameField.append(node("span", "", "Подпись"));
  const name = node("input"); name.name = "label"; name.maxLength = 80; name.value = reminder.label || ""; name.placeholder = "Без подписи"; nameField.append(name);
  row.append(top, fields, nameField);
  $("reminderList").append(row);
}

function renderSettings(suggestDefaults = false) {
  const form = $("settingsForm");
  $("timezone").value = state.profile.timezone;
  goalKeys.forEach((key) => { form.elements.namedItem(key).value = state.profile.goals[key] ?? ""; });
  $("reminderList").replaceChildren();
  const reminders = !state.reminders.length && suggestDefaults ? defaultReminders() : state.reminders;
  reminders.forEach(renderReminder);
  state.settingsDirty = false;
  $("saveSettings").disabled = true;
  status("settingsSaveStatus", "Нет изменений");
  renderIcons();
}

function settingsPayload() {
  const form = $("settingsForm");
  return {
    timezone: $("timezone").value.trim(),
    goals: Object.fromEntries(goalKeys.map((key) => [key, numeric(form.elements.namedItem(key).value)])),
    reminders: [...$("reminderList").querySelectorAll(".reminder")].map((row) => ({
      ...(row.dataset.id ? { id: row.dataset.id } : {}),
      kind: row.querySelector('[name="kind"]').value,
      time: row.querySelector('[name="time"]').value,
      label: row.querySelector('[name="label"]').value.trim(),
      enabled: row.querySelector('[name="enabled"]').checked,
    })),
  };
}

async function saveSettings(event) {
  event.preventDefault();
  if (state.settingsBusy || state.navigationBusy || !state.settingsDirty || !$("settingsForm").reportValidity()) return;
  const body = settingsPayload();
  if (body.reminders.length > 16) { status("settingsSaveStatus", "Не больше 16 напоминаний.", "error"); return; }
  const slots = body.reminders.map((reminder) => `${reminder.kind}:${reminder.time}`);
  if (new Set(slots).size !== slots.length) { status("settingsSaveStatus", "Одинаковые напоминания не могут быть в одно время.", "error"); return; }
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: body.timezone }); }
  catch { status("settingsSaveStatus", "Проверьте часовой пояс: например Europe/Moscow.", "error"); return; }
  state.settingsBusy = true;
  $("settingsFields").disabled = true;
  $("saveSettings").disabled = true;
  status("settingsSaveStatus", "Сохранение…");
  try {
    const result = await api("/settings", { method: "PUT", body: JSON.stringify(body) });
    if (!result.profile || !Array.isArray(result.reminders)) throw new Error("Нет подтверждения сервера. Повторите сохранение.");
    state.dataEpoch++;
    state.profile = { ...result.profile, goals: { ...Object.fromEntries(goalKeys.map((key) => [key, null])), ...result.profile.goals } };
    state.reminders = result.reminders;
    state.today = zonedToday(state.profile.timezone);
    renderSettings();
    renderSheetExportDetails();
    renderDaySummary();
    $("dayRelation").textContent = state.selected === state.today ? "СЕГОДНЯ" : "ДНЕВНИК";
    $("backToday").hidden = state.selected === state.today;
    status("settingsSaveStatus", demoMode ? "Сохранено в демо" : "Сохранено на сервере", "saved");
  } catch (error) { status("settingsSaveStatus", errorText(error), "error"); }
  finally {
    state.settingsBusy = false;
    $("settingsFields").disabled = false;
    $("saveSettings").disabled = !state.settingsDirty;
  }
}

function renderSheetExportDetails() {
  const config = state.sheetExport;
  const labels = { not_configured: "Экспорт не настроен", disabled: "Выгрузка выключена", ready: "Готово к ежедневной выгрузке", error: "Ошибка выгрузки" };
  const active = config.configured && config.enabled && config.verified;
  $("sheetExportState").textContent = !config.configured ? "Google не подключён" : config.verification_code && !config.verified ? "Подтверждение доступа" : !config.enabled ? "Выгрузка выключена" : labels[config.status] || "Состояние неизвестно";
  $("sheetExportState").dataset.state = config.status === "error" ? "error" : active && config.status === "ready" ? "ready" : "";
  $("sheetExportSchedule").textContent = active ? `Ежедневно в 03:15 · ${state.profile.timezone}` : "Не запланировано";
  const lastSync = config.last_sync_at ? new Date(config.last_sync_at) : null;
  $("sheetExportLastSync").textContent = lastSync && Number.isFinite(lastSync.getTime()) ? new Intl.DateTimeFormat("ru-RU", { timeZone: state.profile.timezone, dateStyle: "short", timeStyle: "short" }).format(lastSync) : config.last_sync_at ? "Нет данных" : "Ещё не было";
  $("sheetServiceEmail").textContent = config.service_email || "";
  $("sheetServiceRow").hidden = !config.service_email;
  $("sheetVerificationCode").value = !config.verified ? config.verification_code || "" : "";
  $("sheetVerificationRow").hidden = config.verified || !config.verification_code;
  $("sheetExportError").textContent = typeof config.error === "string" ? config.error : "";
  $("sheetExportError").hidden = !$("sheetExportError").textContent;
}

function renderSheetExport() {
  $("sheetExportUrl").value = state.sheetExport.spreadsheet_url;
  $("sheetExportEnabled").checked = state.sheetExport.enabled;
  state.sheetExportDirty = false;
  $("saveSheetExport").disabled = true;
  status("sheetExportSaveStatus", "Нет изменений");
  renderSheetExportDetails();
}

function markSheetExportChanged() {
  state.sheetExportDirty = $("sheetExportUrl").value.trim() !== state.sheetExport.spreadsheet_url || $("sheetExportEnabled").checked !== state.sheetExport.enabled;
  $("saveSheetExport").disabled = !state.sheetExportDirty || state.sheetExportBusy || state.navigationBusy;
  status("sheetExportSaveStatus", state.sheetExportDirty ? "Не сохранено" : "Нет изменений", state.sheetExportDirty ? "dirty" : "");
}

async function saveSheetExport(event) {
  event.preventDefault();
  if (state.sheetExportBusy || state.navigationBusy || !state.sheetExportDirty || !$("sheetExportForm").reportValidity()) return;
  const body = { spreadsheet_url: $("sheetExportUrl").value.trim(), enabled: $("sheetExportEnabled").checked };
  try { sheetDestination(body.spreadsheet_url); }
  catch (error) { status("sheetExportSaveStatus", errorText(error), "error"); return; }
  state.sheetExportBusy = true;
  $("sheetExportFields").disabled = true;
  $("saveSheetExport").disabled = true;
  status("sheetExportSaveStatus", "Сохранение…");
  try {
    const result = await api("/sheet-export", { method: "PUT", body: JSON.stringify(body) });
    const config = result.sheet_export;
    if (!config || typeof config.spreadsheet_url !== "string" || typeof config.configured !== "boolean" || typeof config.enabled !== "boolean" || typeof config.verified !== "boolean" ||
        config.enabled !== body.enabled || (config.enabled && (!config.configured || !config.verified)) ||
        !["not_configured", "disabled", "ready", "error"].includes(config.status) ||
        sheetDestination(config.spreadsheet_url) !== sheetDestination(body.spreadsheet_url)) {
      throw new Error("Нет подтверждения сервера. Повторите сохранение.");
    }
    state.dataEpoch++;
    state.sheetExport = { ...emptySheetExport(), ...config };
    renderSheetExport();
    status("sheetExportSaveStatus", demoMode ? "Ссылка сохранена в демо" : "Настройка сохранена на сервере", "saved");
  } catch (error) { status("sheetExportSaveStatus", errorText(error), "error"); }
  finally {
    state.sheetExportBusy = false;
    $("sheetExportFields").disabled = false;
    $("saveSheetExport").disabled = !state.sheetExportDirty;
  }
}

async function exportCsv(kind, button) {
  if (button.disabled) return;
  button.disabled = true;
  status("exportStatus", "Подготовка CSV…");
  try {
    const dates = progressDates();
    const from = dates[0], to = dates.at(-1);
    const blob = await api(`/export?${new URLSearchParams({ from, to, kind })}`, {}, true);
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url; link.download = `sport-${kind}-${from}-${to}.csv`;
    document.body.append(link); link.click(); link.remove();
    // Retain the private object URL briefly so mobile WebViews can start the download.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status("exportStatus", "CSV подготовлен", "saved");
  } catch (error) { status("exportStatus", errorText(error), "error"); }
  finally { button.disabled = false; }
}

async function showView(view) {
  state.view = view;
  for (const name of ["today", "calendar", "progress", "settings"]) $(`${name}View`).hidden = name !== view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (view === "calendar") await loadCalendar();
  if (view === "progress") await loadProgress();
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function refresh() {
  if (state.dayBusy || state.settingsBusy || state.mealBusy || state.sheetExportBusy || state.navigationBusy) return;
  if ((state.dayTouched.size || state.settingsDirty || state.sheetExportDirty) && !confirmDiscard()) return;
  state.navigationBusy = true;
  $("refreshButton").disabled = true;
  $("dayFields").disabled = true;
  $("settingsFields").disabled = true;
  $("sheetExportFields").disabled = true;
  $("saveDay").disabled = true;
  $("saveSettings").disabled = true;
  $("saveSheetExport").disabled = true;
  try {
    await loadRange(state.selected, state.selected, { force: true, metadata: true });
    state.loaded.clear(); state.loaded.add(state.selected);
    renderTraining(); renderDay(); renderSettings(); renderSheetExport();
    await showView(state.view);
    toast("Данные обновлены");
  } catch (error) { toast(errorText(error)); }
  finally {
    state.navigationBusy = false;
    $("refreshButton").disabled = false;
    $("dayFields").disabled = false;
    $("settingsFields").disabled = false;
    $("sheetExportFields").disabled = false;
    $("saveDay").disabled = !state.dayTouched.size;
    $("saveSettings").disabled = !state.settingsDirty;
    $("saveSheetExport").disabled = !state.sheetExportDirty;
  }
}

function renderTraining() {
  $("trainingSelect").replaceChildren(new Option("Не отмечено", ""));
  state.trainingTypes.forEach((value) => $("trainingSelect").add(new Option(trainingLabels[value] || value, value)));
}

function bindEvents() {
  $("dayForm").addEventListener("input", (event) => markDayChanged(event.target.name));
  $("dayForm").addEventListener("change", (event) => markDayChanged(event.target.name));
  $("dayForm").addEventListener("submit", saveDay);
  $("addWater").addEventListener("click", () => {
    const input = dayControl("water_ml");
    if (!input.validity.valid) { input.reportValidity(); return; }
    input.value = (numeric(input.value) ?? 0) + 250;
    markDayChanged("water_ml");
  });
  $("previousDay").addEventListener("click", () => selectDate(addDays(state.selected, -1)));
  $("nextDay").addEventListener("click", () => selectDate(addDays(state.selected, 1)));
  $("backToday").addEventListener("click", () => selectDate(state.today));
  $("dayDate").addEventListener("change", (event) => selectDate(event.target.value));
  $("addMeal").addEventListener("click", () => openMeal());
  $("mealForm").addEventListener("submit", saveMeal);
  $("mealForm").addEventListener("input", () => { state.mealDirty = true; status("mealSaveStatus", "Не сохранено", "dirty"); });
  $("closeMeal").addEventListener("click", closeMeal);
  $("cancelMeal").addEventListener("click", closeMeal);
  $("mealDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeMeal(); });
  $("deleteMeal").addEventListener("click", deleteMeal);
  $("previousMonth").addEventListener("click", () => changeMonth(-1));
  $("nextMonth").addEventListener("click", () => changeMonth(1));
  $("currentMonth").addEventListener("click", () => { state.month = state.today.slice(0, 7); loadCalendar(); });
  $("calendarMonth").addEventListener("change", (event) => { if (/^\d{4}-\d{2}$/.test(event.target.value)) { state.month = event.target.value; loadCalendar(); } });
  $("calendarRetry").addEventListener("click", () => loadCalendar(true));
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view).catch((error) => toast(errorText(error)))));
  document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => { state.period = Number(button.dataset.period); loadProgress(); }));
  $("progressEnd").addEventListener("change", () => loadProgress());
  $("progressRetry").addEventListener("click", () => loadProgress(true));
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportCsv(button.dataset.export, button)));
  $("settingsForm").addEventListener("input", markSettingsChanged);
  $("settingsForm").addEventListener("change", markSettingsChanged);
  $("settingsForm").addEventListener("submit", saveSettings);
  $("sheetExportForm").addEventListener("input", markSheetExportChanged);
  $("sheetExportForm").addEventListener("change", markSheetExportChanged);
  $("sheetExportForm").addEventListener("submit", saveSheetExport);
  $("addReminder").addEventListener("click", () => {
    const rows = [...$("reminderList").querySelectorAll(".reminder")];
    if (rows.length >= 16) { toast("Не больше 16 напоминаний"); return; }
    const mealTimes = rows.filter((row) => row.querySelector('[name="kind"]').value === "meal").map((row) => row.querySelector('[name="time"]').value);
    const time = ["08:00", "13:00", "19:00", "16:00", "10:00", "21:00"].find((value) => !mealTimes.includes(value)) || "12:00";
    renderReminder({ kind: "meal", time, label: "", enabled: false });
    renderIcons(); markSettingsChanged();
  });
  $("refreshButton").addEventListener("click", refresh);
  $("retryButton").addEventListener("click", boot);
  window.addEventListener("beforeunload", (event) => {
    if (state.dayTouched.size || state.settingsDirty || state.sheetExportDirty || state.mealDirty || state.dayBusy || state.settingsBusy || state.sheetExportBusy || state.mealBusy) { event.preventDefault(); event.returnValue = ""; }
  });
  for (const link of document.querySelectorAll(".product-switch a")) link.addEventListener("click", (event) => {
    if ((state.dayTouched.size || state.settingsDirty || state.sheetExportDirty || state.mealDirty) && !confirmDiscard()) event.preventDefault();
  });
}

async function boot() {
  $("accessError").hidden = true;
  $("loadStatus").hidden = false;
  $("mainContent").hidden = true;
  $("bottomNav").hidden = true;
  $("refreshButton").disabled = true;
  try {
    await loadRange(state.today, state.today, { force: true, metadata: true });
    state.selected = state.today;
    state.month = state.today.slice(0, 7);
    await loadRange(state.selected, state.selected);
    $("progressEnd").value = state.today;
    renderTraining(); renderDay(); renderSettings(true); renderSheetExport();
    $("mainContent").hidden = false;
    $("bottomNav").hidden = false;
    $("refreshButton").disabled = false;
  } catch (error) {
    $("accessTitle").textContent = !demoMode && !telegram?.initData ? "Откройте в Telegram" : "Дневник недоступен";
    $("accessMessage").textContent = errorText(error);
    $("accessError").hidden = false;
    $("retryButton").hidden = !demoMode && !telegram?.initData;
  } finally { $("loadStatus").hidden = true; }
}

function start() {
  telegram?.ready(); telegram?.expand();
  telegram?.setHeaderColor?.("#ffffff"); telegram?.setBackgroundColor?.("#ffffff");
  $("demoBanner").hidden = !demoMode;
  // Explicit demo navigation stays inside the fictional environment.
  if (demoMode) document.querySelectorAll('.product-switch a[href="/sport/"]').forEach((link) => { link.href = "/sport/?demo=1"; });
  bindEvents(); renderIcons();
  window.addEventListener("load", renderIcons, { once: true });
  boot();
}

start();
