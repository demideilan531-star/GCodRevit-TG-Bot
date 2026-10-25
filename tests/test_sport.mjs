import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker from "../cloudflare-worker/src/index.js";

import {
  handleSportApi,
  BUTTON_SPORT,
  handleSportUpdate,
  nextReminderDue,
  parseSportReply,
  runSportReminders,
  SPORT_CRON,
  validateDayPayload,
  validateMealPayload,
} from "../cloudflare-worker/src/sport.js";
import {
  BLOCKED_OWNER,
  createSportFixture,
  createSqliteD1,
  OTHER_OWNER,
  OWNER,
  signedInitData,
  UNKNOWN_OWNER,
} from "./sport-db-fixture.mjs";

test("Sport D1 fixture supports real SQLite first/all/run and immutable bindings", async (t) => {
  const { db, sqlite } = createSqliteD1(t, { migrations: [] });
  sqlite.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, amount REAL, note TEXT)");
  const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?)");
  const first = insert.bind("one", 7.5, null);
  const second = insert.bind("two", 0, "fictional");
  assert.equal((await first.run()).meta.changes, 1);
  assert.equal((await second.run()).success, true);
  assert.deepEqual(await db.prepare("SELECT * FROM entries WHERE id = ?").bind("one").first(), {
    id: "one", amount: 7.5, note: null,
  });
  assert.equal(await db.prepare("SELECT amount FROM entries WHERE id = ?").bind("two").first("amount"), 0);
  assert.equal(await db.prepare("SELECT * FROM entries WHERE id = ?").bind("missing").first(), null);
  assert.equal((await db.prepare("SELECT * FROM entries").all()).results.length, 2);
});

test("Sport D1 fixture batches execute atomically and return D1 results", async (t) => {
  const { db, sqlite } = createSqliteD1(t, { migrations: [] });
  sqlite.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO entries VALUES (?)");
  const result = await db.batch([insert.bind("one"), insert.bind("two")]);
  assert.deepEqual(result.map(({ meta }) => meta.changes), [1, 1]);
  await assert.rejects(db.batch([insert.bind("three"), insert.bind("one")]), /UNIQUE constraint/);
  assert.deepEqual((await db.prepare("SELECT id FROM entries ORDER BY id").all()).results, [{ id: "one" }, { id: "two" }]);
});

test("day patches keep missing values missing and preserve explicit false, null and zero", () => {
  assert.throws(() => validateDayPayload({}), /Нет данных/);
  assert.deepEqual(validateDayPayload({ nutrition: false }), { nutrition: false });
  assert.deepEqual(validateDayPayload({ weight_kg: null, training: null, nutrition: null }), {
    weight_kg: null, training: null, nutrition: null,
  });
  assert.deepEqual(validateDayPayload({ sleep_hours: 0, water_ml: 0, steps: 0 }), {
    sleep_hours: 0, water_ml: 0, steps: 0,
  });
  assert.equal(validateDayPayload({ nutrition: true }).nutrition, true);
  assert.equal(validateDayPayload({ owner_id: OTHER_OWNER, mood: 4 }).owner_id, undefined);
});

for (const [field, minimum, maximum, integer] of [
  ["weight_kg", 20, 400, false],
  ["sleep_hours", 0, 24, false],
  ["sleep_quality", 1, 5, true],
  ["water_ml", 0, 20000, true],
  ["steps", 0, 150000, true],
  ["mood", 1, 5, true],
]) {
  test(`day ${field} enforces its finite numeric range${integer ? " and integer values" : ""}`, () => {
    for (const value of [minimum, maximum]) assert.equal(validateDayPayload({ [field]: value })[field], value);
    for (const value of [minimum - 1, maximum + 1, NaN, Infinity, -Infinity, "3", true, {}, []]) {
      assert.throws(() => validateDayPayload({ [field]: value }), `${field}: ${String(value)}`);
    }
    if (integer) assert.throws(() => validateDayPayload({ [field]: minimum + 0.5 }));
  });
}

test("day training and nutrition accept only their explicit values", () => {
  for (const training of [null, "rest", "strength", "cardio", "stretch", "other"]) {
    assert.equal(validateDayPayload({ training }).training, training);
  }
  for (const training of ["run", "", 1, true]) assert.throws(() => validateDayPayload({ training }));
  for (const nutrition of [0, 1, "false", "true", ""]) assert.throws(() => validateDayPayload({ nutrition }));
});

test("day comments and coach notes enforce the 2000 character limit", () => {
  for (const field of ["comment", "coach_note"]) {
    assert.equal(validateDayPayload({ [field]: "x".repeat(2000) })[field].length, 2000);
    assert.throws(() => validateDayPayload({ [field]: "x".repeat(2001) }));
  }
});

const mealPayload = (extra = {}) => ({
  date: "2026-10-23", time: "12:30", title: "Fictional oats",
  calories_kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 55, note: "Fictional meal",
  ...extra,
});

test("meal validation retains the supplied id and zero values while partial patches omit absent fields", () => {
  const result = validateMealPayload(mealPayload({ id: "fictional-meal-01", calories_kcal: 0, protein_g: 0 }));
  assert.equal(result.id, "fictional-meal-01");
  assert.equal(result.calories_kcal, 0);
  assert.equal(result.protein_g, 0);
  assert.deepEqual(validateMealPayload({ fat_g: 0 }, { partial: true }), { fat_g: 0 });
  assert.deepEqual(validateMealPayload({}, { partial: true }), {});
  assert.equal(validateMealPayload(mealPayload({ owner_id: OTHER_OWNER })).owner_id, undefined);
});

test("meal dates are real calendar dates and times use 24-hour HH:mm", () => {
  assert.equal(validateMealPayload(mealPayload({ date: "2024-02-29", time: "00:00" })).date, "2024-02-29");
  assert.equal(validateMealPayload(mealPayload({ time: "23:59" })).time, "23:59");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-00", "26-10-23", "2026-1-01", "2026-10-23T12:00:00Z"]) {
    assert.throws(() => validateMealPayload(mealPayload({ date })), date);
  }
  for (const time of ["24:00", "23:60", "9:00", "09:0", "09:00:00", "-1:00"]) {
    assert.throws(() => validateMealPayload(mealPayload({ time })), time);
  }
});

test("meal titles are required and limited to 120 characters", () => {
  for (const title of ["", "   ", null]) assert.throws(() => validateMealPayload(mealPayload({ title })));
  assert.equal(validateMealPayload(mealPayload({ title: "x".repeat(120) })).title.length, 120);
  assert.throws(() => validateMealPayload(mealPayload({ title: "x".repeat(121) })));
  assert.throws(() => validateMealPayload(mealPayload({ title: undefined })));
});

for (const field of ["calories_kcal", "protein_g", "fat_g", "carbs_g"]) {
  test(`meal ${field} rejects negative, nonnumeric and nonfinite values`, () => {
    for (const value of [0, 1.5]) assert.equal(validateMealPayload(mealPayload({ [field]: value }))[field], value);
    for (const value of [-1, NaN, Infinity, -Infinity, "12", true, {}, []]) {
      assert.throws(() => validateMealPayload(mealPayload({ [field]: value })), `${field}: ${String(value)}`);
    }
  });
}

test("Russian sleep replies retain fractional hours without filling unrelated diary fields", () => {
  const parsed = parseSportReply("sleep", "Хорошо, спал 7,5 часов");
  assert.equal(parsed.day.sleep_hours, 7.5);
  assert.equal(parsed.day.sleep_quality, 4);
  for (const field of ["weight_kg", "water_ml", "steps", "nutrition", "mood"]) assert.equal(parsed.day[field], undefined);
});

test("Russian evening replies normalize liters and retain missing-versus-zero distinctions", () => {
  const parsed = parseSportReply("evening", "Воды 2 л, шаги 8500");
  assert.equal(parsed.day.water_ml, 2000);
  assert.equal(parsed.day.steps, 8500);
  assert.equal(parsed.day.nutrition, undefined);
  const zero = parseSportReply("evening", "Воды 0 мл, шаги 0");
  assert.equal(zero.day.water_ml, 0);
  assert.equal(zero.day.steps, 0);
});

