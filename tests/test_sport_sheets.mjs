import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  buildDiaryRows,
  getSheetExportConfig,
  normalizeSheetUrl,
  runSportSheetExports,
  saveSheetExportConfig,
} from "../cloudflare-worker/src/sport-sheets.js";
import { handleSportApi } from "../cloudflare-worker/src/sport.js";
import {
  BLOCKED_OWNER,
  createSportFixture,
  OTHER_OWNER,
  OWNER,
  signedInitData,
  UNKNOWN_OWNER,
} from "./sport-db-fixture.mjs";

const REFERENCE_ID = "1apTYgJfkNRU_Cs_w9p0VtXaA41fM1N0cROG2fhoTjtk";
const DESTINATION_ID = "fictional_owned_destination_810001";
const DESTINATION_URL = `https://docs.google.com/spreadsheets/d/${DESTINATION_ID}/edit`;
const DAY = "2026-10-23";
const NOW = "2026-10-24T00:15:00.000Z";
const HEADERS = ["Дата", "Вес (кг)", "Сон (ч)", "Вода (л)", "Шаги", "Тренировка", "Питание в норме?", "Настроение / Стресс", "Комментарий клиента", "Заметка тренера"];
const TABS = ["Дневник (Ежедневно)", "Дашборд и Аналитика", "Справочник и Цели"];
const OTHER_DESTINATION_ID = "fictional_owned_destination_810002";
const sheetUrl = (id = DESTINATION_ID) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const serialDate = date => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

let generatedKey;
let accountSequence = 0;
function serviceAccount(f, suffix = String(++accountSequence)) {
  generatedKey ||= generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    type: "service_account", project_id: "fictional-sport-test-project",
    private_key_id: "fictional-private-key-id",
    private_key: generatedKey.privateKey.export({ format: "pem", type: "pkcs8" }),
    client_email: `fictional-${suffix}@sport-test.invalid`,
    token_uri: "https://oauth2.googleapis.com/token",
  };
  f.env.GOOGLE_SHEETS_SERVICE_ACCOUNT = JSON.stringify(account);
  return account;
}

function freezeTime(t, time = NOW) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(time) });
}

function noNetwork(t) {
  return t.mock.method(globalThis, "fetch", () => { assert.fail("No network call is permitted in this test"); });
}

function sheetState(extra = {}) {
  return { title: "Fictional personal diary", tabs: [...TABS], gridRows: 100, values: [[...HEADERS]], ...extra };
}

function mockGoogle(t, destinations = new Map([[DESTINATION_ID, sheetState()]])) {
  const calls = [], writes = [], layout = [], oauth = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(String(input)), method = options.method || "GET";
    assert.ok(!url.href.includes(REFERENCE_ID), "the protected reference must never receive API traffic");
    if (url.href === "https://oauth2.googleapis.com/token") {
      assert.equal(method, "POST");
      const params = new URLSearchParams(options.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = params.get("assertion"), parts = assertion.split(".");
      assert.equal(parts.length, 3);
      assert.equal(JSON.parse(Buffer.from(parts[0], "base64url")).alg, "RS256");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets");
      assert.ok(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), generatedKey.publicKey, Buffer.from(parts[2], "base64url")));
      oauth.push(claims);
      return Response.json({ access_token: "fictional-sheets-access-token", expires_in: 3600 });
    }
    assert.equal(url.origin, "https://sheets.googleapis.com", `unexpected network host: ${url.origin}`);
    assert.equal(options.headers.Authorization, "Bearer fictional-sheets-access-token");
    const path = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
    assert.ok(path, url.pathname);
    const id = decodeURIComponent(path[1]), suffix = path[2], state = destinations.get(id);
    assert.ok(state, `unexpected fictional destination: ${id}`);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ id, method, suffix, body, url: url.href });
    if (state.status) return Response.json({ error: { message: "fictional Google error body must not be logged" } }, { status: state.status });
    if (method === "GET" && suffix === "") return Response.json({
      properties: { title: state.title },
      sheets: state.tabs.map((title, sheetId) => ({ properties: { sheetId, title, gridProperties: { rowCount: state.gridRows } } })),
    });
    if (method === "GET" && suffix.startsWith("/values/")) {
      const range = decodeURIComponent(suffix.slice("/values/".length));
      assert.match(range, /^'Дневник \(Ежедневно\)'!A1:J\d+$/);
      if (state.onValuesRead) await state.onValuesRead();
      return Response.json({ range, values: structuredClone(state.values) });
    }
    if (method === "POST" && suffix === "/values:batchUpdate") {
      writes.push({ id, body });
      for (const update of body.data) {
        const range = update.range.match(/^'Дневник \(Ежедневно\)'!A(\d+):J(\d+)$/);
        if (!range) {
          const goal = update.range.match(/^'Справочник и Цели'!B([2-5])$/);
          assert.ok(goal, `unexpected write range: ${update.range}`);
          assert.equal(update.values.length, 1);
          assert.equal(update.values[0].length, 1);
          state.goalCells ||= {};
          state.goalCells[`B${goal[1]}`] = update.values[0][0];
          continue;
        }
        assert.equal(range[1], range[2]);
        assert.equal(update.values.length, 1);
        assert.equal(update.values[0].length, 10);
        state.values[Number(range[1]) - 1] = [...update.values[0]];
      }
      if (state.onWrite) await state.onWrite();
      return Response.json({ totalUpdatedRows: body.data.length });
    }
    if (method === "POST" && suffix === ":batchUpdate") {
      layout.push({ id, body });
      for (const request of body.requests) {
        if (request.appendDimension?.dimension === "ROWS") state.gridRows += request.appendDimension.length;
      }
      return Response.json({ replies: body.requests.map(() => ({})) });
    }
    assert.fail(`unexpected Google operation: ${method} ${suffix}`);
  });
  return { calls, writes, layout, oauth, destinations };
}

