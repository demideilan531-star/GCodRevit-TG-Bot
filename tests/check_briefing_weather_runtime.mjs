import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../cloudflare-worker/package.json", import.meta.url));
const { Miniflare } = require(require.resolve("miniflare", { paths: [require.resolve("wrangler")] }));
const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(process.argv[2], "utf8");
const runtime = new Miniflare({
  modules: [
    {
      type: "ESModule", path: resolve(root, "weather-check-entry.js"),
      contents: `import { readYandexParagraphs, parseBriefingWeather } from './briefing-weather.js';
        export default { async fetch(request, env) {
          const paragraphs = await readYandexParagraphs(new Response(env.HTML));
          return Response.json(parseBriefingWeather(paragraphs));
        } };`,
    },
    {
      type: "ESModule", path: resolve(root, "briefing-weather.js"),
      contents: readFileSync(new URL("../cloudflare-worker/src/briefing-weather.js", import.meta.url), "utf8"),
    },
  ],
  compatibilityDate: "2025-07-30",
  bindings: { HTML: html },
  cf: false,
});
try {
  const response = await runtime.dispatchFetch("https://example.com/");
  assert.equal(response.status, 200);
  const weather = await response.json();
  assert.ok(Number.isFinite(weather.temperature));
  assert.ok(weather.periods.length >= 2);
  console.log("Native HTMLRewriter parsed Yandex Weather:", JSON.stringify(weather));
} finally {
  await runtime.dispose();
}
