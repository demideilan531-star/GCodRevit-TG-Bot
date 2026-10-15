"""Private, data-driven briefing image. No model API or public image hosting."""

import io
import json
import os
import re
import uuid
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw

from weather_report import draw_weather_icon, fetch_html, font, signed, weather_kind

MOSCOW = ZoneInfo("Europe/Moscow")
SOURCE = "https://yandex.ru/pogoda/ru/moscow?lat=55.755863&lon=37.6177"
INK, MUTED, LINE = "#252b32", "#68737d", "#e1e6e8"
GREEN, RED = "#237c62", "#bb493d"
PERIODS = (("Утро", "до 13:00", 0, 13), ("День", "13:00–17:00", 13, 17), ("Вечер", "17:00–00:00", 17, 24))


def clean(value):
    return " ".join(str(value or "").replace("−", "-").replace("\u200c", "").split())


def instant(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp needs a timezone")
    return parsed.astimezone(MOSCOW)


class YandexHourlyParser(HTMLParser):
    """Read accessible fact and dated hourly items, ignoring hydration scripts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraph = None
        self.paragraphs = []
        self.hour = None
        self.hours = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "")
        if tag == "li" and "AppHourlyItem_container" in classes:
            self.hour = {"date": None, "text": ""}
        if self.hour is not None and tag == "time":
            self.hour["date"] = attrs.get("datetime")
        if tag == "p" and "visuallyHidden" in classes:
            self.paragraph = []
        if tag == "br" and self.paragraph is not None:
            self.paragraph.append(" ")

    def handle_data(self, data):
        if self.paragraph is not None:
            self.paragraph.append(data)

    def handle_endtag(self, tag):
        if tag == "p" and self.paragraph is not None:
            text = clean("".join(self.paragraph))
            self.paragraphs.append(text)
            if self.hour is not None:
                self.hour["text"] = text
            self.paragraph = None
        if tag == "li" and self.hour is not None:
            match = re.match(r"\d{1,2}:\d{2}:\s*([+-]?\d+)°\s*,\s*([^,.]+)", self.hour["text"])
            if match and self.hour["date"]:
                try:
                    date = instant(self.hour["date"])
                    self.hours[date] = {"at": date, "temperature": int(match[1]), "condition": clean(match[2])}
                except ValueError:
                    pass
            self.hour = None


def parse_weather(page, now):
    parser = YandexHourlyParser()
    parser.feed(page)
    fact = next((p for p in parser.paragraphs if "погода сейчас:" in p.lower()), "")
    temperature = re.search(r"Температура воздуха\s*([+-]?\d+)°", fact, re.I)
    condition = re.search(r"погода сейчас:\s*([^.]*)", fact, re.I)
    if not temperature or not condition:
        raise ValueError("Current weather not found")
    local_now = now.astimezone(MOSCOW)
    hours = [row for row in parser.hours.values() if row["at"].date() == local_now.date()]
    periods = []
    for label, interval, start, end in PERIODS:
        samples = sorted((row for row in hours if start <= row["at"].hour < end), key=lambda row: row["at"])
        period = {"label": label, "interval": interval}
        if not samples:
            period["unavailable"] = "Период завершён" if local_now.hour >= end else "Нет данных"
        else:
            period.update(
                low=min(row["temperature"] for row in samples),
                high=max(row["temperature"] for row in samples),
                condition=Counter(row["condition"] for row in samples).most_common(1)[0][0],
                note=f"с {samples[0]['at']:%H:%M}" if samples[0]["at"].hour > start else "",
            )
        periods.append(period)
    return {"temperature": int(temperature[1]), "condition": clean(condition[1]).capitalize(), "periods": periods}


def fit_lines(draw, value, selected_font, width, max_lines=2):
    # Split long unbroken words too, so task titles cannot cross the time column.
    lines, current = [], ""
    for character in clean(value):
        if draw.textlength(current + character, font=selected_font) > width:
            split = current.rfind(" ")
            if split > 0:
                lines.append(current[:split])
                current = current[split + 1:] + character
            else:
                lines.append(current)
                current = character
        else:
            current += character
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while draw.textlength(lines[-1] + "…", font=selected_font) > width:
            lines[-1] = lines[-1][:-1]
        lines[-1] = lines[-1].rstrip() + "…"
    return lines or [""]


def draw_lines(draw, xy, lines, selected_font, fill, step):
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=selected_font, fill=fill)
        y += step
    return y


def render_briefing(claim, weather):
    now = instant(claim["generated_at"])
    image = Image.new("RGB", (1080, 4800), "#ffffff")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1080, 12), fill=GREEN)
    draw.text((48, 43), "Утренний брифинг", font=font(46, True), fill=INK)
    draw.text((48, 105), f"{now:%d.%m.%Y}  ·  {now:%H:%M} МСК", font=font(26), fill=MUTED)
    draw.line((48, 164, 1032, 164), fill=LINE, width=2)
    draw.text((48, 192), "Москва · сейчас", font=font(30, True), fill=INK)
    if weather:
        draw.text((44, 230), signed(weather["temperature"]), font=font(100, True), fill=INK)
        draw_weather_icon(draw, 410, 288, 96, weather_kind(weather["condition"]))
        draw_lines(draw, (500, 255), fit_lines(draw, weather["condition"], font(32), 520), font(32), INK, 40)
        y = 370
        for index, period in enumerate(weather["periods"]):
            x = 48 + index * 336
            if index:
                draw.line((x - 20, y, x - 20, y + 205), fill=LINE, width=2)
            draw.text((x, y), period["label"], font=font(30, True), fill=INK)
            draw.text((x, y + 42), period["interval"], font=font(25), fill=MUTED)
            if "unavailable" in period:
                draw_lines(draw, (x, y + 100), fit_lines(draw, period["unavailable"], font(25), 280), font(25), MUTED, 34)
            else:
                low, high = period["low"], period["high"]
                temperature = signed(low) if low == high else f"{low:+d}…{high:+d}°"
                draw.text((x, y + 96), temperature, font=font(38, True), fill=INK)
                draw_weather_icon(draw, x + 260, y + 116, 55, weather_kind(period["condition"]))
                draw_lines(draw, (x, y + 153), fit_lines(draw, period["condition"].capitalize(), font(23), 298, 1), font(23), MUTED, 32)
                if period["note"]:
                    draw.text((x, y + 185), period["note"], font=font(22), fill=MUTED)
        y = 620
        draw.text((48, y), "Температуры по почасовому прогнозу · Яндекс Погода", font=font(23), fill=MUTED)
        y += 62
    else:
        label = "Погода временно недоступна" if claim.get("can_weather", True) else "Погода недоступна для этого аккаунта"
        draw.text((48, 260), label, font=font(32), fill=MUTED)
        y = 350
    draw.line((48, y, 1032, y), fill=LINE, width=2)
    y += 37
    tasks = claim.get("tasks") or {}
    if tasks.get("unavailable"):
        draw.text((48, y), tasks["unavailable"], font=font(32), fill=MUTED)
        y += 70
    else:
        for kind, title in (("today", "Задачи на сегодня"), ("overdue", "Просроченные"), ("undated", "Без срока")):
            group = tasks.get(kind) or {"rows": [], "total": 0}
            if kind != "today" and not group["total"]:
                continue
            color = RED if kind == "overdue" else INK
            draw.text((48, y), title, font=font(34, True), fill=color)
            count = str(group["total"])
            draw.text((1032 - draw.textlength(count, font=font(34, True)), y), count, font=font(34, True), fill=color)
            y += 63
            if not group["total"]:
                draw.text((48, y), "Задач на сегодня нет.", font=font(30), fill=MUTED)
                y += 72
            for task in group["rows"]:
                title_lines = fit_lines(draw, task["title"], font(32, True), 780)
                draw.rounded_rectangle((50, y + 9, 75, y + 34), radius=5, outline=GREEN, width=2)
                end = draw_lines(draw, (96, y), title_lines, font(32, True), INK, 42)
                if task.get("due_at"):
                    due = instant(task["due_at"])
                    time = due.strftime("%H:%M" if kind == "today" else "%d.%m")
                    draw.text((1032 - draw.textlength(time, font=font(27)), y + 3), time, font=font(27), fill=color)
                details = (["В работе"] if task.get("status") == "in_progress" else []) + task.get("flags", [])
                if task.get("subtasks_total"):
                    details.append(f"{task['subtasks_done']}/{task['subtasks_total']} подзадач")
                y = end + 9
                if details:
                    draw_lines(draw, (96, y), fit_lines(draw, " · ".join(details), font(24), 900, 1), font(24), MUTED, 32)
                    y += 35
                draw.line((96, y + 12, 1032, y + 12), fill=LINE)
                y += 35
            remaining = group["total"] - len(group["rows"])
            if remaining > 0:
                draw.text((96, y), f"Ещё {remaining} — в календаре", font=font(26), fill=MUTED)
                y += 48
            y += 28
    draw.text((48, y + 16), "На день. По делу.", font=font(24), fill=GREEN)
    return image.crop((0, 0, 1080, y + 94))


def broker_request(endpoint, payload):
    base = os.environ["GMAIL_BROKER_URL"].rstrip("/")
    request = Request(
        f"{base}/internal/briefing/{endpoint}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['GMAIL_BROKER_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "GCodRevit-Morning-Briefing-Workflow",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=45) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Briefing broker HTTP {error.code}") from None


class TelegramDeliveryError(RuntimeError):
    pass


def telegram_error_category(error):
    try:
        description = str(json.loads(error.read(4096)).get("description", "")).lower()
    except (ValueError, OSError):
        description = ""
    for fragment, category in (
        ("message to edit not found", "message_missing"),
        ("message can't be edited", "message_not_editable"),
        ("message is not modified", "not_modified"),
        ("bot was blocked", "bot_blocked"),
        ("unauthorized", "unauthorized"),
        ("button_type_invalid", "button_type_invalid"),
        ("web_app", "web_app_invalid"),
        ("photo_invalid", "photo_invalid"),
    ):
        if fragment in description:
            return category
    return "request_rejected"


def deliver(claim, image):
    caption = "Погода и задачи на сегодня."
    boundary = f"gcod-{uuid.uuid4().hex}"
    parts = []
    fields = {
        "chat_id": claim["chat_id"], "message_id": claim["message_id"],
        "media": json.dumps({"type": "photo", "media": "attach://briefing", "caption": caption}, ensure_ascii=False),
        "reply_markup": json.dumps({"inline_keyboard": [[
            {"text": "Календарь", "web_app": {"url": os.environ["GMAIL_BROKER_URL"].rstrip("/") + "/tasks/"}},
            {"text": "Яндекс Погода", "url": SOURCE},
        ]]}, ensure_ascii=False),
    }
    for key, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    parts.extend([
        f'--{boundary}\r\nContent-Disposition: form-data; name="briefing"; filename="briefing.png"\r\nContent-Type: image/png\r\n\r\n'.encode(),
        output.getvalue(), f"\r\n--{boundary}--\r\n".encode(),
    ])
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    request = Request(f"https://api.telegram.org/bot{token}/editMessageMedia", data=b"".join(parts), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urlopen(request, timeout=60) as response:
            if not json.load(response).get("ok"):
                raise RuntimeError("Telegram rejected briefing")
    except HTTPError as error:
        raise TelegramDeliveryError(f"HTTP {error.code}: {telegram_error_category(error)}") from None


def main():
    request_id = os.environ["BRIEFING_REQUEST_ID"]
    claim = broker_request("claim", {"request_id": request_id})
    delivered = False
    stage = "weather"
    failure = None
    try:
        weather = None
        if claim.get("can_weather"):
            try:
                weather = parse_weather(fetch_html(), datetime.now(MOSCOW))
            except Exception:
                print("Weather unavailable; continuing with personal tasks.")
        stage = "render"
        image = render_briefing(claim, weather)
        if instant(claim["expires_at"]) <= datetime.now(MOSCOW):
            raise RuntimeError("Briefing expired")
        stage = "telegram"
        deliver(claim, image)
        delivered = True
    except Exception as error:
        # Never print private tasks, broker responses, credentials, or Telegram URLs.
        reason = str(error) if isinstance(error, TelegramDeliveryError) else type(error).__name__
        failure = RuntimeError(f"Briefing failed at {stage}: {reason}")
    finally:
        try:
            broker_request("complete", {"request_id": request_id, "success": delivered})
        except Exception:
            print("Briefing completion callback failed.")
            if delivered:
                raise RuntimeError("Briefing delivered but completion callback failed") from None
    if failure:
        raise failure from None


if __name__ == "__main__":
    main()