async function api(f, path, options = {}, status = 200) {
  const response = await handleSportApi(f.request(path, options), f.env);
  assert.ok(response instanceof Response);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return body;
}

function seedProfile(f, ownerId = OWNER, timezone = "Europe/Moscow", goals = {}) {
  f.sqlite.prepare(`INSERT INTO sport_profiles (owner_id,timezone,goals_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone,goals_json=excluded.goals_json`)
    .run(ownerId, timezone, JSON.stringify(goals), new Date().toISOString());
}

async function verifiedConfig(f, state, ownerId = OWNER, id = DESTINATION_ID) {
  const config = await saveSheetExportConfig(f.db, ownerId, f.env, { spreadsheet_url: sheetUrl(id), enabled: false });
  state.title = `Fictional personal diary ${config.verification_code}`;
  const enabled = await saveSheetExportConfig(f.db, ownerId, f.env, { spreadsheet_url: sheetUrl(id), enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.verified, true);
  return enabled;
}

function cron(time = NOW) { return { cron: "* * * * *", scheduledTime: Date.parse(time) }; }

function seedManyDays(f, count, { dense = false } = {}) {
  const insert = f.sqlite.prepare(`INSERT INTO sport_days
    (owner_id,date,steps,comment,coach_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  for (let index = 0; index < count; index++) {
    const date = new Date(Date.UTC(2025, 0, 1) + index * 86400000).toISOString().slice(0, 10);
    insert.run(OWNER, date, index, dense ? "Я".repeat(2000) : "Fictional batch diary", dense ? "Ж".repeat(2000) : "", NOW, NOW);
  }
}

function diaryDay(extra = {}) {
  return {
    date: DAY, weight_kg: null, sleep_hours: null, water_ml: null, steps: null,
    training: null, nutrition: null, mood: null, comment: "", coach_note: "",
    ...extra,
  };
}

function freezeTree(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

test("the third-party reference spreadsheet can never be an export destination", () => {
  for (const suffix of ["", "/edit", "/edit?usp=sharing#gid=0", "/copy"]) {
    assert.throws(() => normalizeSheetUrl(`https://docs.google.com/spreadsheets/d/${REFERENCE_ID}${suffix}`));
  }
});

test("sheet URLs reject foreign hosts, lookalikes, user-info tricks and non-HTTPS URLs", () => {
  for (const value of [
    `https://example.test/spreadsheets/d/${DESTINATION_ID}/edit`,
    `https://docs.google.com.example.test/spreadsheets/d/${DESTINATION_ID}/edit`,
    `https://docs.google.com@example.test/spreadsheets/d/${DESTINATION_ID}/edit`,
    `http://docs.google.com/spreadsheets/d/${DESTINATION_ID}/edit`,
    `javascript:alert('${DESTINATION_ID}')`,
    "https://docs.google.com/document/d/fictional-document/edit",
    "https://docs.google.com/spreadsheets/d//edit",
    "", null, {},
  ]) assert.throws(() => normalizeSheetUrl(value), String(value));
});

test("normalizing a destination removes sharing parameters and fragment identifiers", () => {
  assert.equal(normalizeSheetUrl(`  ${DESTINATION_URL}?usp=sharing#gid=123  `), DESTINATION_URL);
});

test("no diary records produce no header, layout or placeholder rows", () => {
  assert.deepEqual(buildDiaryRows([], []), []);
});

test("missing diary metrics stay empty rather than becoming zeros or false", () => {
  const rows = buildDiaryRows([diaryDay()], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 10);
  assert.deepEqual(rows[0].slice(1), ["", "", "", "", "", "", "", "", ""]);
});

