import io
import json
import os
import sys
import unittest
from urllib.error import HTTPError
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import morning_briefing as briefing


def page(hours):
    fact = '<p class="visuallyHidden">Москва, погода сейчас: Ясно. Температура воздуха +12°, ощущается как +10°. Давление 755 мм.</p>'
    result = [fact]
    for date, temperature, condition in hours:
        result.append(f'<li class="AppHourlyItem_container__abc"><div aria-hidden="true"><time dateTime="{date}"></time></div><p class="A11Y_visuallyHidden__abc visuallyHidden">{briefing.instant(date):%H:%M}: {temperature:+d}°, {condition}, Ощущается как +10°.</p></li>')
    return "".join(result)


HOURS = [
    ("2026-10-15T06:00:00Z", 8, "ясно"),
    ("2026-10-15T09:00:00Z", 10, "ясно"),
    ("2026-10-15T10:00:00Z", 13, "малооблачно"),
    ("2026-10-15T13:00:00Z", 15, "малооблачно"),
    ("2026-10-15T14:00:00Z", 11, "пасмурно"),
    ("2026-10-15T20:00:00Z", 9, "пасмурно"),
    ("2026-10-15T21:00:00Z", -20, "снег"),
]
NOW = briefing.instant("2026-10-15T06:00:00Z")


def sample_claim():
    return {
        "generated_at": NOW.isoformat(), "chat_id": "200", "message_id": 12,
        "tasks": {
            "today": {"total": 3, "rows": [
                {"title": "Работа с фасадами", "due_at": "2026-10-15T10:00:00Z", "flags": ["Работа"], "subtasks_done": 1, "subtasks_total": 4},
                {"title": "Отправить проект на согласование", "due_at": "2026-10-15T13:30:00Z", "flags": ["Работа"], "status": "in_progress"},
                {"title": "Купить продукты", "due_at": "2026-10-15T16:00:00Z", "flags": ["Личное"]},
            ]},
            "overdue": {"total": 0, "rows": []},
            "undated": {"total": 0, "rows": []},
        },
    }