test("Russian meal replies parse only explicitly stated calories and macros", () => {
  const parsed = parseSportReply("meal", "Овсянка, 400 ккал, Б 20 Ж 10 У 55");
  assert.equal(parsed.meal.title, "Овсянка");
  assert.equal(parsed.meal.calories_kcal, 400);
  assert.equal(parsed.meal.protein_g, 20);
  assert.equal(parsed.meal.fat_g, 10);
  assert.equal(parsed.meal.carbs_g, 55);
  const withoutNumbers = parseSportReply("meal", "Овсянка");
  if (withoutNumbers) {
    for (const field of ["calories_kcal", "protein_g", "fat_g", "carbs_g"]) assert.equal(withoutNumbers.meal[field] ?? null, null);
  }
});

test("unparseable sleep/evening answers do not become zero-valued diary entries", () => {
  for (const kind of ["sleep", "evening"]) {
    for (const text of ["", "Нужно подготовить отчёт", "Не знаю"]) assert.equal(parseSportReply(kind, text), null);
  }
});

for (const [name, timezone, after, expected] of [
  ["Moscow before time", "Europe/Moscow", "2026-10-23T05:59:59Z", "2026-10-23T06:00:00.000Z"],
  ["strictly future at exact time", "Europe/Moscow", "2026-10-23T06:00:00Z", "2026-10-24T06:00:00.000Z"],
  ["Moscow next local day", "Europe/Moscow", "2026-10-23T23:30:00Z", "2026-10-24T06:00:00.000Z"],
  ["fractional offset", "Asia/Kathmandu", "2026-10-23T03:00:00Z", "2026-10-23T03:15:00.000Z"],
  ["negative offset", "America/New_York", "2026-10-23T12:59:59Z", "2026-10-23T13:00:00.000Z"],
  ["DST spring next day", "America/New_York", "2026-03-07T15:00:00Z", "2026-03-08T13:00:00.000Z"],
  ["DST autumn next day", "America/New_York", "2026-10-31T14:00:00Z", "2026-11-01T14:00:00.000Z"],
  ["positive date boundary", "Pacific/Kiritimati", "2026-10-23T20:00:00Z", "2026-10-24T19:00:00.000Z"],
]) {
  test(`next reminder uses the user's wall clock: ${name}`, () => {
    const result = nextReminderDue({ time: "09:00" }, timezone, new Date(after));
    assert.equal(result, expected);
    assert.ok(Date.parse(result) > Date.parse(after));
  });
}

test("Sport API rejects missing, malformed, tampered, stale and future Telegram authorization", async (t) => {
  const f = createSportFixture(t);
  const tampered = new URLSearchParams(signedInitData(f.env));
  tampered.set("user", JSON.stringify({ id: Number(OTHER_OWNER) }));
  const now = Math.floor(Date.now() / 1000);
  const credentials = [
    null,
    "not-signed-init-data",
    tampered.toString(),
    signedInitData(f.env, OWNER, { authDate: now - 172800 }),
    signedInitData(f.env, OWNER, { authDate: now + 172800 }),
    signedInitData({ TELEGRAM_BOT_TOKEN: "wrong-fictional-bot" }),
  ];
  for (const initData of credentials) {
    const response = await handleSportApi(f.request("", { initData }), f.env);
    assert.ok([401, 403].includes(response.status), `unauthorized response: ${response.status}`);
    const body = await response.json();
    assert.equal(body.days, undefined);
    assert.equal(body.meals, undefined);
  }
});

test("Sport API requires current allowlist authorization, not merely a valid Telegram signature", async (t) => {
  const f = createSportFixture(t);
  for (const ownerId of [BLOCKED_OWNER, UNKNOWN_OWNER]) {
    const response = await handleSportApi(f.request("", { ownerId }), f.env);
    assert.ok([401, 403].includes(response.status), `${ownerId}: ${response.status}`);
  }
  const initData = signedInitData(f.env);
  f.sqlite.prepare("UPDATE assistant_users SET status = 'blocked' WHERE telegram_user_id = ?").run(OWNER);
  const response = await handleSportApi(f.request("", { initData }), f.env);
  assert.ok([401, 403].includes(response.status), "a previously signed session must not bypass a new block");
});

test("Sport update handler leaves unrelated messages available to task parsing", async (t) => {
  const f = createSportFixture(t);
  for (const text of ["Нужно подготовить отчёт", "Хорошо, спал 7,5 часов", "Воды 2 л, шаги 8500", "Овсянка, 400 ккал, Б 20 Ж 10 У 55", "/sports"]) {
    assert.equal(await handleSportUpdate(f.message(text), f.env, f.helpers), false, text);
  }
  assert.equal(await handleSportUpdate({}, f.env, f.helpers), false);
  assert.equal(await handleSportUpdate(f.message("Воды 2 л", { reply_to_message: { message_id: 123456 } }), f.env, f.helpers), false);
  assert.equal(f.calls.length, 0);
});

test("explicit /sport is handled in an authorized private chat", async (t) => {
  const f = createSportFixture(t);
  assert.equal(await handleSportUpdate(f.message("/sport"), f.env, f.helpers), true);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(({ body }) => String(body.chat_id) === OWNER));
});

const DAY = "2026-10-23";
const NOW = "2026-10-23T06:00:00.000Z";
const RANGE = `?from=${DAY}&to=${DAY}`;

async function api(f, path, options = {}, status = 200) {
  const response = await handleSportApi(f.request(path, options), f.env);
  assert.ok(response instanceof Response);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return body;
}

function freezeTime(t, now = NOW) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
}

function settings(extra = {}) {
  return { timezone: "Europe/Moscow", goals: { water_ml: 2000 }, reminders: [], ...extra };
}

function installTelegram(t, f) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith(`https://api.telegram.org/bot${f.env.TELEGRAM_BOT_TOKEN}/`), `unexpected network request: ${url}`);
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    const messageId = 9001 + f.calls.length;
    f.calls.push({ method, body, messageId });
    return Response.json({ ok: true, result: { message_id: messageId } });
  });
}

async function webhook(f, update) {
  const pending = [];
  const response = await worker.fetch(new Request("https://sport.example.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": f.env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(update),
  }), f.env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(response.status, 200);
  return response;
}

test("Sport API reads isolate days, meals, profiles and reminders by the signed owner", async (t) => {
  const f = createSportFixture(t);
  for (const [ownerId, weight, title, timezone] of [
    [OWNER, 71.5, "Fictional owner meal", "Europe/Moscow"],
    [OTHER_OWNER, 82.5, "Fictional second meal", "Asia/Kathmandu"],
  ]) {
    await api(f, `/days/${DAY}`, { method: "PUT", ownerId, body: { weight_kg: weight, owner_id: OTHER_OWNER } });
    await api(f, "/meals", { method: "POST", ownerId, body: mealPayload({ id: `fixture-meal-${ownerId}`, title }) }, 201);
    await api(f, "/settings", { method: "PUT", ownerId, body: settings({ timezone, reminders: [
      { kind: "sleep", mode: ownerId === OWNER ? "question" : "notification", time: "09:00", label: `Fictional question ${ownerId}`, enabled: true },
    ] }) });
  }
  for (const [ownerId, weight, title, timezone] of [
    [OWNER, 71.5, "Fictional owner meal", "Europe/Moscow"],
    [OTHER_OWNER, 82.5, "Fictional second meal", "Asia/Kathmandu"],
  ]) {
    const body = await api(f, `${RANGE}&owner_id=${ownerId === OWNER ? OTHER_OWNER : OWNER}`, { ownerId });
    assert.deepEqual(body.days.map(day => day.weight_kg), [weight]);
    assert.deepEqual(body.meals.map(meal => meal.title), [title]);
    assert.equal(body.profile.timezone, timezone);
    assert.equal(body.reminders.length, 1);
    assert.equal(body.reminders[0].label, `Fictional question ${ownerId}`);
    assert.equal(body.reminders[0].enabled, true);
    assert.equal(body.reminders[0].mode, ownerId === OWNER ? "question" : "notification");
    assert.equal(body.days[0].owner_id, undefined);
    assert.equal(body.meals[0].owner_id, undefined);
  }
});