test("the exact A:J mapping preserves numeric zero, false nutrition and liters", () => {
  const rows = buildDiaryRows([diaryDay({
    weight_kg: 71.5, sleep_hours: 7.5, water_ml: 1750, steps: 0,
    nutrition: false, comment: "Fictional diary comment", coach_note: "Fictional trainer note",
  })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 10);
  assert.deepEqual(rows[0].slice(1, 8), [71.5, 7.5, 1.75, 0, "", false, ""]);
  assert.equal(rows[0][8], "Fictional diary comment");
  assert.equal(rows[0][9], "Fictional trainer note");
  const zero = buildDiaryRows([diaryDay({ sleep_hours: 0, water_ml: 0, steps: 0, nutrition: true })], [])[0];
  assert.deepEqual(zero.slice(2, 7), [0, 0, 0, "", true]);
});

test("row construction never mutates, sorts in place or annotates diary and meal inputs", () => {
  const days = [diaryDay({ comment: "Fictional original", nutrition: false }), diaryDay({ date: "2026-10-22", steps: 0 })];
  const meals = [{
    id: "fictional-export-meal", owner_id: OWNER, date: DAY, time: "12:30", title: "Fictional oats",
    calories_kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 55, note: "Fictional meal note",
    source_type: "telegram", nutrition_source: "manual", media_id: null,
  }];
  const before = structuredClone({ days, meals });
  freezeTree(days);
  freezeTree(meals);
  const rows = buildDiaryRows(days, meals);
  assert.ok(rows.every(row => row.length === 10));
  assert.deepEqual({ days, meals }, before);
});

test("nutrition is a boolean or an empty cell, including raw SQLite zero and one", () => {
  for (const [nutrition, expected] of [[false, false], [true, true], [0, false], [1, true], [null, ""], [undefined, ""]]) {
    const rows = buildDiaryRows([diaryDay({ nutrition })], []);
    assert.equal(rows[0].length, 10);
    assert.equal(rows[0][6], expected);
  }
});

test("meal nutrition is included in comment I without adding columns or replacing coach note J", () => {
  const meals = [{
    id: "fictional-meal-comment", date: DAY, time: "12:30", title: "Fictional oats",
    calories_kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 55, note: "Fictional meal note",
    source_type: "telegram", nutrition_source: "manual",
  }];
  const rows = buildDiaryRows([diaryDay({ comment: "Fictional original comment", coach_note: "Fictional trainer note" })], meals);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 10);
  assert.ok(rows[0][8].includes("Fictional original comment"));
  for (const value of ["Fictional oats", "400", "20", "10", "55"]) assert.ok(rows[0][8].includes(value), value);
  assert.equal(rows[0][9], "Fictional trainer note");
});

test("training and mood labels match the Russian sample without adding a sleep-quality column", () => {
  for (const [training, label] of [["rest", "Отдых"], ["strength", "Силовая"], ["cardio", "Кардио"], ["stretch", "Растяжка / МФР"], ["other", "Другое"]]) {
    const row = buildDiaryRows([diaryDay({ training, mood: 4, sleep_quality: 5 })], [])[0];
    assert.equal(row.length, 10);
    assert.equal(row[0], DAY);
    assert.equal(row[5], label);
    assert.equal(row[7], "4 - Хорошо");
  }
  for (const [mood, label] of [[1, "Ужасно"], [2, "Плохо"], [3, "Норма"], [5, "Отлично"]]) {
    assert.equal(buildDiaryRows([diaryDay({ mood })], [])[0][7], `${mood} - ${label}`);
  }
});

test("meal-only dates are exported once in order and unknown nutrients are not reported as zero totals", () => {
  const meals = [
    { date: DAY, time: "12:00", title: "Fictional known meal", calories_kcal: 400, protein_g: 0, fat_g: null, carbs_g: null },
    { date: DAY, time: "18:00", title: "Fictional unknown meal", calories_kcal: null, protein_g: null, fat_g: null, carbs_g: null },
  ];
  const rows = buildDiaryRows([diaryDay({ date: "2026-10-24" })], meals);
  assert.deepEqual(rows.map(row => row[0]), [DAY, "2026-10-24"]);
  assert.ok(rows.every(row => row.length === 10));
  assert.deepEqual(rows[0].slice(1, 8), ["", "", "", "", "", "", ""]);
  assert.match(rows[0][8], /400 \(неполные данные\) ккал/);
  assert.match(rows[0][8], /Б 0 \(неполные данные\) г/);
  assert.match(rows[0][8], /Ж — г, У — г/);
});

