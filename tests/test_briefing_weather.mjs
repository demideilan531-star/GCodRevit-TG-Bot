import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBriefingWeatherSection,
  loadBriefingWeather,
  parseBriefingWeather,
  YANDEX_WEATHER_URL,
} from "../cloudflare-worker/src/briefing-weather.js";
import { buildMorningBriefing } from "../cloudflare-worker/src/morning-briefing.js";

const NOW = new Date("2026-10-15T06:00:00Z");
const PARAGRAPHS = [
  "Тверской район, погода сейчас: Пасмурно.\u200c Сегодня осадков не ожидается, Температура воздуха +9°, ощущается как +7°. Скорость ветра 1,4 м/с, северо-западный. Давление 753 мм рт. ст.. Влажность 88%.",
  "Сегодня, 15 октября: утром температура воздуха +8°, ощущается как +5°, небольшой дождь, скорость ветра 2,9 м/с, северо-западный днём +9°, ощущается как +7°, пасмурно, скорость ветра 1,8 м/с, северо-западный вечером +9°, ощущается как +7°, пасмурно, скорость ветра 1,2 м/с ночью +9°, ощущается как +7°, пасмурно, скорость ветра 2 м/с",
];
const WEATHER = parseBriefingWeather(PARAGRAPHS);

test("current Yandex text yields actual and forecast temperatures without feels-like contamination", () => {
  assert.equal(WEATHER.temperature, 9);
  assert.equal(WEATHER.feelsLike, 7);
  assert.equal(WEATHER.windSpeed, 1.4);
  assert.equal(WEATHER.low, 8);
  assert.equal(WEATHER.high, 9);
  assert.equal(WEATHER.periods.length, 4);
  assert.equal(WEATHER.periods[0].condition, "небольшой дождь");
});

test("minus temperatures, numeric degree entities and legacy today headers are understood", () => {
  const paragraphs = PARAGRAPHS.map((text) => text
    .replaceAll("+9", "−2").replaceAll("+8", "−4").replaceAll("+7", "−6")
    .replaceAll("°", "&#176;").replace("Сегодня, 15 октября:", "Прогноз погоды на сегодня:"));
  const weather = parseBriefingWeather(paragraphs);
  assert.equal(weather.temperature, -2);
  assert.equal(weather.low, -4);
  assert.equal(weather.high, -2);
});

test("captcha pages and tomorrow-only forecasts cannot become today's weather", () => {
  assert.throws(() => parseBriefingWeather(["Подтвердите, что вы не робот"]));
  assert.throws(() => parseBriefingWeather([PARAGRAPHS[0], PARAGRAPHS[1].replace("Сегодня", "Завтра")]));
});

test("fresh cache avoids a request to Yandex", async () => {
  const weather = await loadBriefingWeather({
    now: NOW,
    cache: { match: async () => Response.json({ weather: WEATHER, observedAt: NOW.toISOString() }) },
    fetchImpl: async () => assert.fail("A fresh cache must not fetch Yandex"),
  });
  assert.deepEqual(weather, WEATHER);
});

test("old cache is refreshed and only successful forecasts are stored", async () => {
  const stored = [];
  let requests = 0;
  const weather = await loadBriefingWeather({
    now: NOW,
    cache: {
      match: async () => Response.json({ weather: WEATHER, observedAt: "2026-10-15T05:40:00Z" }),
      put: async (_key, response) => stored.push(await response.json()),
    },
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, YANDEX_WEATHER_URL);
      assert.ok(options.signal instanceof AbortSignal);
      return new Response("<html></html>");
    },
    readParagraphs: async () => PARAGRAPHS,
  });
  assert.deepEqual(weather, WEATHER);
  assert.equal(requests, 1);
  assert.equal(stored[0].observedAt, NOW.toISOString());
});

test("cache from before Moscow midnight is never used on the new day", async () => {
  let requests = 0;
  await loadBriefingWeather({
    now: new Date("2026-10-14T21:01:00Z"),
    cache: {
      match: async () => Response.json({ weather: WEATHER, observedAt: "2026-10-14T20:59:00Z" }),
      put: async () => {},
    },
    fetchImpl: async () => { requests += 1; return new Response("ok"); },
    readParagraphs: async () => PARAGRAPHS,
  });
  assert.equal(requests, 1);
});

test("HTTP and parsing failures do not write a false forecast to cache", async () => {
  for (const status of [200, 503]) {
    await assert.rejects(loadBriefingWeather({
      now: NOW,
      cache: { match: async () => undefined, put: async () => assert.fail("Do not cache errors") },
      fetchImpl: async () => new Response("error", { status }),
      readParagraphs: async () => [],
    }));
  }
});

test("disabled weather permission cannot query the source", async () => {
  assert.deepEqual(await buildBriefingWeatherSection({
    access: { canWeather: false }, now: NOW,
    weatherProvider: async () => assert.fail("Weather is disabled"),
  }), []);
});

test("briefing includes weather and personal tasks in a single message", async () => {
  const text = await buildMorningBriefing({
    TASKS_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
  }, {
    ownerId: 200, access: { canTasks: true, canWeather: true }, now: NOW,
    weatherProvider: async () => WEATHER,
  });
  assert.match(text, /Погода · Москва/);
  assert.match(text, /Сейчас \+9°.*Ощущается как \+7°/);
  assert.match(text, /Утром: \+8°, небольшой дождь/);
  assert.match(text, /Ветер: 1,4 м\/с/);
  assert.match(text, /Задач на сегодня нет\./);
  assert.ok(text.indexOf("Погода") < text.indexOf("Задачи на сегодня"));
  assert.ok(text.length <= 3800);
});

test("weather failure leaves the task section available", async (t) => {
  t.mock.method(console, "error", () => {});
  const text = await buildMorningBriefing({
    TASKS_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
  }, {
    ownerId: 200, access: { canTasks: true, canWeather: true }, now: NOW,
    weatherProvider: async () => { throw new Error("Yandex unavailable"); },
  });
  assert.match(text, /Погода временно недоступна/);
  assert.match(text, /Задач на сегодня нет/);
});