test("day SQL upserts preserve unrelated fields and distinguish zero, false and unknown", async (t) => {
  const f = createSportFixture(t);
  const initial = { weight_kg: 71.5, sleep_hours: 7.5, sleep_quality: 4, water_ml: 1800, steps: 8300, training: "strength", mood: 4, nutrition: true, comment: "Fictional day", coach_note: "Fictional coach note" };
  await api(f, `/days/${DAY}`, { method: "PUT", body: initial });
  const { day } = await api(f, `/days/${DAY}`, { method: "PUT", body: { water_ml: 0, nutrition: false, owner_id: OTHER_OWNER } });
  assert.deepEqual(day, { date: DAY, ...initial, water_ml: 0, nutrition: false });
  const persisted = f.sqlite.prepare("SELECT * FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY);
  assert.equal(persisted.nutrition, 0);
  assert.equal(persisted.steps, 8300);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days WHERE owner_id=?").get(OTHER_OWNER).n, 0);
  const cleared = await api(f, `/days/${DAY}`, { method: "PUT", body: { weight_kg: null, nutrition: null, training: null } });
  assert.equal(cleared.day.weight_kg, null);
  assert.equal(cleared.day.training, null);
  assert.equal(cleared.day.nutrition, null);
  assert.equal(cleared.day.steps, 8300);
  const fresh = await api(f, "/days/2026-10-24", { method: "PUT", body: { steps: 0 } });
  assert.equal(fresh.day.steps, 0);
  for (const field of ["weight_kg", "sleep_hours", "water_ml", "nutrition", "training"]) assert.equal(fresh.day[field], null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY).n, 1);
});

test("meal creation with repeated IDs is idempotent, patches are partial, cross-owner writes are denied", async (t) => {
  const f = createSportFixture(t);
  t.mock.method(console, "error", () => {});
  const id = "fixture-idempotent-meal";
  const original = await api(f, "/meals", { method: "POST", body: mealPayload({ id }) }, 201);
  const repeated = await api(f, "/meals", { method: "POST", body: mealPayload({ id, title: "Must not replace original", calories_kcal: 900 }) }, 201);
  assert.deepEqual(repeated.meal, original.meal);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals WHERE id=?").get(id).n, 1);
  const changed = await api(f, `/meals/${id}`, { method: "PATCH", body: { protein_g: 0, note: "Fictional changed note", id: "ignored-new-id", owner_id: OTHER_OWNER } });
  assert.deepEqual(changed.meal, { ...original.meal, protein_g: 0, note: "Fictional changed note" });
  await api(f, `/meals/${id}`, { method: "PATCH", ownerId: OTHER_OWNER, body: { title: "Must not change" } }, 404);
  await api(f, `/meals/${id}`, { method: "DELETE", ownerId: OTHER_OWNER }, 404);
  const denied = await api(f, "/meals", { method: "POST", ownerId: OTHER_OWNER, body: mealPayload({ id }) }, 400);
  assert.equal(denied.meal, undefined);
  assert.equal(f.sqlite.prepare("SELECT owner_id FROM sport_meals WHERE id=?").get(id).owner_id, OWNER);
  assert.deepEqual((await api(f, RANGE, { ownerId: OTHER_OWNER })).meals, []);
  await api(f, `/meals/${id}`, { method: "DELETE" });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals WHERE id=?").get(id).n, 0);
});

test("concurrent duplicate meal requests create only one persisted row", async (t) => {
  const f = createSportFixture(t);
  const options = { method: "POST", body: mealPayload({ id: "fixture-concurrent-meal" }) };
  const [left, right] = await Promise.all([api(f, "/meals", options, 201), api(f, "/meals", options, 201)]);
  assert.deepEqual(left.meal, right.meal);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals").get().n, 1);
});

test("settings cannot adopt another owner's reminder ID and persist correct timezone deadlines", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const other = await api(f, "/settings", { method: "PUT", ownerId: OTHER_OWNER, body: settings({ timezone: "Asia/Kathmandu", reminders: [
    { kind: "sleep", time: "12:00", label: "Fictional other question", enabled: true },
  ] }) });
  const owned = await api(f, "/settings", { method: "PUT", body: settings({ goals: { steps: 0, weight_kg: null }, reminders: [
    { id: other.reminders[0].id, kind: "evening", time: "09:30", label: "Fictional own question", enabled: true },
    { kind: "meal", time: "12:00", label: "Fictional disabled meal", enabled: false },
  ] }) });
  assert.notEqual(owned.reminders[0].id, other.reminders[0].id);
  assert.deepEqual(owned.profile.goals, { steps: 0, weight_kg: null });
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(owned.reminders[0].id).next_due_at, "2026-10-23T06:30:00.000Z");
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(owned.reminders[1].id).next_due_at, null);
  assert.equal(f.sqlite.prepare("SELECT owner_id FROM sport_reminders WHERE id=?").get(other.reminders[0].id).owner_id, OTHER_OWNER);
  const updated = await api(f, "/settings", { method: "PUT", body: settings({ reminders: [
    { ...owned.reminders[0], time: "10:00" },
  ] }) });
  assert.equal(updated.reminders[0].id, owned.reminders[0].id);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_reminders WHERE owner_id=?").get(OWNER).n, 1);
});

test("invalid API payloads and calendar ranges do not leave partial records", async (t) => {
  const f = createSportFixture(t);
  t.mock.method(console, "error", () => {});
  for (const [path, method, body] of [
    ["/days/2026-02-29", "PUT", { steps: 1 }],
    [`/days/${DAY}`, "PUT", { steps: 1.5 }],
    [`/days/${DAY}`, "PUT", {}],
    ["/meals", "POST", mealPayload({ date: "2026-04-31" })],
    ["/settings", "PUT", settings({ timezone: "Fictional/Unknown" })],
    ["/settings", "PUT", settings({ reminders: [{ kind: "sleep", enabled: true, time: "24:00" }] })],
  ]) await api(f, path, { method, body }, 400);
  for (const path of ["?from=2026-10-24&to=2026-10-23", "?from=2026-01-01&to=2026-10-23", "?from=2026-02-29&to=2026-03-01"]) await api(f, path, {}, 400);
  for (const table of ["sport_days", "sport_meals", "sport_profiles", "sport_reminders"]) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test("CSV exports neutralize formulas and escape delimiters, quotes and newlines without leaking owners", async (t) => {
  const f = createSportFixture(t);
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 0, nutrition: false, comment: "=1+1", coach_note: "Literal \"quote\";field\nnext line" } });
  await api(f, `/days/${DAY}`, { method: "PUT", ownerId: OTHER_OWNER, body: { comment: "Fictional second owner's private marker" } });
  for (const formula of ["=1+1", "+1+1", "-1+1", "@SUM(1;2)", "  =1+1", "\t=1+1", "\r=1+1", "\n=1+1"]) {
    f.sqlite.prepare("UPDATE sport_days SET comment=? WHERE owner_id=? AND date=?").run(formula, OWNER, DAY);
    const response = await handleSportApi(f.request(`/export${RANGE}`), f.env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /^text\/csv/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Disposition"), /attachment; filename="sport-days/);
    const csv = await response.text();
    assert.ok(csv.includes(`"'${formula}"`), JSON.stringify(formula));
    assert.ok(csv.includes('"Literal ""quote"";field\nnext line"'));
    assert.doesNotMatch(csv, /second owner's private marker/);
    assert.match(csv, /"0"/);
    assert.match(csv, /"false"/);
  }
  await api(f, "/meals", { method: "POST", body: mealPayload({ title: "@SUM(1;2)", note: "+1+1" }) }, 201);
  const response = await handleSportApi(f.request(`/export${RANGE}&kind=meals`), f.env);
  const csv = await response.text();
  assert.ok(csv.includes('"\'@SUM(1;2)"'));
  assert.ok(csv.includes('"\'+1+1"'));
  assert.ok(csv.includes('"400"'));
});

