import sys
import unittest
import uuid
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import github_report


SAMPLE = {
    "mode": "changes",
    "variant": "default",
    "repository": "demideilan531-star/GCod-",
    "branch": "main",
    "generated_at": "2026-08-14T12:00:00Z",
    "head_sha": "28dde2a425860f5884b34d38cd1c3b5d6267822f",
    "commits_count": 1,
    "files_changed": 781,
    "additions": 126712,
    "deletions": 0,
    "areas": [
        {"name": "Revit-плагин", "count": 334},
        {"name": "AI", "count": 210},
        {"name": "Desktop и обновления", "count": 129},
    ],
    "highlights": [
        "Импортирована основная архитектура проекта.",
        "Добавлены локальные AI-модули и проверяемые контракты.",
    ],
}


class GithubReportTests(unittest.TestCase):
    def test_normalize_limits_public_text(self):
        report = github_report.normalize_report(
            {**SAMPLE, "highlights": ["x" * 200] * 8, "files_changed": "100+"}
        )
        self.assertEqual(report["files_changed"], "100+")
        self.assertLessEqual(len(report["highlights"]), 4)
        self.assertTrue(report["highlights"][0].endswith("…"))

    def test_builds_telegram_assets(self):
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
                self.assertEqual(image.size, (1200, 900))
            caption = github_report.CAPTION_PATH.read_text(encoding="utf-8")
            self.assertLessEqual(len(caption), 1024)
            self.assertIn("Мы это руками не делаем.", caption)
        finally:
            github_report.IMAGE_PATH = old_image
            github_report.CAPTION_PATH = old_caption
            image_path.unlink(missing_ok=True)
            caption_path.unlink(missing_ok=True)

    def test_large_metric_value_fits_card(self):
        image = Image.new("RGB", (400, 200))
        draw = github_report.ImageDraw.Draw(image)
        value = "+126 712 / -0"
        selected = github_report.fitted_font(draw, value, 284)

        self.assertLessEqual(draw.textbbox((0, 0), value, font=selected)[2], 284)


if __name__ == "__main__":
    unittest.main()

