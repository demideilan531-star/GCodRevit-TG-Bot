import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { createContext, Script, runInContext, runInNewContext } from "node:vm";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../cloudflare-worker/public/sport/${path}`, import.meta.url), "utf8");
const html = read("index.html");
const js = read("sport.js");
const css = read("sport.css");
const vendor = read("vendor/lucide-0.468.0.min.js");

test("Sport script parses and all literal DOM references exist", () => {
  assert.doesNotThrow(() => new Script(js));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "Duplicate HTML ids");
  for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), `Missing id: ${id}`);
  for (const view of ["today", "calendar", "progress", "settings"]) assert.ok(ids.includes(`${view}View`));
});

test("Lucide is pinned, local, attributed, and contains all used icons", () => {
  assert.match(html, /src="\.\/vendor\/lucide-0\.468\.0\.min\.js"/);
  assert.doesNotMatch(html, /https:\/\/(?:cdn|unpkg)/);
  assert.match(vendor, /@license lucide v0\.468\.0 - ISC/);
  assert.match(read("vendor/lucide-LICENSE.txt"), /Lucide Contributors/);
  assert.match(read("vendor/README.txt"), /lucide@0\.468\.0/);
  assert.equal(createHash("sha256").update(vendor).digest("hex"), "3411692820cb8d47543f69496aa25fd603a358f4498046f41c508a5a3342210e");
  const context = {};
  runInNewContext(vendor, context);
  const names = [...html.matchAll(/data-lucide="([^"]+)"/g), ...js.matchAll(/icon\("([^"]+)"\)/g)];
  for (const [, name] of names) {
    const key = name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
    assert.ok(context.lucide.icons[key], `Missing icon: ${name}`);
  }
});

test("numeric limits match the sport API and use numeric keyboards", () => {
  const limits = { weight_kg: [20, 400], sleep_hours: [0, 24], water_ml: [0, 20000], steps: [0, 150000], calories_kcal: [0, 10000], protein_g: [0, 1000], fat_g: [0, 1000], carbs_g: [0, 2000] };
  const inputs = [...html.matchAll(/<input\b[^>]*type="number"[^>]*>/g)];
  assert.equal(inputs.length, 16);
  for (const [tag] of inputs) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    assert.deepEqual([Number(attrs.min), Number(attrs.max)], limits[attrs.name], attrs.name);
    assert.ok(["decimal", "numeric"].includes(attrs.inputmode));
    assert.doesNotMatch(tag, /\brequired\b/, "Measurements must remain optional");
  }
});

test("mood is nullable numeric 1-5 and day saves contain only touched fields", () => {
  assert.match(js, /const dayNumbers = \[[^\]]*"mood"[^\]]*\]/);
  assert.doesNotMatch(js, /const dayTexts = \[[^\]]*"mood"/);
  const mood = html.match(/<select name="mood">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(mood);
  assert.deepEqual([...mood.matchAll(/value="([^"]*)"/g)].map((match) => match[1]), ["", "1", "2", "3", "4", "5"]);
  assert.match(js, /if \(dayNumbers\.includes\(name\)\) return numeric\(value\)/);
  assert.match(js, /\[\.\.\.state\.dayTouched\]\.map/);
  assert.match(js, /mood: i % 3 === 0 \? 4 : null/);
});

test("reminder kinds, limits, duplicate slots, and disabled defaults are present", () => {
  const labels = js.match(/const reminderLabels = \{([^\n]+)\}/)?.[1];
  for (const kind of ["sleep", "meal", "evening", "water", "steps"]) assert.match(labels, new RegExp(`\\b${kind}:`));
  assert.match(js, /body\.reminders\.length > 16/);
  assert.match(js, /new Set\(slots\)\.size !== slots\.length/);
  assert.match(js, /timeZone: body\.timezone/);
  const defaults = js.match(/function defaultReminders\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.equal((defaults.match(/enabled: false/g) || []).length, 5);
});

test("privacy boundaries and data completeness remain explicit", () => {
  assert.doesNotMatch(html, /type="file"/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|openLink\(/);
  assert.match(js, /Authorization: `tma \$\{initData\}`/);
  assert.match(js, /if \(demoMode\) return demoRequest/);
  assert.match(js, /if \(!initData\) throw new Error/);
  assert.match(js, /URL\.createObjectURL\(blob\)/);
  assert.match(js, /function chartPartial/);
  assert.match(js, /function periodSummary/);
  assert.match(js, /function drawChart/);
  assert.match(js, /observed\}.*meals\.length\} приёмов/);
  assert.doesNotMatch(js, /пунктир/);
  assert.doesNotMatch(css, /font-size:\s*[^;]*vw/);
});

const destinationId = "fictional_destination_00000001";
const destinationUrl = `https://docs.google.com/spreadsheets/d/${destinationId}/edit`;
const referenceUrl = "https://docs.google.com/spreadsheets/d/1apTYgJfkNRU_Cs_w9p0VtXaA41fM1N0cROG2fhoTjtk/edit";
const plain = (value) => JSON.parse(JSON.stringify(value));