test("known prompt replies update the prompt's date, preserve other metrics and close once", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const prompt = f.seedPrompt();
  await api(f, `/days/${prompt.date}`, { method: "PUT", body: { weight_kg: 71.5, steps: 8300, nutrition: false } });
  const update = f.message("Хорошо, спал 7,5 часов", { reply_to_message: { message_id: prompt.messageId } });
  assert.equal(await handleSportUpdate(update, f.env, f.helpers), true);
  const day = f.sqlite.prepare("SELECT * FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, prompt.date);
  assert.equal(day.sleep_hours, 7.5);
  assert.equal(day.sleep_quality, 4);
  assert.equal(day.weight_kg, 71.5);
  assert.equal(day.steps, 8300);
  assert.equal(day.nutrition, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 1);
  assert.equal(await handleSportUpdate(f.message("Спал 2 часа", { message_id: 7002, reply_to_message: { message_id: prompt.messageId } }), f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, prompt.date).sleep_hours, 7.5);
});

test("prompt routing binds both the owner and private chat, including colliding Telegram message IDs", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const other = f.seedPrompt({ ownerId: OTHER_OWNER, kind: "evening" });
  assert.equal(await handleSportUpdate(f.message("Воды 2 л", { reply_to_message: { message_id: other.messageId } }), f.env, f.helpers), false);
  const own = f.seedPrompt({ id: "fictional-own-prompt", kind: "sleep" });
  for (const chat of [{ id: -810099, type: "group" }, { id: Number(OTHER_OWNER), type: "private" }]) {
    assert.equal(await handleSportUpdate(f.message("Спал 7 часов", { chat, reply_to_message: { message_id: own.messageId } }), f.env, f.helpers), false);
  }
  assert.equal(await handleSportUpdate(f.message("Спал 7 часов", { reply_to_message: { message_id: own.messageId } }), f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(own.id).status, "completed");
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(other.id).status, "pending");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days WHERE owner_id=?").get(OTHER_OWNER).n, 0);
});

test("expired prompts are acknowledged without recording data or falling through into tasks", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  const prompt = f.seedPrompt({ expiresAt: "2026-10-23T05:59:59.999Z" });
  await webhook(f, f.message("Спал 7 часов", { reply_to_message: { message_id: prompt.messageId } }));
  for (const table of ["sport_days", "sport_meals", "sport_updates", "tasks"]) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.ok(f.calls.some(({ body }) => /устарел/.test(body.text)));
});

test("unparseable prompt answers retain the question and clarification aliases route back to Sport", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  const prompt = f.seedPrompt();
  await webhook(f, f.message("Не знаю", { reply_to_message: { message_id: prompt.messageId } }));
  const clarification = f.calls.find(({ body }) => /Не удалось разобрать/.test(body.text));
  assert.equal(clarification.body.reply_markup.force_reply, true);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "pending");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT prompt_id FROM sport_prompt_messages WHERE owner_id=? AND message_id=?").get(OWNER, clarification.messageId).prompt_id, prompt.id);
  await webhook(f, f.message("Хорошо, спал 7,5 часов", { message_id: 7002, reply_to_message: { message_id: clarification.messageId } }));
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, prompt.date).sleep_hours, 7.5);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
});

test("photo captions record only stated nutrients, never media or image-derived values, once per Telegram message", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  f.env.AI = { run() { assert.fail("Sport must not ask AI to infer nutrition from an image"); } };
  const update = f.message(undefined, {
    message_id: 7201,
    photo: [{ file_id: "fictional-photo-do-not-retain", file_unique_id: "fictional-media-reference", width: 100, height: 100 }],
    caption: "Овсянка, 400 ккал, Б 20",
    date: Date.parse("2026-10-23T22:30:00Z") / 1000,
  });
  await webhook(f, update);
  const meal = f.sqlite.prepare("SELECT * FROM sport_meals WHERE owner_id=?").get(OWNER);
  assert.equal(meal.title, "Овсянка");
  assert.equal(meal.date, "2026-10-24");
  assert.equal(meal.time, "01:30");
  assert.equal(meal.calories_kcal, 400);
  assert.equal(meal.protein_g, 20);
  assert.equal(meal.fat_g, null);
  assert.equal(meal.carbs_g, null);
  assert.equal(meal.source_type, "telegram");
  assert.equal(meal.nutrition_source, "manual");
  assert.equal(meal.media_id, null);
  assert.doesNotMatch(JSON.stringify(meal), /fictional-photo|fictional-media/);
  const confirmations = f.calls.length;
  await webhook(f, update);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals").get().n, 1);
  assert.equal(f.calls.length, confirmations);
});

test("photo without numeric nutrition in a meal reply clarifies rather than guessing or completing", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const prompt = f.seedPrompt({ kind: "meal", time: "12:30" });
  f.env.AI = { run() { assert.fail("Image-derived nutrition is forbidden"); } };
  assert.equal(await handleSportUpdate(f.message(undefined, {
    photo: [{ file_id: "fictional-food-photo" }], caption: "Овсянка", reply_to_message: { message_id: prompt.messageId },
  }), f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "pending");
  const clarification = f.calls.at(-1);
  assert.equal(await handleSportUpdate(f.message("Овсянка, 400 ккал", { message_id: 7002, reply_to_message: { message_id: clarification.messageId } }), f.env, f.helpers), true);
  const meal = f.sqlite.prepare("SELECT * FROM sport_meals").get();
  assert.equal(meal.date, prompt.date);
  assert.equal(meal.time, "12:30");
  assert.equal(meal.calories_kcal, 400);
  assert.equal(meal.protein_g, null);
  assert.equal(meal.fat_g, null);
  assert.equal(meal.carbs_g, null);
  assert.equal(meal.media_id, null);
});

test("webhook routes Sport before task parsing but leaves ordinary and unknown-reply text as tasks", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  f.seedPrompt();
  for (const [messageId, text, reply] of [
    [7301, "Подготовить вымышленный отчёт", undefined],
    [7302, "Спал 7 часов", { message_id: 123456 }],
  ]) await webhook(f, f.message(text, { message_id: messageId, reply_to_message: reply }));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_id=?").get(OWNER).n, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  await webhook(f, f.message("/sport итоги Воды 0 мл, шаги 0, питание нет", { message_id: 7303 }));
  const day = f.sqlite.prepare("SELECT * FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY);
  assert.equal(day.water_ml, 0);
  assert.equal(day.steps, 0);
  assert.equal(day.nutrition, 0);
  assert.equal(day.sleep_hours, null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 2);
});

test("webhook checks current access before accepting Sport updates from blocked or unknown users", async (t) => {
  const f = createSportFixture(t);
  installTelegram(t, f);
  for (const owner of [BLOCKED_OWNER, UNKNOWN_OWNER]) {
    await webhook(f, f.message("/sport sleep Спал 7 часов", {}, owner));
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  assert.ok(f.calls.every(({ body }) => /Доступ не настроен/.test(body.text)));
});

test("clarifications after an explicit unparseable Sport command must not become tasks", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  await webhook(f, f.message("/sport sleep Не знаю"));
  const clarification = f.calls.find(({ body }) => /Не удалось разобрать/.test(body.text));
  assert.ok(clarification);
  await webhook(f, f.message("Спал 7 часов", { message_id: 7002, reply_to_message: { message_id: clarification.messageId } }));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0, "a force-reply clarification is still Sport context");
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY)?.sleep_hours, 7);
});

const cronEvent = (time = NOW) => ({ cron: SPORT_CRON, scheduledTime: Date.parse(time) });
const occurrenceKey = (reminder, date = DAY) => `${reminder.id}:${date}:${reminder.time}`;

