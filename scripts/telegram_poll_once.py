#!/usr/bin/env python3
"""Poll Telegram once and answer bot commands from GitHub Actions."""

from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


BUTTON_GMAIL = "📬 Отчёт Gmail"
BUTTON_GITHUB = "🧩 GitHub"
BUTTON_VIDEO = "🎬 Видео GCodRevit"
BUTTON_WEATHER = "🌤 Погода"
STATE_PATH = pathlib.Path("bot-state/telegram-offset.txt")


class BotError(RuntimeError):
    pass


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def api(token: str, method: str, payload: dict | None = None) -> dict:
    payload = payload or {}
    data = urllib.parse.urlencode(
        {
            key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
            for key, value in payload.items()
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        result = json.loads(response.read().decode("utf-8"))
    if result.get("ok") is not True:
        raise BotError(result.get("description") or f"Telegram {method} failed")
    return result


def keyboard() -> dict:
    return {
        "keyboard": [
            [{"text": BUTTON_GMAIL}, {"text": BUTTON_GITHUB}],
            [{"text": BUTTON_VIDEO}, {"text": BUTTON_WEATHER}],
        ],
        "resize_keyboard": True,
        "one_time_keyboard": False,
        "is_persistent": True,
    }


def send_message(token: str, chat_id: int | str, text: str, with_keyboard: bool = True) -> None:
    payload: dict = {"chat_id": chat_id, "text": text}
    if with_keyboard:
        payload["reply_markup"] = keyboard()
    api(token, "sendMessage", payload)


def read_offset() -> int | None:
    if not STATE_PATH.exists():
        return None
    raw = STATE_PATH.read_text(encoding="utf-8").strip()
    return int(raw) if raw else None


def write_offset(offset: int) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(f"{offset}\n", encoding="utf-8")


def parse_admin_ids(raw: str) -> set[int]:
    result: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part:
            result.add(int(part))
    return result


def dispatch_gmail_workflow(chat_id: int | str) -> None:
    token = env("GH_PAT") or env("GITHUB_TOKEN")
    repo = env("GITHUB_REPOSITORY", "demideilan531-star/GCodRevit-TG-Bot")
    workflow = env("GMAIL_WORKFLOW_ID", "hourly-gmail-telegram.yml")
    ref = env("GITHUB_REF_NAME", "main")
    if not token:
        raise BotError("Не задан GitHub token для запуска отчёта.")

    body = json.dumps({"ref": ref, "inputs": {"notify_chat_id": str(chat_id)}}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches",
        data=body,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "GCodRevit-TG-Bot",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            if response.status != 204:
                raise BotError(f"GitHub вернул статус {response.status}")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise BotError(f"GitHub не запустил отчёт: HTTP {exc.code}; {details[:300]}") from exc


def handle_message(token: str, message: dict, admin_ids: set[int]) -> None:
    chat = message.get("chat") or {}
    user = message.get("from") or {}
    chat_id = chat.get("id")
    user_id = user.get("id")
    text = (message.get("text") or "").strip()
    if chat_id is None or user_id is None:
        return
    if int(user_id) not in admin_ids:
        send_message(token, chat_id, "У тебя нет доступа к запуску публикаций.", with_keyboard=False)
        return

    if text in {"/start", "/menu"}:
        send_message(token, chat_id, "Выбери действие на клавиатуре. Сейчас полностью подключена кнопка почты.")
    elif text == BUTTON_GMAIL:
        send_message(token, chat_id, "Отправлен запрос на отчёт.")
        dispatch_gmail_workflow(chat_id)
    elif text == BUTTON_GITHUB:
        send_message(token, chat_id, "Кнопка GitHub добавлена. Следующий шаг - подключить анализ репозитория и шаблон поста.")
    elif text == BUTTON_VIDEO:
        send_message(token, chat_id, "Кнопка видео добавлена. Следующий шаг - подключить приём сырого видео и подготовку поста.")
    elif text == BUTTON_WEATHER:
        send_message(token, chat_id, "Кнопка погоды добавлена. Следующий шаг - подключить анализ погоды, генерацию фото и пост в канал.")
    else:
        send_message(token, chat_id, "Выбери действие кнопкой под строкой ввода.")


def main() -> int:
    token = env("TELEGRAM_BOT_TOKEN")
    admin_ids = parse_admin_ids(env("TELEGRAM_ADMIN_IDS", "1839693017"))
    if not token:
        raise BotError("Не задан TELEGRAM_BOT_TOKEN.")

    api(token, "deleteWebhook", {"drop_pending_updates": "false"})

    offset = read_offset()
    payload: dict = {"timeout": 0, "allowed_updates": ["message"]}
    if offset is not None:
        payload["offset"] = offset
    updates = api(token, "getUpdates", payload).get("result", [])
    print(f"Updates: {len(updates)}")

    next_offset = offset
    for update in updates:
        next_offset = int(update["update_id"]) + 1
        message = update.get("message")
        if not message:
            continue
        try:
            handle_message(token, message, admin_ids)
        except Exception as exc:
            chat_id = (message.get("chat") or {}).get("id")
            if chat_id is not None:
                send_message(token, chat_id, f"Не удалось выполнить действие: {exc}")
            print(f"ERROR: {exc}", file=sys.stderr)
        time.sleep(0.2)

    if next_offset is not None:
        write_offset(next_offset)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