function sheetFixture({ demo = false, search = "", initData = "fictional-signed-init-data", fetcher = () => { throw new Error("Unexpected fetch"); } } = {}) {
  const elements = new Map();
  function element(tag = "div") {
    const controls = new Map();
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), value: "", checked: false, disabled: false, hidden: false,
      textContent: "", className: "", dataset: {}, style: {}, listeners: {}, children: [], parent: null,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
      reportValidity: () => true,
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      add(option) { this.append(option); },
      replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
      querySelectorAll(selector) {
        const matches = child => selector.startsWith(".") ? child.className.split(/\s+/).includes(selector.slice(1))
          : child.name === selector.match(/^\[name="([^"]+)"\]$/)?.[1];
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      elements: { namedItem(name) { if (!controls.has(name)) controls.set(name, element("input")); return controls.get(name); } },
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  function Option(text, value) {
    const result = element("option");
    result.textContent = text;
    result.value = value;
    return result;
  }
  const timeouts = new Set();
  function timer(...args) {
    const timeout = setTimeout(...args);
    timeouts.add(timeout);
    return timeout;
  }
  function cancelTimer(timeout) {
    clearTimeout(timeout);
    timeouts.delete(timeout);
  }
  function dispose() {
    for (const timeout of timeouts) clearTimeout(timeout);
    timeouts.clear();
  }
  const windowEvents = {};
  const window = { Telegram: { WebApp: { initData } }, confirm: () => false, addEventListener: (name, handler) => { windowEvents[name] = handler; } };
  const context = createContext({
    window, document: { getElementById: get, createElement: element, querySelectorAll: () => [] },
    location: { search: demo ? "?demo=1" : search, origin: "https://fictional.test" }, Option,
    Intl, URL, URLSearchParams, Blob, AbortController, TextEncoder, crypto: webcrypto,
    setTimeout: timer, clearTimeout: cancelTimer, structuredClone, fetch: fetcher,
  });
  const source = js.replace(/\r?\nstart\(\);\s*$/, "\n");
  assert.notEqual(source, js, "Test harness must omit browser startup");
  runInContext(source, context);
  const api = runInContext("({ state, api, emptySheetExport, sheetDestination, loadRange, renderSheetExport, renderSheetExportDetails, markSheetExportChanged, saveSheetExport, renderSettings, saveSettings, refresh, bindEvents, defaultReminders, nextReminderTime, renderReminder, settingsPayload, markSettingsChanged, boot })", context);
  return { ...api, get, windowEvents, dispose, evaluate: source => runInContext(source, context) };
}

test("reminder defaults are five disabled notifications with independent breakfast, lunch and dinner", () => {
  const fixture = sheetFixture();
  assert.deepEqual(plain(fixture.defaultReminders()).map(({ label, ...row }) => row), [
    { kind: "sleep", mode: "notification", time: "09:00", enabled: false },
    { kind: "meal", mode: "notification", time: "08:00", enabled: false },
    { kind: "meal", mode: "notification", time: "13:00", enabled: false },
    { kind: "meal", mode: "notification", time: "19:00", enabled: false },
    { kind: "evening", mode: "notification", time: "21:00", enabled: false },
  ]);
  fixture.renderSettings(true);
  assert.deepEqual(plain(fixture.settingsPayload()).reminders, plain(fixture.defaultReminders()));
  assert.equal(fixture.state.settingsDirty, false);
  assert.equal(fixture.get("saveSettings").disabled, true);
  const button = html.match(/<button\b[^>]*id="addReminder"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(button, /data-lucide="plus"/);
  assert.match(button, /<\/i>\s*Добавить/);
});

test("reminder mode selects round-trip IDs and both modes through a signed settings save", async () => {
  let sent;
  const fixture = sheetFixture({ fetcher: async (path, options) => {
    assert.equal(path, "/api/sport/settings");
    assert.equal(options.headers.Authorization, "tma fictional-signed-init-data");
    sent = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ profile: { timezone: sent.timezone, goals: sent.goals }, reminders: sent.reminders }) };
  } });
  fixture.state.reminders = [
    { id: "fictional-lunch", kind: "meal", mode: "notification", time: "13:00", label: "Fictional lunch", enabled: true },
    { id: "fictional-dinner", kind: "meal", mode: "question", time: "19:00", label: "Fictional dinner", enabled: false },
  ];
  fixture.renderSettings();
  const rows = fixture.get("reminderList").querySelectorAll(".reminder");
  for (const row of rows) {
    assert.deepEqual(row.querySelector('[name="mode"]').children.map(({ value, textContent }) => [value, textContent]), [
      ["notification", "Открыть дневник"], ["question", "Ответить в чате"],
    ]);
  }
  assert.deepEqual(plain(fixture.settingsPayload()).reminders, fixture.state.reminders);
  rows[0].querySelector('[name="mode"]').value = "question";
  rows[1].querySelector('[name="mode"]').value = "notification";
  fixture.markSettingsChanged();
  const expected = plain(fixture.settingsPayload());
  await fixture.saveSettings({ preventDefault() {} });
  assert.deepEqual(sent, expected);
  assert.deepEqual(plain(fixture.state.reminders), expected.reminders);
  assert.equal(fixture.state.settingsDirty, false);
  assert.equal(fixture.get("settingsSaveStatus").dataset.state, "saved", fixture.get("settingsSaveStatus").textContent);
  fixture.renderReminder({ kind: "meal", time: "20:00", enabled: false });
  assert.equal(fixture.get("reminderList").querySelectorAll(".reminder").at(-1).querySelector('[name="mode"]').value, "notification");
});