test("migration 0007 converts existing reminders to notifications without losing schedule or prompt data", (t) => {
  const { sqlite } = createSqliteD1(t, { migrations: ["0005_add_sport.sql"] });
  sqlite.prepare(`INSERT INTO sport_reminders (id,owner_id,kind,time,label,enabled,next_due_at,updated_at)
    VALUES ('fictional-legacy',?,'meal','13:00','Fictional lunch',1,?,?)`).run(OWNER, NOW, NOW);
  sqlite.prepare(`INSERT INTO sport_prompts (id,owner_id,chat_id,message_id,kind,label,date,time,created_at,expires_at)
    VALUES ('fictional-legacy-prompt',?,?,6001,'meal','Fictional question',?,'13:00',?,?)`).run(OWNER, OWNER, DAY, NOW, NOW);
  const before = { ...sqlite.prepare("SELECT * FROM sport_reminders").get() };
  const prompt = { ...sqlite.prepare("SELECT * FROM sport_prompts").get() };
  sqlite.exec(readFileSync(new URL("../cloudflare-worker/migrations/0007_add_sport_reminder_mode.sql", import.meta.url), "utf8"));
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM sport_reminders").get() }, { ...before, mode: "notification" });
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM sport_prompts").get() }, prompt);
  sqlite.prepare(`INSERT INTO sport_reminders (id,owner_id,kind,time,label,updated_at)
    VALUES ('fictional-new',?,'meal','19:00','Fictional dinner',?)`).run(OWNER, NOW);
  assert.equal(sqlite.prepare("SELECT mode FROM sport_reminders WHERE id='fictional-new'").get().mode, "notification");
  for (const mode of [null, "", "QUESTION", "unexpected"]) {
    assert.throws(() => sqlite.prepare("UPDATE sport_reminders SET mode=? WHERE id='fictional-new'").run(mode), /constraint/i);
  }
  sqlite.prepare("UPDATE sport_reminders SET mode='question' WHERE id='fictional-new'").run();
});

test("settings round-trip both modes, default omitted mode to notification and reject invalid modes atomically", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  t.mock.method(console, "error", () => {});
  const saved = await api(f, "/settings", { method: "PUT", body: settings({ reminders: [
    { kind: "sleep", time: "09:30", enabled: true },
    { kind: "meal", mode: "question", time: "13:00", enabled: true },
    { kind: "meal", mode: "notification", time: "19:00", enabled: false },
  ] }) });
  assert.deepEqual(saved.reminders.map(row => row.mode), ["notification", "question", "notification"]);
  assert.deepEqual((await api(f, RANGE)).reminders, saved.reminders);
  const stored = f.sqlite.prepare("SELECT * FROM sport_reminders ORDER BY time").all();
  for (const mode of [null, "", "QUESTION", "notify", 0, false, {}, []]) {
    await api(f, "/settings", { method: "PUT", body: settings({ reminders: [{ ...saved.reminders[0], mode }] }) }, 400);
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM sport_reminders ORDER BY time").all(), stored);
  }
  const changed = await api(f, "/settings", { method: "PUT", body: settings({
    reminders: saved.reminders.map(row => ({ ...row, mode: row.mode === "question" ? "notification" : "question" })),
  }) });
  assert.deepEqual(changed.reminders.map(row => row.id), saved.reminders.map(row => row.id));
  assert.deepEqual((await api(f, RANGE)).reminders, changed.reminders);
});

test("sixteen independent meal slots persist, resave and fire separately without duplicate fallback", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  t.mock.method(console, "error", () => {});
  const reminders = Array.from({ length: 16 }, (_, index) => ({
    kind: "meal", mode: "notification", enabled: true, label: `Fictional meal ${index + 1}`,
    time: `${String(10 + Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`,
  }));
  const saved = await api(f, "/settings", { method: "PUT", body: settings({ reminders }) });
  assert.equal(new Set(saved.reminders.map(row => row.id)).size, 16);
  assert.deepEqual(saved.reminders.map(({ id, ...row }) => row), reminders);
  await api(f, "/settings", { method: "PUT", body: settings({ reminders: saved.reminders }) });
  assert.deepEqual((await api(f, RANGE)).reminders, saved.reminders);
  await api(f, "/settings", { method: "PUT", body: settings({ reminders: [...saved.reminders, { ...reminders[0], time: "15:00" }] }) }, 400);
  await api(f, "/settings", { method: "PUT", body: settings({ reminders: [saved.reminders[0], { ...reminders[0], mode: "question" }] }) }, 400);
  assert.deepEqual((await api(f, RANGE)).reminders, saved.reminders);
  for (const reminder of saved.reminders) {
    const due = f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(reminder.id).next_due_at;
    t.mock.timers.setTime(Date.parse(due));
    assert.equal(await runSportReminders(cronEvent(due), f.env, f.helpers), 1);
    assert.equal(await runSportReminders(cronEvent(due), f.env, f.helpers), 0);
    assert.match(f.calls.at(-1).body.text, new RegExp(reminder.label));
    assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "sent");
  }
  assert.equal(f.calls.length, 16);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 0);
});

test("notification kinds send ordinary private messages with original local date and no prompt context", async (t) => {
  const time = "2026-10-23T18:30:00.000Z";
  freezeTime(t, time);
  const f = createSportFixture(t);
  f.env.TASKS_APP_URL = "https://sport.example.test/tasks/?ignored=1#ignored";
  for (const kind of ["sleep", "meal", "evening", "water", "steps"]) {
    f.seedReminder({ id: `fictional-notification-${kind}`, kind, timezone: "Asia/Kathmandu", time: "23:45", due: "2026-10-23T18:00:00.000Z" });
  }
  assert.equal(await runSportReminders(cronEvent(time), f.env, f.helpers), 5);
  for (const { method, body, messageId } of f.calls) {
    assert.equal(method, "sendMessage");
    assert.equal(String(body.chat_id), OWNER);
    assert.equal(body.reply_parameters, undefined);
    assert.deepEqual(body.reply_markup, { inline_keyboard: [[{
      text: "Открыть дневник", web_app: { url: `https://sport.example.test/sport/?date=${DAY}` },
    }]] });
    assert.match(body.text, /2026-10-23/);
    assert.doesNotMatch(body.text, /undefined|2026-10-24/);
    assert.equal(await handleSportUpdate(f.message("Спал 7 часов", { reply_to_message: { message_id: messageId } }), f.env, f.helpers), false);
  }
  for (const table of ["sport_prompts", "sport_prompt_messages", "sport_updates", "sport_days", "sport_meals"]) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(await runSportReminders(cronEvent(time), f.env, f.helpers), 0);
  assert.equal(f.calls.length, 5);
});

test("notification cron deduplicates concurrent delivery and advances already-claimed slots", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminder = f.seedReminder();
  const results = await Promise.all([runSportReminders(cronEvent(), f.env, f.helpers), runSportReminders(cronEvent(), f.env, f.helpers)]);
  assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
  f.sqlite.prepare("UPDATE sport_reminders SET next_due_at=? WHERE id=?").run(NOW, reminder.id);
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(reminder.id).next_due_at, "2026-10-24T06:00:00.000Z");
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_deliveries").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 0);
});

test("failed notification sends never create a prompt or retry an ambiguous delivery", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  t.mock.method(console, "error", () => {});
  const reminder = f.seedReminder();
  const helpers = { telegramApi: async (_env, method, body) => {
    f.calls.push({ method, body });
    throw new Error("Fictional ambiguous Telegram timeout");
  } };
  assert.equal(await runSportReminders(cronEvent(), f.env, helpers), 0);
  f.sqlite.prepare("UPDATE sport_reminders SET next_due_at=? WHERE id=?").run(NOW, reminder.id);
  assert.equal(await runSportReminders(cronEvent(), f.env, helpers), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "failed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 0);
});