test("missing credentials expose configured=false, permit disabled URL saving and forbid enabling without network", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), fetchMock = noNetwork(t);
  for (const credential of [undefined, "not-json", "{}", '{"type":"service_account","client_email":"fictional@invalid"}']) {
    f.env.GOOGLE_SHEETS_SERVICE_ACCOUNT = credential;
    const config = await getSheetExportConfig(f.db, OWNER, f.env);
    assert.equal(config.configured, false);
    assert.equal(config.status, "not_configured");
    assert.equal(config.service_email, "");
    assert.equal(await runSportSheetExports(cron(), f.env), 0);
  }
  const saved = await saveSheetExportConfig(f.db, OWNER, f.env, { spreadsheet_url: `${DESTINATION_URL}?usp=sharing#gid=0`, enabled: false });
  assert.equal(saved.spreadsheet_url, DESTINATION_URL);
  assert.equal(saved.enabled, false);
  assert.equal(saved.configured, false);
  assert.equal(saved.verified, false);
  await assert.rejects(saveSheetExportConfig(f.db, OWNER, f.env, { spreadsheet_url: DESTINATION_URL, enabled: true }), { code: "not_configured" });
  assert.equal((await getSheetExportConfig(f.db, OWNER, f.env)).enabled, false);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("outer Sport API authenticates sheet configuration and ignores supplied owner IDs", async (t) => {
  const f = createSportFixture(t), fetchMock = noNetwork(t);
  t.mock.method(console, "error", () => {});
  const tampered = new URLSearchParams(signedInitData(f.env));
  tampered.set("user", JSON.stringify({ id: Number(OTHER_OWNER) }));
  for (const options of [{ initData: null }, { initData: "unsigned" }, { initData: tampered.toString() }, { ownerId: BLOCKED_OWNER }, { ownerId: UNKNOWN_OWNER }]) {
    await api(f, "/sheet-export", { ...options, method: "PUT", body: { spreadsheet_url: DESTINATION_URL, enabled: false } }, 401);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_sheet_exports").get().n, 0);
  const saved = await api(f, "/sheet-export", { method: "PUT", body: { owner_id: OTHER_OWNER, spreadsheet_url: DESTINATION_URL, enabled: false } });
  assert.equal(saved.sheet_export.spreadsheet_url, DESTINATION_URL);
  assert.equal((await api(f, "?owner_id=810002")).sheet_export.spreadsheet_url, DESTINATION_URL);
  assert.equal((await api(f, "", { ownerId: OTHER_OWNER })).sheet_export.spreadsheet_url, "");
  assert.equal(f.sqlite.prepare("SELECT owner_id FROM sport_sheet_exports").get().owner_id, OWNER);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("the API rejects the protected reference before Google access or configuration changes", async (t) => {
  const f = createSportFixture(t), fetchMock = noNetwork(t);
  serviceAccount(f);
  t.mock.method(console, "error", () => {});
  for (const enabled of [false, true]) {
    await api(f, "/sheet-export", { method: "PUT", body: { spreadsheet_url: sheetUrl(REFERENCE_ID), enabled } }, 400);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_sheet_exports").get().n, 0);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("one destination is never shared by two users, including racing configuration saves", async (t) => {
  const f = createSportFixture(t);
  noNetwork(t);
  const input = { spreadsheet_url: DESTINATION_URL, enabled: false };
  const result = await Promise.allSettled([
    saveSheetExportConfig(f.db, OWNER, f.env, input),
    saveSheetExportConfig(f.db, OTHER_OWNER, f.env, input),
  ]);
  assert.equal(result.filter(entry => entry.status === "fulfilled").length, 1);
  assert.equal(result.filter(entry => entry.status === "rejected").length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_sheet_exports").get().n, 1);
  const owner = f.sqlite.prepare("SELECT owner_id FROM sport_sheet_exports").get().owner_id;
  const deniedOwner = owner === OWNER ? OTHER_OWNER : OWNER;
  assert.equal((await getSheetExportConfig(f.db, deniedOwner, f.env)).spreadsheet_url, "");
  await assert.rejects(saveSheetExportConfig(f.db, deniedOwner, f.env, input));
});

test("ownership verification codes are stable for an owner and destination, and differ for another owner", async (t) => {
  const f = createSportFixture(t), second = createSportFixture(t);
  noNetwork(t);
  const input = { spreadsheet_url: DESTINATION_URL, enabled: false };
  const initial = await saveSheetExportConfig(f.db, OWNER, f.env, input);
  const recreated = await saveSheetExportConfig(second.db, OWNER, second.env, input);
  assert.equal(initial.verification_code, recreated.verification_code);
  await saveSheetExportConfig(f.db, OWNER, f.env, { spreadsheet_url: sheetUrl(OTHER_DESTINATION_ID), enabled: false });
  const restored = await saveSheetExportConfig(f.db, OWNER, f.env, input);
  assert.equal(restored.verification_code, initial.verification_code);
  await saveSheetExportConfig(second.db, OWNER, second.env, { spreadsheet_url: sheetUrl(OTHER_DESTINATION_ID), enabled: false });
  const other = await saveSheetExportConfig(second.db, OTHER_OWNER, second.env, input);
  assert.notEqual(other.verification_code, initial.verification_code);
});

test("enabling requires the owner's verification code in the spreadsheet title, with no verification-cell writes", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState(), google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  const account = serviceAccount(f);
  const input = { spreadsheet_url: DESTINATION_URL, enabled: false };
  const disabled = await saveSheetExportConfig(f.db, OWNER, f.env, input);
  assert.equal(google.calls.length, 0);
  await assert.rejects(saveSheetExportConfig(f.db, OWNER, f.env, { ...input, enabled: true }), error => error.message.includes(disabled.verification_code));
  assert.equal((await getSheetExportConfig(f.db, OWNER, f.env)).enabled, false);
  state.title = `Fictional personal diary ${disabled.verification_code}`;
  const enabled = await saveSheetExportConfig(f.db, OWNER, f.env, { ...input, enabled: true });
  assert.equal(enabled.verified, true);
  assert.equal(enabled.service_email, account.client_email);
  assert.equal(enabled.configured, true);
  assert.ok(google.calls.every(call => call.method === "GET"));
  assert.equal(google.writes.length, 0);
  assert.equal(google.layout.length, 0);
  assert.equal(google.oauth.length, 1);
  assert.equal(google.oauth[0].iss, account.client_email);
  assert.doesNotMatch(JSON.stringify(enabled), /BEGIN PRIVATE KEY|private_key|access_token|fictional-private-key-id/);
});

test("destination validation checks all three exact tab names", async (t) => {
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  const input = { spreadsheet_url: DESTINATION_URL, enabled: false };
  const disabled = await saveSheetExportConfig(f.db, OWNER, f.env, input);
  state.title += ` ${disabled.verification_code}`;
  for (const title of TABS) {
    state.tabs = TABS.filter(tab => tab !== title);
    await assert.rejects(saveSheetExportConfig(f.db, OWNER, f.env, { ...input, enabled: true }), { code: "template" });
  }
  assert.equal((await getSheetExportConfig(f.db, OWNER, f.env)).enabled, false);
  assert.equal(google.writes.length, 0);
  assert.equal(google.layout.length, 0);
});

test("destination validation rejects changed A:J headers before enabling exports", async (t) => {
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  const input = { spreadsheet_url: DESTINATION_URL, enabled: false };
  const disabled = await saveSheetExportConfig(f.db, OWNER, f.env, input);
  state.title += ` ${disabled.verification_code}`;
  state.values[0][8] = "Renamed fictional comment header";
  await assert.rejects(saveSheetExportConfig(f.db, OWNER, f.env, { ...input, enabled: true }), { code: "template" });
  assert.equal((await getSheetExportConfig(f.db, OWNER, f.env)).enabled, false);
  assert.equal(google.writes.length, 0);
});

test("daily export upserts only each owner's diary and meals using RAW A:J serial-date values", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), own = sheetState(), other = sheetState();
  serviceAccount(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, own], [OTHER_DESTINATION_ID, other]]));
  for (const [owner, id, state, weight, marker] of [
    [OWNER, DESTINATION_ID, own, 71.5, "Fictional first owner"],
    [OTHER_OWNER, OTHER_DESTINATION_ID, other, 82.5, "Fictional second owner"],
  ]) {
    seedProfile(f, owner);
    await api(f, `/days/${DAY}`, { method: "PUT", ownerId: owner, body: { weight_kg: weight, water_ml: 1750, nutrition: false, mood: 4, comment: marker, coach_note: "" } });
    await api(f, "/meals", { method: "POST", ownerId: owner, body: {
      id: `fictional-sheets-meal-${owner}`, date: DAY, time: "12:30", title: `${marker} meal`, calories_kcal: 400, protein_g: 20, fat_g: null, carbs_g: null,
    } }, 201);
    await verifiedConfig(f, state, owner, id);
  }
  const before = {
    days: f.sqlite.prepare("SELECT * FROM sport_days ORDER BY owner_id").all(),
    meals: f.sqlite.prepare("SELECT * FROM sport_meals ORDER BY owner_id").all(),
  };
  assert.equal(await runSportSheetExports(cron(), f.env), 2);
  assert.equal(google.writes.length, 2);
  for (const [id, weight, marker, forbidden] of [
    [DESTINATION_ID, 71.5, "Fictional first owner", "Fictional second owner"],
    [OTHER_DESTINATION_ID, 82.5, "Fictional second owner", "Fictional first owner"],
  ]) {
    const write = google.writes.find(entry => entry.id === id);
    assert.equal(write.body.valueInputOption, "RAW");
    assert.equal(write.body.data.length, 1);
    assert.equal(write.body.data[0].range, "'Дневник (Ежедневно)'!A2:J2");
    const row = write.body.data[0].values[0];
    assert.equal(row.length, 10);
    assert.equal(row[0], serialDate(DAY));
    assert.equal(typeof row[0], "number");
    assert.equal(row[1], weight);
    assert.equal(row[3], 1.75);
    assert.equal(row[6], false);
    assert.equal(row[7], "4 - Хорошо");
    assert.ok(row[8].includes(`${marker} meal`));
    assert.ok(!JSON.stringify(write).includes(forbidden));
  }
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM sport_days ORDER BY owner_id").all(), before.days);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM sport_meals ORDER BY owner_id").all(), before.meals);
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(google.writes.length, 2);
});