test("Add creates enabled notification drafts up to sixteen unique slots without autosaving", async (t) => {
  const calls = [];
  const fixture = sheetFixture({ fetcher: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    const body = calls.at(-1).body;
    return { ok: true, status: 200, json: async () => ({ profile: { timezone: body.timezone, goals: body.goals }, reminders: body.reminders }) };
  } });
  t.after(fixture.dispose);
  fixture.renderSettings(true);
  fixture.bindEvents();
  const add = fixture.get("addReminder").listeners.click;
  for (let count = 5; count < 16; count++) {
    add();
    const reminders = plain(fixture.settingsPayload()).reminders;
    assert.equal(reminders.length, count + 1);
    assert.equal(new Set(reminders.map(row => `${row.kind}:${row.time}`)).size, reminders.length);
    assert.deepEqual({ kind: reminders.at(-1).kind, mode: reminders.at(-1).mode, enabled: reminders.at(-1).enabled }, {
      kind: "meal", mode: "notification", enabled: true,
    });
    assert.match(reminders.at(-1).time, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
    assert.equal(calls.length, 0);
  }
  add();
  assert.equal(plain(fixture.settingsPayload()).reminders.length, 16);
  assert.equal(fixture.state.settingsDirty, true);
  assert.equal(calls.length, 0);
  await fixture.saveSettings({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.reminders.length, 16);
  assert.equal(fixture.get("settingsSaveStatus").dataset.state, "saved", fixture.get("settingsSaveStatus").textContent);
});

test("sixteen newly added meal reminders never reuse the old fallback time", (t) => {
  const fixture = sheetFixture();
  t.after(fixture.dispose);
  fixture.renderSettings();
  fixture.bindEvents();
  for (let count = 0; count < 16; count++) fixture.get("addReminder").listeners.click();
  const reminders = plain(fixture.settingsPayload()).reminders;
  assert.equal(reminders.length, 16);
  assert.equal(new Set(reminders.map(row => row.time)).size, 16);
  assert.ok(reminders.every(row => row.kind === "meal" && row.mode === "notification" && row.enabled));
});

for (const requested of ["2024-02-29", "2026-09-30", "2026-02-29", "2026-13-01", "2026-10-3", "not-a-date", ""]) {
  test(`boot selects only a real date after signed metadata succeeds: ${requested || "absent"}`, async () => {
    const calls = [];
    let releaseMetadata;
    const gate = new Promise(resolve => { releaseMetadata = resolve; });
    const fixture = sheetFixture({ search: `?date=${encodeURIComponent(requested)}`, fetcher: async (path, options) => {
      calls.push({ path, options });
      if (calls.length === 1) await gate;
      return { ok: true, status: 200, json: async () => ({
        days: [], meals: [], today: "2026-10-25", profile: { timezone: "Europe/Moscow", goals: {} }, reminders: [],
      }) };
    } });
    // Rendering the diary is covered separately; keep real auth, loading, settings and boot logic here.
    fixture.evaluate("renderDay = () => {};");
    fixture.state.today = "2026-10-25";
    fixture.state.selected = "2026-10-25";
    const pending = fixture.boot();
    assert.equal(calls.length, 1);
    assert.equal(fixture.state.selected, "2026-10-25");
    assert.equal(fixture.get("mainContent").hidden, true);
    releaseMetadata();
    await pending;
    const expected = ["2024-02-29", "2026-09-30"].includes(requested) ? requested : "2026-10-25";
    assert.equal(fixture.state.selected, expected);
    assert.equal(fixture.state.month, expected.slice(0, 7));
    assert.equal(fixture.get("mainContent").hidden, false);
    assert.equal(fixture.get("accessError").hidden, true);
    assert.ok(calls.every(({ options }) => options.headers.Authorization === "tma fictional-signed-init-data"));
    assert.equal(new URL(calls.at(-1).path, "https://fictional.test").searchParams.get("from"), expected);
  });
}

test("date query never bypasses missing or rejected Telegram authorization", async () => {
  for (const initData of ["", "fictional-rejected-init-data"]) {
    const calls = [];
    const fixture = sheetFixture({ search: "?date=2024-02-29", initData, fetcher: async (path) => {
      calls.push(path);
      return { ok: false, status: 403, json: async () => ({ error: "Fictional denied access" }) };
    } });
    const selected = fixture.state.selected;
    await fixture.boot();
    assert.equal(calls.length, initData ? 1 : 0);
    assert.equal(fixture.state.selected, selected);
    assert.equal(fixture.get("mainContent").hidden, true);
    assert.equal(fixture.get("bottomNav").hidden, true);
    assert.equal(fixture.get("accessError").hidden, false);
    assert.equal(fixture.state.loaded.size, 0);
  }
});

test("Google Sheets uses a separate form and a read-only verification code", () => {
  const personal = html.match(/<form id="settingsForm">[\s\S]*?<\/form>/)?.[0];
  const sheet = html.match(/<form id="sheetExportForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(personal && sheet);
  assert.ok(html.indexOf(sheet) > html.indexOf(personal) + personal.length);
  assert.doesNotMatch(personal, /spreadsheet_url|sheetExport/);
  assert.doesNotMatch(sheet, /name="(?:timezone|weight_kg|kind|time)"/);
  assert.match(sheet, /id="sheetExportUrl"[^>]*type="url"[^>]*required/);
  assert.match(sheet, /id="sheetExportEnabled"[^>]*type="checkbox"/);
  assert.match(sheet, /id="sheetVerificationCode"[^>]*readonly/);
  assert.match(css, /\.sheet-service-email\s*\{[^}]*user-select: text/);
});

test("sheet URLs follow the backend format and reject the protected reference", () => {
  const fixture = sheetFixture();
  assert.equal(fixture.sheetDestination(destinationUrl), destinationId);
  assert.equal(fixture.sheetDestination(`${destinationUrl}?usp=sharing#gid=42`), destinationId);
  for (const value of ["", "not a URL", `http://docs.google.com/spreadsheets/d/${destinationId}/edit`, `https://docs.google.com.evil.test/spreadsheets/d/${destinationId}/edit`, `https://user@docs.google.com/spreadsheets/d/${destinationId}/edit`, "https://docs.google.com/spreadsheets/d/short/edit"]) {
    assert.throws(() => fixture.sheetDestination(value));
  }
  assert.throws(() => fixture.sheetDestination(referenceUrl), /защищён/);
});

test("GET metadata loads sheet export without changing its configuration", async () => {
  const fixture = sheetFixture({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({
    days: [], meals: [], today: "2026-10-24", reminders: [], training_types: ["rest", "strength"],
    profile: { timezone: "Europe/Moscow", goals: {} },
    sheet_export: { ...fixture.emptySheetExport(), spreadsheet_url: destinationUrl, verification_code: "GCOD-FICTIONAL" },
  }) }) });
  await fixture.loadRange("2026-10-24", "2026-10-24", { metadata: true });
  fixture.renderSheetExport();
  assert.equal(fixture.get("sheetExportUrl").value, destinationUrl);
  assert.equal(fixture.get("sheetExportEnabled").checked, false);
  assert.equal(fixture.get("sheetExportState").textContent, "Google не подключён");
  assert.equal(fixture.get("sheetExportSchedule").textContent, "Не запланировано");
  assert.equal(fixture.get("sheetVerificationCode").value, "GCOD-FICTIONAL");
  assert.equal(fixture.get("sheetVerificationRow").hidden, false);
});

