import html as html_lib
import os
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont


WEATHER_URL = os.getenv(
    "WEATHER_URL",
    "https://yandex.ru/pogoda/ru/moscow?lat=55.755863&lon=37.6177",
)
TIMEZONE = ZoneInfo(os.getenv("REPORT_TIMEZONE", "Europe/Moscow"))
IMAGE_PATH = Path(os.getenv("WEATHER_IMAGE_PATH", "/tmp/weather_report.png"))
CAPTION_PATH = Path(os.getenv("WEATHER_CAPTION_PATH", "/tmp/weather_caption.txt"))

INK = "#252634"
MUTED = "#85899d"
LINE = "#e8ebf2"
BLUE_CARD = "#f1f8fc"
SUN = "#ffb817"
CLOUD = "#91bff4"
RAIN = "#5da9ef"


def normalize_text(value):
    value = html_lib.unescape(re.sub(r"<[^>]+>", "", value or ""))
    value = (
        value.replace("\u2060", "")
        .replace("\u200c", "")
        .replace("\u200b", "")
        .replace("\ufeff", "")
        .replace("\xa0", " ")
        .replace("−", "-")
    )
    return re.sub(r"\s+", " ", value).strip()


def fetch_html():
    fixture = os.getenv("WEATHER_HTML_FILE", "").strip()
    if fixture:
        return Path(fixture).read_text(encoding="utf-8")

    request = urllib.request.Request(
        WEATHER_URL,
        headers={
            "Accept-Language": "ru-RU,ru;q=0.9",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "Chrome/126.0 Safari/537.36"
            ),
        },
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        if response.status != 200:
            raise RuntimeError(f"Яндекс Погода вернула HTTP {response.status}")
        return response.read().decode("utf-8", "replace")


def first_match(pattern, source, label, flags=re.IGNORECASE | re.DOTALL):
    match = re.search(pattern, source, flags)
    if not match:
        raise RuntimeError(f"Не удалось найти поле «{label}» на странице Яндекс Погоды")
    return normalize_text(match.group(1))


def extract_number(pattern, source, label, required=True):
    match = re.search(pattern, source, re.IGNORECASE)
    if not match:
        if required:
            raise RuntimeError(f"Не удалось определить {label}")
        return None
    return match.group(1).replace("−", "-").replace(",", ".")


def extended_forecast(page):
    periods = (
        ("НА ЭТОЙ НЕДЕЛЕ", "На неделе", "неделю"),
        ("НА ВЫХОДНЫЕ", "На выходные", "выходные"),
        ("СЕГОДНЯ", "Сегодня", "сегодня"),
    )
    for image_label, caption_label, period in periods:
        match = re.search(
            rf'<p class="[^"]*visuallyHidden[^"]*">Прогноз погоды на {period}:\s*(.*?)</p>',
            page,
            re.IGNORECASE | re.DOTALL,
        )
        if match:
            return image_label, caption_label, normalize_text(match.group(1))

    raise RuntimeError("Не удалось найти дополнительный прогноз на странице Яндекс Погоды")


