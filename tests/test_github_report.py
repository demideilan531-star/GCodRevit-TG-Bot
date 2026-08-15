import sys
import unittest
import uuid
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import github_report


SAMPLE = {
    "mode": "snapshot",
    "variant": "default",
    "repository": "demideilan531-star/GCod-",
    "branch": "main",
    "generated_at": "2026-08-14T12:00:00Z",
    "head_sha": "28dde2a425860f5884b34d38cd1c3b5d6267822f",
    "report_title": "GCodRevit: что уже доступно",
    "summary": "Первый человеческий обзор возможностей проекта.",
    "baseline_note": "Предыдущей версии пока нет, поэтому честного сравнения ещё не получится.",
    "changes": [
        {
            "status": "available",
            "title": "Чат ИИ прямо в Revit",
            "what": "На вкладке GCod появился чат с локальной моделью.",
            "how": "Открой Revit → GCod → ИИ → «Чат ИИ» и задай вопрос.",
            "why": "Можно получить подсказку, не переключаясь между приложениями.",
        },
        {
            "status": "new",
            "title": "BIM-задачи и переписка",
            "what": "Доступны создание задачи, чат и доска текущих работ.",
            "how": "Открой GCod → BIM отдел и выбери нужное действие.",
            "why": "Задачи и уточнения остаются в одном месте.",
        },
        {
            "status": "fixed",
            "title": "Подготовка семейств без рутины",
            "what": "Команды параметров, таблиц выбора и сборки работают в RFA.",
            "how": "Открой семейство и выбери нужную команду на вкладке GCod.",
            "why": "Меньше повторяемых действий и пропущенных параметров.",
        },
    ],
}


class GithubReportTests(unittest.TestCase):
    def test_normalize_limits_public_text(self):
        report = github_report.normalize_report(
            {
                **SAMPLE,
                "changes": [
                    {**SAMPLE["changes"][0], "what": "x" * 300},
                ]
                * 8,
            }
        )
        self.assertEqual(len(report["changes"]), 3)
        self.assertTrue(report["changes"][0]["what"].endswith("…"))

    def test_builds_human_readable_telegram_assets(self):
        suffix = uuid.uuid4().hex
        image_path = ROOT / "reports" / f"github-report-test-{suffix}.png"
        caption_path = ROOT / "reports" / f"github-report-test-{suffix}.txt"
        old_image = github_report.IMAGE_PATH
        old_caption = github_report.CAPTION_PATH
        try:
            github_report.IMAGE_PATH = image_path
            github_report.CAPTION_PATH = caption_path
            report = github_report.normalize_report(SAMPLE)
            github_report.build_image(report)
            github_report.build_caption(report)

            with Image.open(github_report.IMAGE_PATH) as image:
                self.assertEqual(image.size, (1200, 1200))
            caption = github_report.CAPTION_PATH.read_text(encoding="utf-8")
            self.assertLessEqual(len(caption), 1024)
            self.assertIn("Как:", caption)
            self.assertIn("Зачем:", caption)
            self.assertNotIn("строк", caption.lower())
            self.assertNotIn("файлов", caption.lower())
            self.assertIn("Мы это руками не делаем.", caption)
        finally:
            github_report.IMAGE_PATH = old_image
            github_report.CAPTION_PATH = old_caption
            image_path.unlink(missing_ok=True)
            caption_path.unlink(missing_ok=True)

    def test_long_title_fits_change_card(self):
        image = Image.new("RGB", (1200, 1200))
        draw = github_report.ImageDraw.Draw(image)
        title = "Очень длинное название новой возможности GCodRevit"
        selected = github_report.fitted_font(draw, title, 790)
        self.assertLessEqual(draw.textbbox((0, 0), title, font=selected)[2], 790)


if __name__ == "__main__":
    unittest.main()