test("demo can save a disabled URL but never pretends that Google is configured", async () => {
  const fixture = sheetFixture({ demo: true });
  const put = (body) => fixture.api("/sheet-export", { method: "PUT", body: JSON.stringify(body) });
  const first = (await put({ spreadsheet_url: destinationUrl, enabled: false })).sheet_export;
  const repeated = (await put({ spreadsheet_url: `${destinationUrl}?usp=sharing`, enabled: false })).sheet_export;
  assert.equal(first.configured, false);
  assert.equal(first.enabled, false);
  assert.equal(first.verified, false);
  assert.equal(first.status, "not_configured");
  assert.equal(first.last_sync_at, null);
  assert.match(first.verification_code, /^GCOD-DEMO-/);
  assert.equal(first.verification_code, repeated.verification_code);
  await assert.rejects(put({ spreadsheet_url: destinationUrl, enabled: true }), /Google не подключён/);
  await assert.rejects(put({ spreadsheet_url: referenceUrl, enabled: false }), /защищён/);
  const current = (await fixture.api("?from=2026-10-24&to=2026-10-24")).sheet_export;
  assert.deepEqual(plain(current), plain(repeated));
});

test("sheet save sends only URL and enabled and preserves personal drafts", async () => {
  const calls = [];
  const fixture = sheetFixture({ fetcher: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, status: 200, json: async () => ({ sheet_export: { ...fixture.emptySheetExport(), spreadsheet_url: destinationUrl, verification_code: "GCOD-FICTIONAL" } }) };
  } });
  fixture.state.settingsDirty = true;
  fixture.state.dayTouched.add("water_ml");
  fixture.get("timezone").value = "Asia/Yekaterinburg";
  fixture.get("sheetExportUrl").value = ` ${destinationUrl}?usp=sharing `;
  fixture.markSheetExportChanged();
  assert.equal(calls.length, 0, "No autosave on edit");
  await fixture.saveSheetExport({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/sport/sheet-export");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.headers.Authorization, "tma fictional-signed-init-data");
  assert.deepEqual(JSON.parse(calls[0].options.body), { spreadsheet_url: `${destinationUrl}?usp=sharing`, enabled: false });
  assert.equal(fixture.state.settingsDirty, true);
  assert.ok(fixture.state.dayTouched.has("water_ml"));
  assert.equal(fixture.get("timezone").value, "Asia/Yekaterinburg");
  assert.equal(fixture.state.sheetExportDirty, false);
  assert.equal(fixture.get("sheetExportSaveStatus").dataset.state, "saved");
  assert.equal(fixture.get("sheetExportState").textContent, "Google не подключён");
  assert.equal(fixture.get("sheetExportLastSync").textContent, "Ещё не было");
});

