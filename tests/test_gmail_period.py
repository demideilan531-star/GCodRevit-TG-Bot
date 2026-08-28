import importlib.util
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "hourly_gmail_report.py"
SPEC = importlib.util.spec_from_file_location("gmail_report_period_test", MODULE_PATH)
REPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORT)


class GmailPeriodTests(unittest.TestCase):
    def test_explicit_broker_period_has_priority(self):
        now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        with patch.dict(os.environ, {"GMAIL_SINCE_UTC": "2026-08-28T08:15:00Z"}):
            self.assertEqual(
                REPORT.report_start(now, {"updated_at": "2026-08-28T10:00:00Z"}),
                datetime(2026, 8, 28, 8, 15, tzinfo=timezone.utc),
            )

    def test_previous_successful_state_is_used_without_broker_period(self):
        now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        with patch.dict(os.environ, {"GMAIL_SINCE_UTC": ""}):
            self.assertEqual(
                REPORT.report_start(now, {"updated_at": "2026-08-28T09:30:00+00:00"}),
                datetime(2026, 8, 28, 9, 30, tzinfo=timezone.utc),
            )

    def test_first_report_uses_configured_fallback(self):
        now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        with patch.dict(os.environ, {"GMAIL_SINCE_UTC": ""}):
            self.assertEqual(REPORT.report_start(now, {}), now - timedelta(minutes=REPORT.MINUTES))


if __name__ == "__main__":
    unittest.main()