for (const [name, dateCell] of [["native date serial", serialDate(DAY)], ["ISO legacy date", DAY], ["Russian legacy date", "23.10.2026"]]) {
  test(`date upserts match an existing ${name}, preserve trainer J and retain unrelated rows`, async (t) => {
    freezeTime(t);
    const f = createSportFixture(t);
    serviceAccount(f);
    seedProfile(f);
    const unrelated = [serialDate("2026-10-20"), 80, 8, 2, 1000, "Отдых", true, "3 - Норма", "Fictional historical comment", "Fictional historical trainer note"];
    const state = sheetState({ values: [[...HEADERS], [dateCell, 99, 9, 9, 999, "", "", "", "Old fictional content", "Trainer-owned J must survive"], [...unrelated]] });
    const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
    await api(f, `/days/${DAY}`, { method: "PUT", body: { weight_kg: 71.5, comment: "=SUM(1;2)", coach_note: "" } });
    await verifiedConfig(f, state);
    assert.equal(await runSportSheetExports(cron(), f.env), 1);
    assert.equal(state.values.length, 3);
    assert.equal(state.values[1][0], serialDate(DAY));
    assert.equal(state.values[1][8], "=SUM(1;2)");
    assert.equal(state.values[1][9], "Trainer-owned J must survive");
    assert.deepEqual(state.values[2], unrelated);
    await api(f, `/days/${DAY}`, { method: "PUT", body: { weight_kg: 72, coach_note: "Fictional explicit DB trainer note" } });
    const tomorrow = "2026-10-25T00:15:00.000Z";
    t.mock.timers.setTime(Date.parse(tomorrow));
    assert.equal(await runSportSheetExports(cron(tomorrow), f.env), 1);
    assert.equal(state.values.length, 3);
    assert.equal(state.values[1][1], 72);
    assert.equal(state.values[1][9], "Fictional explicit DB trainer note");
    assert.deepEqual(state.values[2], unrelated);
    for (const write of google.writes) {
      assert.equal(write.body.valueInputOption, "RAW");
      assert.deepEqual(write.body.data.map(entry => entry.range), ["'Дневник (Ежедневно)'!A2:J2"]);
    }
  });
}