test("mixed notification/question schedules retain ForceReply only for question and unrelated replies remain tasks", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  f.seedReminder({ id: "fictional-question", mode: "question" });
  f.seedReminder({ id: "fictional-notification", kind: "meal" });
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 2);
  const question = f.calls.find(({ body }) => body.reply_markup.force_reply);
  const notification = f.calls.find(({ body }) => body.reply_markup.inline_keyboard);
  assert.ok(question && notification);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 1);
  await webhook(f, f.message("Спал 7 часов", { message_id: 7801, reply_to_message: { message_id: notification.messageId } }));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_id=?").get(OWNER).n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  await webhook(f, f.message("Спал 7 часов", { message_id: 7802, reply_to_message: { message_id: question.messageId } }));
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY).sleep_hours, 7);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
  assert.ok(f.calls.at(-1).body.reply_markup.keyboard.flat().some(button => button.text === BUTTON_SPORT));
});

test("Sport menu button is available to allowed users before task capture without granting admin permissions", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  assert.equal(BUTTON_SPORT, "Спорт");
  f.sqlite.prepare("UPDATE assistant_users SET can_tasks=0,can_weather=0,can_gmail=0 WHERE telegram_user_id=?").run(OTHER_OWNER);
  const originalAccess = { ...f.sqlite.prepare("SELECT role,can_tasks,can_weather,can_gmail FROM assistant_users WHERE telegram_user_id=?").get(OWNER) };
  for (const owner of [OWNER, OTHER_OWNER, f.env.TELEGRAM_ADMIN_IDS]) {
    await webhook(f, f.message(BUTTON_SPORT, { message_id: 7901 }, owner));
    const button = f.calls.at(-1).body.reply_markup.inline_keyboard[0][0];
    assert.equal(new URL(button.web_app.url).pathname, "/sport/");
    assert.equal(String(f.calls.at(-1).body.chat_id), owner);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  assert.deepEqual({ ...f.sqlite.prepare("SELECT role,can_tasks,can_weather,can_gmail FROM assistant_users WHERE telegram_user_id=?").get(OWNER) }, originalAccess);
  for (const [index, text] of ["/allow @fictional_new_user", "/users", "/block @fictional_810002"].entries()) {
    await webhook(f, f.message(text, { message_id: 7902 + index }));
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_users").get().n, 3);
  assert.equal(f.sqlite.prepare("SELECT status FROM assistant_users WHERE telegram_user_id=?").get(OTHER_OWNER).status, "active");
  for (const owner of [BLOCKED_OWNER, UNKNOWN_OWNER]) {
    await webhook(f, f.message(BUTTON_SPORT, {}, owner));
    assert.match(f.calls.at(-1).body.text, /Доступ не настроен/);
    assert.equal(f.calls.at(-1).body.reply_markup, undefined);
  }
});

test("reply keyboards show Sport only when enabled and keep non-admin controls restricted", async (t) => {
  const f = createSportFixture(t);
  installTelegram(t, f);
  for (const enabled of ["true", "false", undefined]) {
    f.env.SPORT_ENABLED = enabled;
    for (const owner of [OWNER, f.env.TELEGRAM_ADMIN_IDS]) {
      await webhook(f, f.message("/menu", {}, owner));
      const buttons = f.calls.at(-1).body.reply_markup.keyboard.flat().map(button => button.text);
      assert.equal(buttons.includes(BUTTON_SPORT), enabled === "true");
      assert.equal(buttons.filter(text => text === BUTTON_SPORT).length, enabled === "true" ? 1 : 0);
      if (owner === OWNER) assert.ok(buttons.every(text => text === BUTTON_SPORT || /Моя почта|Погода/.test(text)));
    }
  }
});

test("Sport scheduler requires the minute cron and explicit enable flag", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  f.seedReminder({ mode: "question" });
  assert.equal(SPORT_CRON, "* * * * *");
  for (const value of [undefined, "false", "TRUE"]) {
    f.env.SPORT_ENABLED = value;
    assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  }
  f.env.SPORT_ENABLED = "true";
  assert.equal(await runSportReminders({ ...cronEvent(), cron: "0 5 * * *" }, f.env, f.helpers), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_deliveries").get().n, 0);
});

test("due reminders send only enabled due slots, link expiring prompts and advance to the next local day", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminder = f.seedReminder({ mode: "question" });
  f.seedReminder({ mode: "question", id: "fictional-future-reminder", kind: "meal", time: "09:01", due: "2026-10-23T06:01:00.000Z" });
  f.seedReminder({ mode: "question", id: "fictional-disabled-reminder", kind: "evening", enabled: false });
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(String(f.calls[0].body.chat_id), OWNER);
  assert.equal(f.calls[0].body.reply_markup.force_reply, true);
  const prompt = f.sqlite.prepare("SELECT * FROM sport_prompts").get();
  assert.equal(prompt.owner_id, OWNER);
  assert.equal(prompt.chat_id, OWNER);
  assert.equal(prompt.date, DAY);
  assert.equal(prompt.time, "09:00");
  assert.equal(prompt.status, "pending");
  assert.equal(prompt.message_id, f.calls[0].messageId);
  assert.equal(Date.parse(prompt.expires_at) - Date.parse(prompt.created_at), 18 * 3600000);
  assert.equal(f.sqlite.prepare("SELECT prompt_id FROM sport_prompt_messages WHERE owner_id=? AND message_id=?").get(OWNER, prompt.message_id).prompt_id, prompt.id);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "sent");
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(reminder.id).next_due_at, "2026-10-24T06:00:00.000Z");
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  assert.equal(f.calls.length, 1);
});

test("concurrent minute cron invocations claim each occurrence only once", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  f.seedReminder({ mode: "question" });
  const results = await Promise.all([
    runSportReminders(cronEvent(), f.env, f.helpers),
    runSportReminders(cronEvent(), f.env, f.helpers),
  ]);
  assert.equal(results.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_deliveries").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 1);
});

test("an already-claimed occurrence still advances a stale due slot without sending again", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminder = f.seedReminder({ mode: "question" });
  f.sqlite.prepare("INSERT INTO sport_deliveries (id,owner_id,status,created_at) VALUES (?,?,'sent',?)")
    .run(occurrenceKey(reminder), OWNER, NOW);
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(reminder.id).next_due_at, "2026-10-24T06:00:00.000Z");
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "sent");
});

test("delivery keys include local date and wall time so a rescheduled slot is a new occurrence", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminder = f.seedReminder({ mode: "question" });
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 1);
  f.sqlite.prepare("UPDATE sport_reminders SET time=?,next_due_at=? WHERE id=?").run("09:01", "2026-10-23T06:01:00.000Z", reminder.id);
  assert.equal(await runSportReminders(cronEvent("2026-10-23T06:01:00Z"), f.env, f.helpers), 1);
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM sport_deliveries ORDER BY id").all().map(row => row.id), [
    occurrenceKey(reminder), occurrenceKey({ ...reminder, time: "09:01" }),
  ]);
  assert.equal(f.calls.length, 2);
});

test("scheduler skips old backlog and users whose access was blocked or removed", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminders = [
    f.seedReminder({ mode: "question", id: "fictional-stale-slot", time: "08:29", due: "2026-10-23T05:29:00.000Z" }),
    f.seedReminder({ mode: "question", id: "fictional-blocked-slot", ownerId: BLOCKED_OWNER }),
    f.seedReminder({ mode: "question", id: "fictional-unknown-slot", ownerId: UNKNOWN_OWNER }),
  ];
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 0);
  for (const reminder of reminders) {
    assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "skipped");
    assert.ok(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE id=?").get(reminder.id).next_due_at > NOW);
  }
});

test("30-minute late reminders are delivered using the stored occurrence rather than today's UTC date", async (t) => {
  freezeTime(t, "2026-10-23T18:30:00Z");
  const f = createSportFixture(t);
  f.seedReminder({ mode: "question", time: "23:45", timezone: "Asia/Kathmandu", due: "2026-10-23T18:00:00.000Z" });
  assert.equal(await runSportReminders(cronEvent("2026-10-23T18:30:00Z"), f.env, f.helpers), 1);
  const prompt = f.sqlite.prepare("SELECT date,time FROM sport_prompts").get();
  assert.equal(prompt.date, "2026-10-23");
  assert.equal(prompt.time, "23:45");
  assert.match(f.calls[0].body.text, /2026-10-23/);
});