def parse_weather(page):
    fact_text = first_match(
        r'<p class="[^"]*visuallyHidden[^"]*">([^<]*?погода сейчас:[^<]+)</p>',
        page,
        "текущая погода",
    )

    location = first_match(r"^(.*?),\s*погода сейчас:", fact_text, "местоположение")
    condition = first_match(r"погода сейчас:\s*([^.]*)\.", fact_text, "состояние")
    temperature = int(float(extract_number(r"Температура воздуха\s*([+\-−]?\d+)", fact_text, "температуру")))
    feels_like = int(float(extract_number(r"ощущается как\s*([+\-−]?\d+)", fact_text, "ощущаемую температуру")))
    wind_speed = float(extract_number(r"Скорость ветра\s*([\d,.]+)", fact_text, "скорость ветра"))
    wind_direction = first_match(
        r"Скорость ветра\s*[\d,.]+\s*м/с,\s*([^.]*)\.",
        fact_text,
        "направление ветра",
    )
    pressure = int(float(extract_number(r"Давление\s*(\d+)", fact_text, "давление")))
    humidity = int(float(extract_number(r"Влажность\s*(\d+)", fact_text, "влажность")))
    water_raw = extract_number(r"Температура воды[^+\-−\d]*([+\-−]?\d+)", fact_text, "температуру воды", False)
    water_temperature = int(float(water_raw)) if water_raw is not None else None
    yesterday_raw = extract_number(r"Вчера в это время\s*([+\-−]?\d+)", fact_text, "вчерашнюю температуру", False)
    yesterday = int(float(yesterday_raw)) if yesterday_raw is not None else None

    summary_match = re.search(
        r"погода сейчас:\s*[^.]*\.\s*(.*?)\s*Температура воздуха",
        fact_text,
        re.IGNORECASE,
    )
    summary = normalize_text(summary_match.group(1)).rstrip(",") if summary_match else condition

    tomorrow = first_match(
        r'<p class="[^"]*visuallyHidden[^"]*">Прогноз погоды на завтра:\s*(.*?)</p>',
        page,
        "прогноз на завтра",
    )
    extended_image_label, extended_caption_label, extended = extended_forecast(page)

    hourly = []
    for item in re.findall(
        r'<li class="[^"]*AppHourlyItem_container__[^"]*">(.*?)</li>',
        page,
        re.IGNORECASE | re.DOTALL,
    ):
        time_match = re.search(r"<time[^>]*>([^<]+)</time>", item, re.IGNORECASE)
        detail_match = re.search(
            r'<p class="[^"]*visuallyHidden[^"]*">(.*?)</p>',
            item,
            re.IGNORECASE | re.DOTALL,
        )
        if not time_match or not detail_match:
            continue
        time_text = normalize_text(time_match.group(1))
        details = normalize_text(detail_match.group(1))
        temp_match = re.search(r":\s*([+\-−]?\d+)°", details)
        condition_match = re.search(r"°[,]?\s*([^,\.]+)", details)
        if not temp_match:
            continue
        hourly.append(
            {
                "time": time_text,
                "temperature": int(temp_match.group(1).replace("−", "-")),
                "condition": normalize_text(condition_match.group(1)) if condition_match else condition,
            }
        )
        if len(hourly) == 10:
            break

    if len(hourly) < 4:
        raise RuntimeError("Яндекс Погода не вернула достаточный почасовой прогноз")

    return {
        "location": location.replace("Тверской район", "Москва"),
        "condition": condition,
        "summary": summary,
        "temperature": temperature,
        "feels_like": feels_like,
        "wind_speed": wind_speed,
        "wind_direction": wind_direction,
        "pressure": pressure,
        "humidity": humidity,
        "water_temperature": water_temperature,
        "yesterday": yesterday,
        "tomorrow": tomorrow,
        "extended_image_label": extended_image_label,
        "extended_caption_label": extended_caption_label,
        "extended": extended,
        "hourly": hourly,
    }