test("exports within existing capacity never clear, delete or change existing formatting", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  assert.equal(await runSportSheetExports(cron(), f.env), 1);
  assert.deepEqual(google.layout, [], "values-only export must not call spreadsheets:batchUpdate, including repeatCell");
  assert.ok(google.calls.every(call => call.method === "GET" || call.suffix === "/values:batchUpdate"));
  assert.deepEqual(state.values[0], HEADERS);
});

test("full diary capacity appends rows and copies only template A:J formatting onto newly added rows", async (t) => {
  freezeTime(t);
  const existing = [serialDate("2026-10-22"), 80, 8, 2, 1000, "Отдых", true, "3 - Норма", "Fictional existing row", "Fictional existing trainer note"];
  const f = createSportFixture(t), state = sheetState({ gridRows: 2, values: [[...HEADERS], [...existing]] });
  serviceAccount(f);
  seedProfile(f);
  t.mock.method(console, "error", () => {});
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  assert.equal(await runSportSheetExports(cron(), f.env), 1);
  assert.equal(google.layout.length, 1);
  assert.deepEqual(google.layout[0].body.requests, [
    { appendDimension: { sheetId: 0, dimension: "ROWS", length: 1 } },
    { copyPaste: {
      source: { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 10 },
      destination: { sheetId: 0, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 10 },
      pasteType: "PASTE_FORMAT",
    } },
  ]);
  assert.equal(state.gridRows, 3);
  assert.deepEqual(state.values[1], existing);
  assert.deepEqual(google.writes.flatMap(write => write.body.data.map(entry => entry.range)), ["'Дневник (Ежедневно)'!A3:J3"]);
  assert.equal(state.values[2][0], serialDate(DAY));
});

test("the scheduler runs once per local date starting at 03:15, not UTC midnight", async (t) => {
  freezeTime(t, "2026-10-23T21:29:00Z");
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f, OWNER, "Asia/Kathmandu");
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await verifiedConfig(f, state);
  const reads = google.calls.length;
  assert.equal(await runSportSheetExports(cron("2026-10-23T21:29:00Z"), f.env), 0);
  assert.equal(google.calls.length, reads);
  const due = "2026-10-23T21:30:00Z";
  t.mock.timers.setTime(Date.parse(due));
  assert.equal(await runSportSheetExports(cron(due), f.env), 1);
  assert.equal(f.sqlite.prepare("SELECT last_sync_date FROM sport_sheet_exports WHERE owner_id=?").get(OWNER).last_sync_date, "2026-10-24");
  const after = google.calls.length;
  assert.equal(await runSportSheetExports(cron("2026-10-24T08:00:00Z"), f.env), 0);
  assert.equal(google.calls.length, after);
  assert.equal(google.writes.length, 0, "an empty diary does not overwrite the template");
});

