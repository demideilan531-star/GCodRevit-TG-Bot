import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont


TIMEZONE = ZoneInfo(os.getenv("REPORT_TIMEZONE", "Europe/Moscow"))
IMAGE_PATH = Path(os.getenv("GITHUB_IMAGE_PATH", "/tmp/github_report.png"))
CAPTION_PATH = Path(os.getenv("GITHUB_CAPTION_PATH", "/tmp/github_caption.txt"))

BACKGROUND = "#08131f"
PANEL = "#10263a"
PANEL_ALT = "#123451"
INK = "#f5f7fa"
MUTED = "#9fb2c3"
CYAN = "#4cb7e8"
GREEN = "#58d49b"
CORAL = "#ff755f"
YELLOW = "#ffc857"
PURPLE = "#9d82ff"

JOKES = (
    "Пока кто-то считает клики, мы считаем коммиты.",
    "Репозиторий проверен. Ручная археология снова не понадобилась.",
    "Код сам себя не проверит. Поэтому мы уже проверили.",
    "Изменения рази�-�G����ƭy�& inputs.notify_chat_id != '' }}
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          NOTIFY_CHAT_ID: ${{ inputs.notify_chat_id }}
          REPORT_SENT: ${{ steps.publish_report.outcome == 'success' }}
        run: |
          set -euo pipefail
          if [ "$REPORT_SENT" = "true" ]; then
            message="✅ Отчёт по GitHub опубликован в канале."
          else
            message="❌ Не удалось опубликовать отчёт по GitHub. Проверь GitHub Actions."
          fi
          curl --silent --show-error --fail-with-body \
            --connect-timeout 20 \
            --max-time 60 \
            --request POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${NOTIFY_CHAT_ID}" \
            --data-urlencode "text=${message}" \
            > /tmp/github_notify_response.json
