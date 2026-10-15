export const YANDEX_WEATHER_URL = "https://yandex.ru/pogoda/ru/moscow?lat=55.755863&lon=37.6177";
const CACHE_KEY = "https://gcodrevit.internal/briefing/yandex-moscow-v1";
const CACHE_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 7000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function normalizeText(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&deg;|&#176;/g, "°")
    .replace(/&amp;/g, "&")
    .replace(/[\u2060\u200c\u200b\ufeff]/g, "")
    .replace(/−/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readYandexParagraphs(response) {
  if (Number(response.headers.get("Content-Length") || 0) > MAX_HTML_BYTES) {
    throw new Error("Yandex Weather response is too large");
  }
  const paragraphs = [];
  let parts = null;
  const transformed = new HTMLRewriter()
    .on('p[class*="visuallyHidden"]', {
      element(element) {
        parts = [];
        element.onEndTag(() => {
          if (paragraphs.length < 250) paragraphs.push(normalizeText(parts.join("")));
          parts = null;
        });
      },
      text(chunk) {
        if (parts) parts.push(chunk.text);
      },
    })
    .on('p[class*="visuallyHidden"] br', {
      element() {
        if (parts) parts.push(" ");
      },
    })
    .transform(response);
  const reader = transformed.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error("Yandex Weather response is too large");
    }
  } finally {
    await reader.cancel();
  }
  return paragraphs;
}

function requiredNumber(text, pattern, label) {
  const value = text.match(pattern)?.[1];
  if (value === undefined) throw new Error(`Yandex Weather is missing ${label}`);
  const number = Number(value.replace(",", "."));
  if (!Number.isFinite(number)) throw new Error(`Yandex Weather has invalid ${label}`);
  return number;
}

export function parseBriefingWeather(paragraphs) {
  const texts = paragraphs.map(normalizeText);
  const current = texts.find((text) => /погода сейчас:/i.test(text));
  const today = texts.find((text) => /^(?:Сегодня(?:,|:)|Прогноз погоды на сегодня:)/i.test(text));
  if (!current || !today) throw new Error("Yandex Weather did not return today's forecast");
  const condition = current.match(/погода сейчас:\s*([^.]+)\./i)?.[1];
  if (!condition) throw new Error("Yandex Weather is missing current conditions");
  const temperature = requiredNumber(current, /Температура воздуха\s*([+-]?\d+)°/i, "temperature");
  const feelsLike = requiredNumber(current, /ощущается как\s*([+-]?\d+)°/i, "feels-like temperature");
  const windSpeed = requiredNumber(current, /Скорость ветра\s*([\d,.]+)\s*м\/с/i, "wind speed");
  const windDirection = current.match(/Скорость ветра\s*[\d,.]+\s*м\/с,\s*([^.]+)\./i)?.[1] || "";
  const periods = [...today.matchAll(
    /(утром|днём|днем|вечером|ночью)(?:\s+температура воздуха)?\s*([+-]?\d+)°,\s*ощущается как\s*[+-]?\d+°,\s*([^,]+),/gi,
  )].map((match) => ({
    period: match[1].toLowerCase().replace("днем", "днём"),
    temperature: Number(match[2]),
    condition: normalizeText(match[3]).toLowerCase().slice(0, 100),
  }));
  if (periods.length < 2) throw new Error("Yandex Weather is missing today's time periods");
  return {
    temperature, feelsLike, condition: condition.toLowerCase().slice(0, 100),
    windSpeed, windDirection: windDirection.slice(0, 50),
    low: Math.min(...periods.map((item) => item.temperature)),
    high: Math.max(...periods.map((item) => item.temperature)),
    periods,
  };
}

function moscowDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
}

function isFresh(cached, now) {
  const observedAt = new Date(cached?.observedAt).getTime();
  return Number.isFinite(observedAt) && observedAt <= now.getTime() &&
    now.getTime() - observedAt < CACHE_SECONDS * 1000 &&
    moscowDate(new Date(observedAt)) === moscowDate(now) &&
    Array.isArray(cached?.weather?.periods);
}

export async function loadBriefingWeather({
  now = new Date(), fetchImpl = globalThis.fetch, cache = globalThis.caches?.default,
  readParagraphs = readYandexParagraphs,
} = {}) {
  if (cache) {
    try {
      const response = await cache.match(CACHE_KEY);
      if (response) {
        const cached = await response.json();
        if (isFresh(cached, now)) return cached.weather;
      }
    } catch {
      // Cache failures must not prevent reading the source.
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let weather;
  try {
    const response = await fetchImpl(YANDEX_WEATHER_URL, {
      headers: {
        "Accept-Language": "ru-RU,ru;q=0.9",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Yandex Weather returned HTTP ${response.status}`);
    weather = parseBriefingWeather(await readParagraphs(response));
  } finally {
    clearTimeout(timeout);
  }
  if (cache) {
    try {
      await cache.put(CACHE_KEY, Response.json({ weather, observedAt: now.toISOString() }, {
        headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      }));
    } catch {
      // The fresh forecast remains usable even if it cannot be cached.
    }
  }
  return weather;
}

function signed(value) {
  return `${value > 0 ? "+" : ""}${value}°`;
}

export async function buildBriefingWeatherSection({ access, now, weatherProvider = loadBriefingWeather }) {
  if (!access.canWeather) return [];
  const weather = await weatherProvider({ now });
  const periods = weather.periods.filter(({ period }) => period !== "ночью");
  const lines = [
    "Погода · Москва",
    `Сейчас ${signed(weather.temperature)}, ${weather.condition}. Ощущается как ${signed(weather.feelsLike)}.`,
    `На день: ${signed(weather.low)}…${signed(weather.high)}.`,
    ...periods.map(({ period, temperature, condition }) =>
      `${period[0].toUpperCase()}${period.slice(1)}: ${signed(temperature)}, ${condition}.`),
    `Ветер: ${String(weather.windSpeed).replace(".", ",")} м/с${weather.windDirection ? `, ${weather.windDirection}` : ""}.`,
    `Яндекс Погода: ${YANDEX_WEATHER_URL}`,
  ];
  return lines;
}