def font_path(bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    return next((path for path in candidates if Path(path).exists()), candidates[0])


def font(size, bold=False):
    return ImageFont.truetype(font_path(bold), size)


def signed(value):
    return f"{value:+d}°"


def weather_kind(text):
    value = (text or "").lower()
    if any(word in value for word in ("гроза", "thunder")):
        return "thunder"
    if any(word in value for word in ("снег", "snow")):
        return "snow"
    if any(word in value for word in ("дожд", "лив", "осад", "rain")):
        return "rain"
    if any(word in value for word in ("туман", "дымк", "fog")):
        return "fog"
    if any(word in value for word in ("пасмур", "overcast")):
        return "cloud"
    if any(word in value for word in ("облач", "partly")):
        return "partly"
    return "clear"


def draw_sun(draw, cx, cy, radius):
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=SUN)
    for dx, dy in ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)):
        inner = radius + 8
        outer = radius + 18
        draw.line(
            (cx + dx * inner, cy + dy * inner, cx + dx * outer, cy + dy * outer),
            fill=SUN,
            width=max(3, radius // 5),
        )


def draw_cloud(draw, cx, cy, size, color=CLOUD):
    left = cx - size * 0.46
    top = cy - size * 0.12
    draw.rounded_rectangle(
        (left, top, cx + size * 0.5, cy + size * 0.28),
        radius=int(size * 0.18),
        fill=color,
    )
    draw.ellipse((cx - size * 0.31, cy - size * 0.36, cx + size * 0.05, cy + size * 0.12), fill=color)
    draw.ellipse((cx - size * 0.04, cy - size * 0.27, cx + size * 0.3, cy + size * 0.13), fill=color)


def draw_weather_icon(draw, cx, cy, size, kind):
    if kind == "clear":
        draw_sun(draw, cx, cy, int(size * 0.22))
        return
    if kind == "partly":
        draw_sun(draw, cx - size * 0.18, cy - size * 0.18, int(size * 0.17))
        draw_cloud(draw, cx + size * 0.05, cy + size * 0.04, size * 0.82)
        return
    draw_cloud(draw, cx, cy - size * 0.05, size * 0.86)
    if kind == "rain":
        for offset in (-0.24, 0, 0.24):
            x = cx + size * offset
            draw.line((x, cy + size * 0.24, x - size * 0.06, cy + size * 0.38), fill=RAIN, width=max(3, int(size * 0.07)))
    elif kind == "snow":
        for offset in (-0.24, 0, 0.24):
            x = cx + size * offset
            y = cy + size * 0.32
            draw.line((x - 5, y, x + 5, y), fill=RAIN, width=2)
            draw.line((x, y - 5, x, y + 5), fill=RAIN, width=2)
    elif kind == "thunder":
        points = [
            (cx + size * 0.03, cy + size * 0.18),
            (cx - size * 0.08, cy + size * 0.37),
            (cx + size * 0.04, cy + size * 0.36),
            (cx - size * 0.02, cy + size * 0.52),
            (cx + size * 0.19, cy + size * 0.3),
            (cx + size * 0.07, cy + size * 0.3),
        ]
        draw.polygon(points, fill=SUN)
    elif kind == "fog":
        for offset in (0.18, 0.31, 0.44):
            draw.line(
                (cx - size * 0.34, cy + size * offset, cx + size * 0.34, cy + size * offset),
                fill=MUTED,
                width=max(2, int(size * 0.04)),
            )


def wrap_lines(draw, text, selected_font, max_width, max_lines):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=selected_font)[2] <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while draw.textbbox((0, 0), lines[-1] + "…", font=selected_font)[2] > max_width:
            lines[-1] = lines[-1][:-1]
        lines[-1] += "…"
    return lines


def draw_wrapped(draw, xy, text, selected_font, fill, max_width, max_lines=2, spacing=7):
    x, y = xy
    lines = wrap_lines(draw, text, selected_font, max_width, max_lines)
    draw.multiline_text((x, y), "\n".join(lines), font=selected_font, fill=fill, spacing=spacing)