test("concurrent cron runs lease the destination once and record completion only once", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  const result = await Promise.all([runSportSheetExports(cron(), f.env), runSportSheetExports(cron(), f.env)]);
  assert.equal(result.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(google.writes.length, 1);
  const row = f.sqlite.prepare("SELECT * FROM sport_sheet_exports WHERE owner_id=?").get(OWNER);
  assert.equal(row.last_sync_date, "2026-10-24");
  assert.equal(row.lease_token, null);
  assert.equal(row.lease_until, null);
});

test("export revalidates exact headers and tab names before any outbound writes", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f);
  t.mock.method(console, "error", () => {});
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  state.values[0][9] = "Changed trainer header";
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(f.sqlite.prepare("SELECT error_code FROM sport_sheet_exports WHERE owner_id=?").get(OWNER).error_code, "template");
  assert.equal(google.writes.length, 0);
  assert.equal(google.layout.length, 0);
  state.values[0] = [...HEADERS];
  state.tabs = [TABS[0], TABS[2]];
  const later = "2026-10-24T01:15:01Z";
  t.mock.timers.setTime(Date.parse(later));
  assert.equal(await runSportSheetExports(cron(later), f.env), 0);
  assert.equal(google.writes.length, 0);
  assert.equal(google.layout.length, 0);
});

test("a legacy stored reference destination is blocked before OAuth or Sheets requests", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), fetchMock = noNetwork(t);
  serviceAccount(f);
  seedProfile(f);
  t.mock.method(console, "error", () => {});
  f.sqlite.prepare(`INSERT INTO sport_sheet_exports
    (owner_id,spreadsheet_id,enabled,verification_code,verified_at,updated_at) VALUES (?,?,1,'Fictional legacy code',?,?)`)
    .run(OWNER, REFERENCE_ID, NOW, NOW);
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT error_code FROM sport_sheet_exports WHERE owner_id=?").get(OWNER).error_code, "template");
});

test("saving only an export link creates a default profile so a newly enabled user is scheduled", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_profiles WHERE owner_id=?").get(OWNER).n, 0);
  await verifiedConfig(f, state);
  assert.equal(f.sqlite.prepare("SELECT timezone FROM sport_profiles WHERE owner_id=?").get(OWNER).timezone, "Europe/Moscow");
  assert.equal(await runSportSheetExports(cron(), f.env), 1);
  assert.equal((await getSheetExportConfig(f.db, OWNER, f.env)).last_sync_at, NOW);
});

test("goal sync writes only reference B2:B5 and leaves dashboard and unrelated formulas untouched", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState({
    goalCells: { B1: "Fictional heading", B2: 9, B3: 999, B4: 3, B5: 90, B6: "=SUM(B2:B5)" },
    dashboardFormulas: { A1: "=COUNT('Дневник (Ежедневно)'!A:A)", A2: "=AVERAGEIFS('Дневник (Ежедневно)'!B:B;'Дневник (Ежедневно)'!A:A;A3)" },
  });
  const formulas = structuredClone(state.dashboardFormulas);
  serviceAccount(f);
  seedProfile(f, OWNER, "Europe/Moscow", { sleep_hours: 7.5, steps: 8500, water_ml: 1750, weight_kg: 71.5, calories_kcal: 2000, protein_g: 100 });
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  assert.equal(await runSportSheetExports(cron(), f.env), 1);
  assert.deepEqual(google.writes.flatMap(write => write.body.data.map(entry => entry.range)), [
    "'Дневник (Ежедневно)'!A2:J2", "'Справочник и Цели'!B2", "'Справочник и Цели'!B3", "'Справочник и Цели'!B4", "'Справочник и Цели'!B5",
  ]);
  assert.deepEqual(state.goalCells, { B1: "Fictional heading", B2: 7.5, B3: 8500, B4: 1.75, B5: 71.5, B6: "=SUM(B2:B5)" });
  assert.deepEqual(state.dashboardFormulas, formulas);
  assert.deepEqual(google.layout, []);
  assert.ok(google.writes.every(write => write.body.valueInputOption === "RAW"));
});

test("switching destination while an export is reading cancels its stale lease before all writes", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  t.mock.method(console, "error", () => {});
  await api(f, `/days/${DAY}`, { method: "PUT", body: { steps: 8500 } });
  await verifiedConfig(f, state);
  state.onValuesRead = async () => {
    await saveSheetExportConfig(f.db, OWNER, f.env, { spreadsheet_url: sheetUrl(OTHER_DESTINATION_ID), enabled: false });
  };
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(google.writes.length, 0);
  assert.equal(google.layout.length, 0);
  const config = f.sqlite.prepare("SELECT * FROM sport_sheet_exports WHERE owner_id=?").get(OWNER);
  assert.equal(config.spreadsheet_id, OTHER_DESTINATION_ID);
  assert.equal(config.enabled, 0);
  assert.equal(config.verified_at, null);
  assert.equal(config.lease_token, null);
  assert.equal(config.lease_until, null);
  assert.equal(config.last_sync_at, null);
});

