import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Script, runInNewContext } from "node:vm";
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
  assert.equal((defaults.match(/enabled: false/g) || []).length, 3);
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