test("sheet errors retain URL and toggle without a false saved indicator", async () => {
  const fixture = sheetFixture({ fetcher: async () => ({ ok: false, status: 400, json: async () => ({ error: "Служебный доступ Google ещё не настроен." }) }) });
  fixture.get("sheetExportUrl").value = destinationUrl;
  fixture.get("sheetExportEnabled").checked = true;
  fixture.markSheetExportChanged();
  await fixture.saveSheetExport({ preventDefault() {} });
  assert.equal(fixture.get("sheetExportUrl").value, destinationUrl);
  assert.equal(fixture.get("sheetExportEnabled").checked, true);
  assert.equal(fixture.state.sheetExportDirty, true);
  assert.equal(fixture.state.sheetExport.enabled, false);
  assert.equal(fixture.get("sheetExportSaveStatus").dataset.state, "error");
  assert.match(fixture.get("sheetExportSaveStatus").textContent, /не настроен/);
  assert.equal(fixture.get("sheetExportFields").disabled, false);
  assert.equal(fixture.get("saveSheetExport").disabled, false);
});

test("malformed or unverified enable confirmations do not discard the form", async () => {
  for (const result of [{}, { sheet_export: { spreadsheet_url: destinationUrl, enabled: true, configured: false, verified: false, status: "ready" } }, { sheet_export: { spreadsheet_url: destinationUrl, enabled: true, configured: true, verified: false, status: "ready" } }]) {
    const fixture = sheetFixture({ fetcher: async () => ({ ok: true, status: 200, json: async () => result }) });
    fixture.get("sheetExportUrl").value = destinationUrl;
    fixture.get("sheetExportEnabled").checked = true;
    fixture.markSheetExportChanged();
    await fixture.saveSheetExport({ preventDefault() {} });
    assert.equal(fixture.state.sheetExportDirty, true);
    assert.equal(fixture.get("sheetExportUrl").value, destinationUrl);
    assert.equal(fixture.get("sheetExportSaveStatus").dataset.state, "error");
  }
});