for (const [name, count, dense] of [["300-row cap", 350, false], ["UTF-8 byte cap", 220, true]]) {
  test(`export batches obey the 1.5 MB and 300-row limits: ${name}`, async (t) => {
    freezeTime(t);
    const f = createSportFixture(t), state = sheetState({ gridRows: count + 1 });
    serviceAccount(f);
    seedProfile(f);
    const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
    seedManyDays(f, count, { dense });
    await verifiedConfig(f, state);
    assert.equal(await runSportSheetExports(cron(), f.env), 1);
    assert.ok(google.writes.length >= 2);
    assert.equal(google.writes.reduce((total, write) => total + write.body.data.length, 0), count);
    for (const write of google.writes) {
      assert.equal(write.body.valueInputOption, "RAW");
      assert.ok(write.body.data.length <= 300);
      assert.ok(new TextEncoder().encode(JSON.stringify(write.body)).byteLength <= 1500000);
      assert.ok(write.body.data.every(entry => entry.values[0].length === 10 && typeof entry.values[0][0] === "number"));
    }
    assert.equal(state.values.length, count + 1);
    assert.equal(google.layout.length, 0);
    if (dense) {
      assert.equal(state.values[1][8], "Я".repeat(2000));
      assert.equal(state.values[1][9], "Ж".repeat(2000));
    }
  });
}

test("disabling an export between batches prevents remaining writes and a false completion", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState({ gridRows: 351 });
  serviceAccount(f);
  seedProfile(f);
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  t.mock.method(console, "error", () => {});
  seedManyDays(f, 350);
  await verifiedConfig(f, state);
  state.onWrite = async () => {
    await saveSheetExportConfig(f.db, OWNER, f.env, { spreadsheet_url: DESTINATION_URL, enabled: false });
  };
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(google.writes.length, 1);
  assert.equal(google.writes[0].body.data.length, 300);
  const config = f.sqlite.prepare("SELECT * FROM sport_sheet_exports WHERE owner_id=?").get(OWNER);
  assert.equal(config.enabled, 0);
  assert.equal(config.lease_token, null);
  assert.equal(config.last_sync_at, null);
  assert.equal(config.last_sync_date, null);
});

test("failed Google exports consume at most five attempts per cron run and never log credentials or response bodies", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), destinations = new Map();
  const account = serviceAccount(f);
  const logged = t.mock.method(console, "error", () => {});
  for (let index = 0; index < 7; index++) {
    const owner = String(810010 + index), id = `fictional_failure_destination_${owner}`;
    f.sqlite.prepare("INSERT INTO assistant_users (id,telegram_user_id,status,created_at,updated_at) VALUES (?,?,'active',?,?)")
      .run(`fictional-failed-export-${index}`, owner, NOW, NOW);
    seedProfile(f, owner);
    f.sqlite.prepare(`INSERT INTO sport_sheet_exports
      (owner_id,spreadsheet_id,enabled,verification_code,verified_at,updated_at) VALUES (?,?,1,'Fictional verified code',?,?)`)
      .run(owner, id, NOW, NOW);
    destinations.set(id, sheetState({ status: 403 }));
  }
  const google = mockGoogle(t, destinations);
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  assert.equal(google.calls.length, 5);
  assert.equal(google.writes.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_sheet_exports WHERE last_attempt_at IS NOT NULL").get().n, 5);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sport_sheet_exports WHERE error_code='google_access'").get().n, 5);
  const logs = JSON.stringify(logged.mock.calls.map(call => call.arguments));
  assert.doesNotMatch(logs, /PRIVATE KEY|fictional-sheets-access-token|fictional Google error body|private_key/);
  assert.ok(!logs.includes(account.private_key));
});

test("failed exports back off for an hour, then can retry without disabling the config", async (t) => {
  freezeTime(t);
  const f = createSportFixture(t), state = sheetState();
  serviceAccount(f);
  seedProfile(f);
  t.mock.method(console, "error", () => {});
  const google = mockGoogle(t, new Map([[DESTINATION_ID, state]]));
  await verifiedConfig(f, state);
  state.status = 403;
  assert.equal(await runSportSheetExports(cron(), f.env), 0);
  const requests = google.calls.length;
  assert.equal(await runSportSheetExports(cron("2026-10-24T00:45:00Z"), f.env), 0);
  assert.equal(google.calls.length, requests);
  delete state.status;
  const retry = "2026-10-24T01:15:01Z";
  t.mock.timers.setTime(Date.parse(retry));
  assert.equal(await runSportSheetExports(cron(retry), f.env), 1);
  const row = f.sqlite.prepare("SELECT * FROM sport_sheet_exports WHERE owner_id=?").get(OWNER);
  assert.equal(row.error_code, null);
  assert.equal(row.enabled, 1);
  assert.equal(row.last_sync_date, "2026-10-24");
});