test("ambiguous Telegram send failures are marked failed and never automatically retried", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const reminder = f.seedReminder({ mode: "question" });
  t.mock.method(console, "error", () => {});
  const helpers = { telegramApi: async (_env, method, body) => {
    f.calls.push({ method, body });
    throw new Error("fictional timeout after Telegram may have accepted the message");
  } };
  assert.equal(await runSportReminders(cronEvent(), f.env, helpers), 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_deliveries WHERE id=?").get(occurrenceKey(reminder)).status, "failed");
  assert.equal(await runSportReminders(cronEvent(), f.env, helpers), 0);
  f.sqlite.prepare("UPDATE sport_reminders SET next_due_at=? WHERE id=?").run(NOW, reminder.id);
  assert.equal(await runSportReminders(cronEvent(), f.env, helpers), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 1);
});

test("scheduler retains seven days of retry metadata and cascades expired prompt aliases", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const old = "2026-10-16T05:59:59.999Z", boundary = "2026-10-16T06:00:00.000Z";
  for (const [id, createdAt] of [["fictional-old", old], ["fictional-boundary", boundary], ["fictional-current", NOW]]) {
    f.sqlite.prepare("INSERT INTO sport_deliveries (id,owner_id,created_at) VALUES (?,?,?)").run(id, OWNER, createdAt);
    f.sqlite.prepare("INSERT INTO sport_updates (id,owner_id,created_at) VALUES (?,?,?)").run(id, OWNER, createdAt);
  }
  const oldPrompt = f.seedPrompt({ id: "fictional-old-prompt", messageId: 6001, expiresAt: old });
  const boundaryPrompt = f.seedPrompt({ id: "fictional-boundary-prompt", messageId: 6002, expiresAt: boundary });
  const livePrompt = f.seedPrompt({ id: "fictional-live-prompt", messageId: 6003 });
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 0);
  for (const table of ["sport_deliveries", "sport_updates"]) {
    assert.deepEqual(f.sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id), ["fictional-boundary", "fictional-current"]);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts WHERE id=?").get(oldPrompt.id).n, 0);
  assert.deepEqual(f.sqlite.prepare("SELECT prompt_id FROM sport_prompt_messages ORDER BY prompt_id").all().map(row => row.prompt_id), [boundaryPrompt.id, livePrompt.id]);
});

test("simultaneous questions require an explicit reply target and cannot consume an ambiguous bare answer", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  f.seedReminder({ mode: "question", id: "fictional-sleep-reminder", kind: "sleep" });
  f.seedReminder({ mode: "question", id: "fictional-meal-reminder", kind: "meal" });
  assert.equal(await runSportReminders(cronEvent(), f.env, f.helpers), 2);
  assert.ok(f.calls.every(({ body }) => body.reply_markup.force_reply === true));
  assert.equal(await handleSportUpdate(f.message("7,5"), f.env, f.helpers), false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_meals").get().n, 0);
  const prompts = Object.fromEntries(f.sqlite.prepare("SELECT * FROM sport_prompts").all().map(prompt => [prompt.kind, prompt]));
  assert.equal(await handleSportUpdate(f.message("Спал 7,5 часов", { message_id: 7002, reply_to_message: { message_id: prompts.sleep.message_id } }), f.env, f.helpers), true);
  assert.equal(await handleSportUpdate(f.message("Овсянка, 400 ккал", { message_id: 7003, reply_to_message: { message_id: prompts.meal.message_id } }), f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, DAY).sleep_hours, 7.5);
  assert.equal(f.sqlite.prepare("SELECT calories_kcal FROM sport_meals WHERE owner_id=? AND date=?").get(OWNER, DAY).calories_kcal, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts WHERE status='completed'").get().n, 2);
});

test("worker connects both Sport API and minute cron to the backend", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  f.seedReminder({ mode: "question" });
  const response = await worker.fetch(f.request(RANGE), f.env, { waitUntil() { assert.fail("Sport API should not dispatch background work"); } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).days, []);
  await worker.scheduled(cronEvent(), f.env, { waitUntil() { assert.fail("Sport cron should not dispatch workflows"); } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_prompts").get().n, 1);
});

test("DST spring-forward nonexistent reminder times resolve to the next valid local minute", () => {
  assert.equal(nextReminderDue({ time: "02:30" }, "America/New_York", new Date("2026-03-08T06:00:00Z")), "2026-03-08T07:00:00.000Z");
});

test("DST repeated reminder times use only the first occurrence for a local date", () => {
  assert.equal(nextReminderDue({ time: "01:30" }, "America/New_York", new Date("2026-11-01T05:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextReminderDue({ time: "01:30" }, "America/New_York", new Date("2026-11-01T05:45:00Z")), "2026-11-02T06:30:00.000Z");
});

test("sleep parser rejects clock intervals instead of treating a bedtime as hours slept", () => {
  for (const text of ["Спал с 23:00 до 7:00", "Спала с 23 до 7"]) {
    assert.equal(parseSportReply("sleep", text), null, text);
  }
});

test("sleep parser recognizes Cyrillic hour boundaries and does not label negated good sleep as good", () => {
  const parsed = parseSportReply("sleep", "7 часов, сегодня хорошо");
  assert.equal(parsed.day.sleep_hours, 7);
  assert.equal(parsed.day.sleep_quality, 4);
  const poor = parseSportReply("sleep", "Спал 7 часов, не очень хорошо");
  assert.equal(poor.day.sleep_hours, 7);
  assert.equal(poor.day.sleep_quality, 2);
});

test("evening parser distinguishes additive water messages from daily totals", () => {
  for (const text of ["Ещё 500 мл воды", "ещё500мл", "Добавь 500 мл воды"]) {
    assert.equal(parseSportReply("evening", text), null, text);
  }
  assert.equal(parseSportReply("evening", "Воды 500 мл").day.water_ml, 500);
});

test("evening step counts support thousands separators and explicit thousands units", () => {
  for (const text of ["шаги 8.500", "8.500 шагов", "шаги 8 500", "шаги 8,5 тыс"]) {
    assert.equal(parseSportReply("evening", text).day.steps, 8500, text);
  }
});

test("failed diary persistence releases the prompt and update claim so the same Telegram update can retry", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const prompt = f.seedPrompt();
  const update = { update_id: 880001, ...f.message("Спал 7 часов", { reply_to_message: { message_id: prompt.messageId } }) };
  f.sqlite.exec("CREATE TRIGGER fictional_failed_save BEFORE INSERT ON sport_days BEGIN SELECT RAISE(ABORT, 'fictional temporary failure'); END");
  assert.equal(await handleSportUpdate(update, f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "pending");
  assert.ok(f.calls.some(({ body }) => /Не удалось сохранить/.test(body.text)));
  assert.ok(f.calls.every(({ body }) => !/Сохранено за/.test(body.text)));
  f.sqlite.exec("DROP TRIGGER fictional_failed_save");
  assert.equal(await handleSportUpdate(update, f.env, f.helpers), true);
  assert.equal(f.sqlite.prepare("SELECT sleep_hours FROM sport_days WHERE owner_id=? AND date=?").get(OWNER, prompt.date).sleep_hours, 7);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 1);
});

test("water replies require units and return only the water field", () => {
  for (const [text, water] of [["2 л", 2000], ["1750 мл", 1750], ["Воды 1,5 л", 1500], ["0 мл", 0]]) {
    assert.deepEqual(parseSportReply("water", text), { day: { water_ml: water } }, text);
  }
  for (const text of ["2000", "Воды 2", "8500 шагов", "Ещё 500 мл воды", "Не знаю", ""]) {
    assert.equal(parseSportReply("water", text), null, text);
  }
});

test("steps replies accept bare counts including zero and return only the steps field", () => {
  for (const [text, steps] of [["8500", 8500], ["0", 0], ["8 500", 8500], ["Шаги 8.500", 8500], ["8500 шагов", 8500]]) {
    assert.deepEqual(parseSportReply("steps", text), { day: { steps } }, text);
  }
  for (const text of ["2 л воды", "Не знаю", ""]) assert.equal(parseSportReply("steps", text), null, text);
});

test("independent water and steps parsers discard other metrics from a mixed evening answer", () => {
  const text = "Воды 2 л, шаги 8500, питание нет";
  assert.deepEqual(parseSportReply("water", text), { day: { water_ml: 2000 } });
  assert.deepEqual(parseSportReply("steps", text), { day: { steps: 8500 } });
  assert.deepEqual(parseSportReply("evening", text), { day: { water_ml: 2000, steps: 8500, nutrition: false } });
});

test("settings persist water, steps and evening as independent end-of-day schedules", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  const initial = await api(f, "/settings", { method: "PUT", body: settings({ reminders: [
    { kind: "evening", time: "20:30", label: "Fictional day summary", enabled: true },
    { kind: "water", time: "21:00", label: "Fictional water total", enabled: true },
    { kind: "steps", time: "22:00", label: "Fictional step total", enabled: true },
  ] }) });
  const expectedDue = {
    evening: "2026-10-23T17:30:00.000Z", water: "2026-10-23T18:00:00.000Z", steps: "2026-10-23T19:00:00.000Z",
  };
  const stored = f.sqlite.prepare("SELECT kind,time,next_due_at FROM sport_reminders WHERE owner_id=? ORDER BY time").all(OWNER);
  assert.deepEqual(stored.map(row => row.kind), ["evening", "water", "steps"]);
  for (const row of stored) assert.equal(row.next_due_at, expectedDue[row.kind]);
  assert.deepEqual((await api(f, RANGE)).reminders, initial.reminders);
  const changed = await api(f, "/settings", { method: "PUT", body: settings({
    reminders: initial.reminders.map(reminder => reminder.kind === "water" ? { ...reminder, time: "21:15" } : reminder),
  }) });
  assert.deepEqual(changed.reminders.map(reminder => reminder.id), initial.reminders.map(reminder => reminder.id));
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE kind='water' AND owner_id=?").get(OWNER).next_due_at, "2026-10-23T18:15:00.000Z");
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE kind='steps' AND owner_id=?").get(OWNER).next_due_at, expectedDue.steps);
  assert.equal(f.sqlite.prepare("SELECT next_due_at FROM sport_reminders WHERE kind='evening' AND owner_id=?").get(OWNER).next_due_at, expectedDue.evening);
});

for (const [kind, text, field, value] of [
  ["water", "Воды 2 л, шаги 9999, питание да", "water_ml", 2000],
  ["steps", "8500", "steps", 8500],
]) {
  test(`${kind} prompt replies update only their metric and stay out of task routing`, async (t) => {
    freezeTime(t);
    const f = createSportFixture(t);
    installTelegram(t, f);
    const initial = { water_ml: 1750, steps: 1234, weight_kg: 71.5, sleep_hours: 7.5, nutrition: false, comment: "Fictional preserved comment" };
    await api(f, `/days/${DAY}`, { method: "PUT", body: initial });
    const before = (await api(f, RANGE)).days[0];
    const prompt = f.seedPrompt({ kind, date: DAY, time: kind === "water" ? "21:00" : "22:00" });
    await webhook(f, f.message(text, { reply_to_message: { message_id: prompt.messageId } }));
    assert.deepEqual((await api(f, RANGE)).days, [{ ...before, [field]: value }]);
    assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "completed");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_days WHERE owner_id=?").get(OTHER_OWNER).n, 0);
  });
}

test("water answers without units remain pending and clarification replies save only water", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 1234, nutrition: false } });
  const prompt = f.seedPrompt({ kind: "water", date: DAY, time: "21:00" });
  await webhook(f, f.message("2000", { reply_to_message: { message_id: prompt.messageId } }));
  const pending = (await api(f, RANGE)).days[0];
  assert.equal(pending.water_ml, null);
  assert.equal(pending.steps, 1234);
  assert.equal(pending.nutrition, false);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE id=?").get(prompt.id).status, "pending");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_updates").get().n, 0);
  const clarification = f.calls.find(({ body }) => /Не удалось разобрать/.test(body.text));
  assert.ok(clarification);
  await webhook(f, f.message("0 мл", { message_id: 7002, reply_to_message: { message_id: clarification.messageId } }));
  assert.deepEqual((await api(f, RANGE)).days, [{ ...pending, water_ml: 0 }]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
});