test("a pending sheet save cannot be submitted twice", async () => {
  let resolveFetch;
  let calls = 0;
  const fixture = sheetFixture({ fetcher: () => { calls++; return new Promise((resolve) => { resolveFetch = resolve; }); } });
  fixture.get("sheetExportUrl").value = destinationUrl;
  fixture.markSheetExportChanged();
  const pending = fixture.saveSheetExport({ preventDefault() {} });
  assert.equal(fixture.state.sheetExportBusy, true);
  assert.equal(fixture.get("sheetExportFields").disabled, true);
  await fixture.saveSheetExport({ preventDefault() {} });
  assert.equal(calls, 1);
  resolveFetch({ ok: true, status: 200, json: async () => ({ sheet_export: { ...fixture.emptySheetExport(), spreadsheet_url: destinationUrl } }) });
  await pending;
  assert.equal(fixture.state.sheetExportBusy, false);
  assert.equal(fixture.get("sheetExportFields").disabled, false);
});

test("verification and last sync are rendered from the server, in the saved timezone", () => {
  const fixture = sheetFixture();
  fixture.state.profile.timezone = "Europe/Moscow";
  fixture.state.sheetExport = { ...fixture.emptySheetExport(), spreadsheet_url: destinationUrl, configured: true, verification_code: "GCOD-FICTIONAL", service_email: "fictional@example.test", status: "disabled" };
  fixture.renderSheetExportDetails();
  assert.equal(fixture.get("sheetExportState").textContent, "Подтверждение доступа");
  assert.equal(fixture.get("sheetExportSchedule").textContent, "Не запланировано");
  assert.equal(fixture.get("sheetServiceEmail").textContent, "fictional@example.test");
  assert.equal(fixture.get("sheetServiceRow").hidden, false);
  fixture.state.sheetExport = { ...fixture.state.sheetExport, verified: true, enabled: true, status: "ready", last_sync_at: "2026-10-24T00:15:00Z" };
  fixture.renderSheetExportDetails();
  assert.equal(fixture.get("sheetVerificationRow").hidden, true);
  assert.equal(fixture.get("sheetVerificationCode").value, "");
  assert.match(fixture.get("sheetExportSchedule").textContent, /03:15.*Europe\/Moscow/);
  assert.match(fixture.get("sheetExportLastSync").textContent, /03:15/);
  fixture.state.sheetExport.error = "<fictional error>";
  fixture.state.sheetExport.status = "error";
  fixture.renderSheetExportDetails();
  assert.equal(fixture.get("sheetExportError").textContent, "<fictional error>");
  assert.equal(fixture.get("sheetExportState").dataset.state, "error");
});

test("personal settings save and refresh cancellation preserve a sheet draft", async () => {
  const fixture = sheetFixture({ fetcher: async (path, options) => {
    assert.equal(path, "/api/sport/settings");
    assert.equal("spreadsheet_url" in JSON.parse(options.body), false);
    return { ok: true, status: 200, json: async () => ({ profile: { timezone: "Europe/Moscow", goals: {} }, reminders: [] }) };
  } });
  fixture.get("sheetExportUrl").value = destinationUrl;
  fixture.markSheetExportChanged();
  fixture.renderSettings();
  assert.equal(fixture.get("sheetExportUrl").value, destinationUrl);
  assert.equal(fixture.state.sheetExportDirty, true);
  fixture.get("timezone").value = "Europe/Moscow";
  fixture.state.settingsDirty = true;
  await fixture.saveSettings({ preventDefault() {} });
  assert.equal(fixture.state.settingsDirty, false);
  assert.equal(fixture.state.sheetExportDirty, true);
  assert.equal(fixture.get("sheetExportUrl").value, destinationUrl);
  await fixture.refresh();
  assert.equal(fixture.state.sheetExportDirty, true);
  assert.equal(fixture.state.navigationBusy, false);
  fixture.bindEvents();
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  fixture.windowEvents.beforeunload(event);
  assert.equal(event.prevented, true);
});