def build_image(weather):
    image = Image.new("RGB", (1200, 790), "#ffffff")
    draw = ImageDraw.Draw(image)
    now = datetime.now(TIMEZONE)

    draw.text((42, 26), "МОСКВА • ПОГОДА", font=font(27, True), fill=INK)
    draw.text((1158, 31), now.strftime("%d.%m.%Y • %H:%M МСК"), font=font(20), fill=MUTED, anchor="ra")
    draw.line((42, 70, 1158, 70), fill=LINE, width=2)

    draw.text((42, 86), signed(weather["temperature"]), font=font(116), fill=INK)
    draw_weather_icon(draw, 325, 151, 94, weather_kind(weather["condition"]))
    draw.text((410, 96), weather["condition"].capitalize(), font=font(38, True), fill=INK)
    draw_wrapped(draw, (410, 149), weather["summary"], font(27, True), INK, 715, 2)

    detail_parts = [f"Ощущается как {signed(weather['feels_like'])}"]
    if weather["yesterday"] is not None:
        detail_parts.append(f"вчера в это время {signed(weather['yesterday'])}")
    draw.text((410, 219), "  •  ".join(detail_parts), font=font(22), fill=MUTED)

    metrics = [
        ("ВЕТЕР", f"{weather['wind_speed']:g} м/с, {weather['wind_direction']}"),
        ("ДАВЛЕНИЕ", f"{weather['pressure']} мм"),
        ("ВЛАЖНОСТЬ", f"{weather['humidity']}%"),
    ]
    if weather["water_temperature"] is not None:
        metrics.append(("ВОДА", signed(weather["water_temperature"])))
    metric_positions = (410, 705, 885, 1040) if len(metrics) == 4 else (410, 750, 980)
    for x, (label, value) in zip(metric_positions, metrics):
        draw.text((x, 260), label, font=font(16, True), fill=MUTED)
        draw.text((x, 284), value, font=font(19, True), fill=INK)

    card_y = 338
    card_w = 548
    card_h = 154
    cards = [
        (42, "ЗАВТРА", weather["tomorrow"]),
        (610, weather["extended_image_label"], weather["extended"]),
    ]
    for x, title, description in cards:
        draw.rounded_rectangle((x, card_y, x + card_w, card_y + card_h), radius=24, fill=BLUE_CARD)
        draw_weather_icon(draw, x + 51, card_y + 47, 48, weather_kind(description))
        draw.text((x + 91, card_y + 24), title, font=font(24, True), fill=INK)
        draw_wrapped(draw, (x + 24, card_y + 75), description, font(21), INK, card_w - 48, 3, 5)

    draw.text((42, 524), "ПОЧАСОВОЙ ПРОГНОЗ", font=font(22, True), fill=INK)
    hourly = weather["hourly"][:10]
    item_width = 111
    start_x = 44
    for index, item in enumerate(hourly):
        center_x = start_x + index * item_width + item_width // 2
        draw.text((center_x, 570), item["time"], font=font(20), fill=INK, anchor="ma")
        draw_weather_icon(draw, center_x, 635, 58, weather_kind(item["condition"]))
        draw.text((center_x, 692), signed(item["temperature"]), font=font(23, True), fill=INK, anchor="ma")

    draw.line((42, 742, 1158, 742), fill=LINE, width=2)
    draw.text((42, 758), "Актуальный прогноз для Москвы", font=font(17), fill=MUTED)
    draw.text((1158, 758), "Источник данных: Яндекс Погода", font=font(17), fill=MUTED, anchor="ra")

    IMAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    image.save(IMAGE_PATH, format="PNG", optimize=True)


def build_caption(weather):
    now = datetime.now(TIMEZONE)
    lines = [
        "🌤 Погода в Москве",
        f"🕒 {now.strftime('%d.%m.%Y, %H:%M')} МСК",
        "",
        f"🌡 Сейчас: {signed(weather['temperature'])}, {weather['condition'].lower()}",
        f"Ощущается как {signed(weather['feels_like'])}. {weather['summary']}",
        f"🌬 Ветер: {weather['wind_speed']:g} м/с, {weather['wind_direction']}",
        f"🧭 Давление: {weather['pressure']} мм рт. ст.",
        f"💧 Влажность: {weather['humidity']}%",
        "",
        f"Завтра: {weather['tomorrow']}",
        f"{weather['extended_caption_label']}: {weather['extended']}",
        "",
        "Источник: Яндекс Погода",
        WEATHER_URL,
    ]
    CAPTION_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPTION_PATH.write_text("\n".join(lines)[:1000], encoding="utf-8")


def main():
    page = fetch_html()
    weather = parse_weather(page)
    build_image(weather)
    build_caption(weather)
    print(
        f"Weather report built: {weather['location']}, "
        f"{signed(weather['temperature'])}, {weather['condition']}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Weather report failed: {error}", file=sys.stderr)
        raise