test("water and steps prompts created by independent cron slots route to their own metrics", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t);
  installTelegram(t, f);
  await api(f, `/days/${DAY}`, { method: "PUT", body: { water_ml: 1750, steps: 1234, nutrition: false } });
  await api(f, "/settings", { method: "PUT", body: settings({ reminders: [
    { kind: "evening", mode: "question", time: "20:30", label: "Fictional summary", enabled: true },
    { kind: "water", mode: "question", time: "21:00", label: "Fictional water", enabled: true },
    { kind: "steps", mode: "question", time: "22:00", label: "Fictional steps", enabled: true },
  ] }) });
  for (const [time, kind] of [["2026-10-23T17:30:00Z", "evening"], ["2026-10-23T18:00:00Z", "water"], ["2026-10-23T19:00:00Z", "steps"]]) {
    t.mock.timers.setTime(Date.parse(time));
    assert.equal(await runSportReminders(cronEvent(time), f.env, f.helpers), 1);
    assert.equal(await runSportReminders(cronEvent(time), f.env, f.helpers), 0);
    const prompt = f.sqlite.prepare("SELECT * FROM sport_prompts WHERE kind=?").get(kind);
    assert.equal(prompt.kind, kind);
    assert.equal(prompt.date, DAY);
    assert.equal(f.calls.at(-1).body.reply_markup.force_reply, true);
    assert.doesNotMatch(f.calls.at(-1).body.text, /undefined/);
  }
  assert.equal(f.calls.length, 3);
  const prompts = Object.fromEntries(f.sqlite.prepare("SELECT * FROM sport_prompts").all().map(prompt => [prompt.kind, prompt]));
  await webhook(f, f.message("Воды 2 л, шаги 9999, питание да", { message_id: 7501, reply_to_message: { message_id: prompts.water.message_id } }));
  const afterWater = (await api(f, RANGE)).days[0];
  assert.equal(afterWater.water_ml, 2000);
  assert.equal(afterWater.steps, 1234);
  assert.equal(afterWater.nutrition, false);
  await webhook(f, f.message("8500", { message_id: 7502, reply_to_message: { message_id: prompts.steps.message_id } }));
  assert.deepEqual((await api(f, RANGE)).days, [{ ...afterWater, steps: 8500 }]);
  assert.equal(f.sqlite.prepare("SELECT status FROM sport_prompts WHERE kind='evening'").get().status, "pending");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_deliveries WHERE status='sent'").get().n, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
});

for (const [kind, alias, text, field, value] of [
  ["water", "вода", "2 л, шаги 9999, питание да", "water_ml", 2000],
  ["steps", "шаги", "8500", "steps", 8500],
]) {
  test(`explicit ${kind} commands and Russian aliases preserve unrelated day fields`, async (t) => {
    freezeTime(t);
    const f = createSportFixture(t);
    installTelegram(t, f);
    await api(f, `/days/${DAY}`, { method: "PUT", body: { water_ml: 1750, steps: 1234, nutrition: false } });
    const before = (await api(f, RANGE)).days[0];
    for (const [index, command] of [kind, alias].entries()) {
      await webhook(f, f.message(`/sport ${command} ${text}`, { message_id: 7601 + index }));
      assert.deepEqual((await api(f, RANGE)).days, [{ ...before, [field]: value }]);
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
  });
}