class MorningBriefingTest(unittest.TestCase):
    def test_exact_hour_boundaries_and_midnight(self):
        weather = briefing.parse_weather(page(HOURS), NOW)
        self.assertEqual(weather["temperature"], 12)
        self.assertEqual([(p["low"], p["high"]) for p in weather["periods"]], [(8, 10), (13, 15), (9, 11)])
        self.assertNotIn("pressure", weather)
        self.assertNotIn("755", json.dumps(weather))

    def test_deduplicates_mobile_and_desktop_hours(self):
        parser = briefing.YandexHourlyParser()
        parser.feed(page(HOURS + HOURS))
        self.assertEqual(len(parser.hours), 7)

    def test_no_invented_forecast_for_elapsed_morning(self):
        weather = briefing.parse_weather(page(HOURS[2:]), briefing.instant("2026-10-15T11:00:00Z"))
        self.assertEqual(weather["periods"][0]["unavailable"], "Период завершён")

    def test_future_missing_period_not_marked_elapsed(self):
        weather = briefing.parse_weather(page(HOURS[:2]), NOW)
        self.assertEqual(weather["periods"][2]["unavailable"], "Нет данных")

    def test_hourly_events_and_forecast_for_other_date_are_excluded(self):
        html = page(HOURS) + '<li class="AppHourlyItem_container__a"><time datetime="2026-10-15T14:31:00Z"></time><p class="visuallyHidden">Закат</p></li>'
        self.assertEqual(briefing.parse_weather(html, NOW)["periods"][2]["low"], 9)

    def test_parser_does_not_require_pressure_or_daily_standard_periods(self):
        weather = briefing.parse_weather(page(HOURS).replace("Давление 755 мм.", ""), NOW)
        self.assertEqual(weather["temperature"], 12)
        with self.assertRaises(ValueError):
            briefing.parse_weather("<p>Captcha</p>", NOW)

    def test_long_task_titles_cannot_overflow(self):
        image = briefing.Image.new("RGB", (1080, 200))
        draw = briefing.ImageDraw.Draw(image)
        for value in ["Очень длинное название " * 60, "я" * 400]:
            lines = briefing.fit_lines(draw, value, briefing.font(32, True), 780)
            self.assertLessEqual(len(lines), 2)
            self.assertTrue(all(draw.textlength(line, font=briefing.font(32, True)) <= 780 for line in lines))

    def test_combined_preview_and_empty_task_image(self):
        weather = briefing.parse_weather(page(HOURS), NOW)
        claim = sample_claim()
        image = briefing.render_briefing(claim, weather)
        self.assertEqual(image.width, 1080)
        self.assertLess(image.height, 1800)
        target = os.environ.get("BRIEFING_PREVIEW_DIR")
        if target:
            folder = Path(target)
            folder.mkdir(parents=True, exist_ok=True)
            image.save(folder / "briefing-preview.png")
        claim["tasks"]["today"] = {"rows": [], "total": 0}
        empty = briefing.render_briefing(claim, weather)
        self.assertLess(empty.height, image.height)
        if target:
            empty.save(folder / "briefing-empty.png")

    def test_weather_failure_keeps_tasks_and_many_tasks_fit_telegram_limits(self):
        claim = sample_claim()
        image = briefing.render_briefing(claim, None)
        self.assertGreater(image.height, 600)
        row = {"title": "Длинная задача " * 40, "flags": ["Работа", "Срочно"], "subtasks_done": 1, "subtasks_total": 4}
        claim["tasks"] = {kind: {"rows": [row] * count, "total": 100} for kind, count in [("today", 8), ("overdue", 4), ("undated", 4)]}
        image = briefing.render_briefing(claim, briefing.parse_weather(page(HOURS), NOW))
        self.assertLess(image.height, 4800)
        self.assertLess(image.height + image.width, 10000)

    def test_delivery_edits_one_message_without_plaintext_task_caption(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.close()
        captured = []
        def send(request, timeout):
            captured.append(request)
            return Response(b'{"ok":true,"result":{}}')
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "fake-token", "GMAIL_BROKER_URL": "https://example.com"}), patch.object(briefing, "urlopen", send):
            briefing.deliver(sample_claim(), briefing.Image.new("RGB", (20, 20)))
        self.assertEqual(len(captured), 1)
        self.assertTrue(captured[0].full_url.endswith("/editMessageMedia"))
        self.assertNotIn("Работа с фасадами".encode(), captured[0].data)
        self.assertIn(b'attach://briefing', captured[0].data)

    def test_broker_identifies_the_client_instead_of_using_blocked_python_user_agent(self):
        captured = []

        def send(request, timeout):
            captured.append(request)
            return io.BytesIO(b'{"request_id":"opaque-id"}')

        with patch.dict(os.environ, {"GMAIL_BROKER_URL": "https://example.com", "GMAIL_BROKER_TOKEN": "fake-token"}), patch.object(briefing, "urlopen", send):
            result = briefing.broker_request("claim", {"request_id": "opaque-id"})
        self.assertEqual(result, {"request_id": "opaque-id"})
        self.assertEqual(captured[0].get_header("User-agent"), "GCodRevit-Morning-Briefing-Workflow")
        self.assertEqual(captured[0].get_header("Authorization"), "Bearer fake-token")

    def test_telegram_failure_category_never_exposes_unknown_response_text(self):
        for description, expected in [
            ("Bad Request: message to edit not found", "message_missing"),
            ("Bad Request: message can't be edited", "message_not_editable"),
            ("private user data must not appear here", "request_rejected"),
            ("Bad Request: there is no media in the message to edit", "bad request: there is no media in the message to edit"),
        ]:
            error = HTTPError("https://example.com", 400, "Bad Request", {}, io.BytesIO(json.dumps({"description": description}).encode()))
            self.assertEqual(briefing.telegram_error_category(error), expected)

    def test_completion_failure_does_not_hide_original_delivery_failure(self):
        claim = sample_claim()
        claim["expires_at"] = "2099-01-01T00:00:00Z"
        claim["can_weather"] = False
        def broker(endpoint, payload):
            if endpoint == "claim":
                return claim
            raise RuntimeError("Callback failed")
        with patch.dict(os.environ, {"BRIEFING_REQUEST_ID": "opaque"}), patch.object(briefing, "broker_request", broker), patch.object(briefing, "render_briefing", return_value=None), patch.object(briefing, "deliver", side_effect=briefing.TelegramDeliveryError("HTTP 400: message_missing")):
            with self.assertRaisesRegex(RuntimeError, "Briefing failed at telegram: HTTP 400: message_missing"):
                briefing.main()


if __name__ == "__main__":
    unittest.main()
