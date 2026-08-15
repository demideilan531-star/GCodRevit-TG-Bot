import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "weather_report.py"
SPEC = importlib.util.spec_from_file_location("weather_report", MODULE_PATH)
weather_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(weather_report)


class WeatherReportTests(unittest.TestCase):
    def test_legacy_tomorrow_forecast(self):
        page = (
            '<p class="A11Y_visuallyHidden visuallyHidden">'
            'Прогноз погоды на завтра: слабый дождь · +15…+25° · слабый ветер 3–5 м/с'
            '</p>'
        )

        self.assertEqual(
            weather_report.tomorrow_forecast(page),
            "слабый дождь · +15…+25° · слабый ветер 3–5 м/с",
        )

    def test_current_tomorrow_forecast_is_compact(self):
        page = (
            '<p class="A11Y_visuallyHidden visuallyHidden">Завтра, 16 августа:<br />'
            'утром температура воздуха +16°, ощущается как +14°, облачно, '
            'скорость ветра 3,5 м/с, северо-западный<br />'
            'днём +24°, ощущается как +22°, облачно с прояснениями, '
            'скорость ветра 4,6 м/с, западный<br />'
            'вечером +23°, ощущается как +22°, пасмурно, скорость ветра 3,5 м/с<br />'
            'ночью +19°, ощущается как +18°, небольшой дождь, скорость ветра 3,4 м/с'
            '</p>'
        )

        self.assertEqual(
            weather_report.tomorrow_forecast(page),
            "Облачно с прояснениями · +16…+24° · ветер 4,6 м/с",
        )

    def test_current_extended_forecast_warning(self):
        page = (
            '<span>На следующей неделе</span></h3></div>'
            '<p class="AppWarningsItemWarning_text__f4Y_V">'
            'дожди · +20…+24° · слабый ветер 3–4 м/с'
            '</p>'
        )

        self.assertEqual(
            weather_report.extended_forecast(page),
            (
                "НА СЛЕДУЮЩЕЙ НЕДЕЛЕ",
                "На следующей неделе",
                "дожди · +20…+24° · слабый ветер 3–4 м/с",
            ),
        )


if __name__ == "__main__":
    unittest.main()

