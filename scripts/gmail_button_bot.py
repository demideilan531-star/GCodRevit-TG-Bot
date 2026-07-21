#!/usr/bin/env python3
"""Telegram polling bot with one Gmail report button.

The button starts the existing GitHub Actions workflow that analyzes Gmail,
builds the report image, and publishes the photo+caption post to Telegram.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


BUTTON_GMAIL = "📬 Отчёт Gmail"
BUTTON_GITHUB = "🧩 GitHub"
BUTTON_VIDEO = "🎬 Видео GCodRevit"
BUTTON_WEATHER = "🌤 Погода"
DEFAULT_REPOSITORY = "demideilan531-star/GCodRevit-TG-Bot"
DEFAULT_WORKFLOW = "hourly-gmail-telegram.yml"
DEFAULT_REF = "main"


class BotError(RuntimeError):
    pass


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def telegram_request(token: str, method: str, payload: dict) -> dict:
    data = urllib.parse.urlencode(
        {
            key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value
            for key, value in payload.items()
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.loads(response.read().decode("utf-8"))
    if result.get("ok") is not True:
        raise BotError(result.get("description") or f"Telegram {method} failed")
    return result


def send_message(token: str, chat_id: int | str, text: str, with_keyboard: bool = True) -> None:
    payload: dict = {"chat_id": str(chat_id), "text": text}
    if with_keyboard:
        payload["reply_markup"] = {
            "keyboard": [
                [{"text": BUTTON_GMAIL}, {"text": BUTTON_GITHUB}],
                [{"text": BUTTON_VIDEO}, {"text": BUTTON_WEATHER}],
            ],
            "resize_keyboard": True,
            "one_time_keyboard": False,
            "is_persistent": True,
        }
    telegram_request(token, "sendMessage", payload)


def get_updates(token: str, offset: int | None) -> list[dict]:
    payload: dict = {"timeout": "50", "allowed_updates": json.dumps(["message"])}
    if offset is not None:
        payload["offset"] = str(offset)
    return telegram_request(token, "getUpdates", payload).get("result", [])


def parse_admin_ids(raw: str) -> set[int]:
    if not raw:
        return set()
    admin_ids: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part:
            admin_ids.add(int(part))
    return admin_ids


def is_allowed(user_id: int, admin_ids: set[int], allow_all_users: bool) -> bool:
    return allow_all_users or user_id in admin_ids


def dispatch_gmail_workflow(notify_chat_id: int | str) -> None:
    github_token = env("GITHUB_TOKEN") or env("GH_PAT")
    if not github_token:
        raise BotError("Не задан GITHUB_TOKEN или GH_PAT для запуска GitHub Actions.")

    repository = env("GITHUB_REPOSITORY", DEFAULT_REPOSITORY)
    workflow = env("GMAIL_WORKFLOW_ID", DEFAULT_WORKFLOW)
    ref = env("GITHUB_REF", DEFAULT_REF)
    body = json.dumps(
        {
            "ref": ref,
            "inputs": {
                "notify_chat_id": str(notify_chat_id),
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/actions/workflows/{workflow}/dispatches",
        data=body,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {github_token}",
            "Content-Type": "application/json",
            "User-Agent": "GCodRevit-TG-Bot",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            if response.status != 204:
                raise BotError(f"GitHub вернул неожиданный статус: {response.status}")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise BotError(f"GitHub не запустил workflow: HTTP {exc.code}; {details[:500]}") from exc
    except urllib.error.URLError as exc:
        raise BotError(f"GitHub недоступен: {exc.reason}") from exc


def handle_message(
    token: str,
    message: dict,
    admin_ids: set[int],
    allow_all_users: bool,
    cooldown: dict[int, float],
) -> None:
    chat = message.get("chat") or {}
    user = message.get("from") or {}
    chat_id = chat.get("id")
    user_id = user.get("id")
    text = (message.get("text") or "").strip()
    if chat_id is None or user_id is None:
        return

    if not is_allowed(int(user_id), admin_ids, allow_all_users):
        send_message(token, chat_id, "У тебя нет доступа к запуску публикаций.", with_keyboard=False)
        return

    if text in {"/start", "/menu"}:
        send_message(
            token,
            chat_id,
            "Выбери действие на клавиатуре. Сейчас полностью подключена кнопка почты.",
        )
        return

    if text == BUTTON_GITHUB:
        send_message(
            token,
            chat_id,
            "Кнопка GitHub добавлена. Следующий шаг — подключить анализ репозитория и шаблон поста.",
        )
        return

    if text == BUTTON_VIDEO:
        send_message(
            token,
            chat_id,
            "Кнопка видео добавлена. Следующий шаг — подключить приём сырого видео и подготовку поста.",
        )
        return

    if text == BUTTON_WEATHER:
        send_message(
            token,
            chat_id,
            "Кнопка погоды добавлена. Следующий шаг — подключить анализ погоды, генерацию фото и пост в канал.",
        )
        return

    if text != BUTTON_GMAIL:
        send_message(token, chat_id, "Выбери действие кнопкой под строкой ввода.")
        return

    cooldown_seconds = int(env("GMAIL_BUTTON_COOLDOWN_SECONDS", "300"))
    now = time.time()
    previous = cooldown.get(int(user_id), 0)
    if now - previous < cooldown_seconds:
        left = int(cooldown_seconds - (now - previous))
        send_message(token, chat_id, f"Отчёт уже запускался недавно. Повтори через {left} сек.")
        return

    cooldown[int(user_id)] = now
    try:
        dispatch_gmail_workflow(chat_id)
    except BotError:
        cooldown.pop(int(user_id), None)
        raise
    send_message(token, chat_id, "Отправлен запрос на отчёт.")


def main() -> int:
    token = env("TELEGRAM_BOT_TOKEN")
    if not token:
        raise BotError("Не задан TELEGRAM_BOT_TOKEN.")

    admin_ids = parse_admin_ids(env("TELEGRAM_ADMIN_IDS"))
    allow_all_users = env("TELEGRAM_ALLOW_ALL_USERS", "false").lower() == "true"
    if not admin_ids and not allow_all_users:
        raise BotError("Не задан TELEGRAM_ADMIN_IDS. Для публичного доступа явно задай TELEGRAM_ALLOW_ALL_USERS=true.")

    offset: int | None = None
    cooldown: dict[int, float] = {}
    if env("TELEGRAM_DELETE_WEBHOOK_ON_START", "true").lower() == "true":
        telegram_request(token, "deleteWebhook", {"drop_pending_updates": "false"})
    print("Gmail button bot is running.", flush=True)

    while True:
        try:
            for update in get_updates(token, offset):
                offset = int(update["update_id"]) + 1
                message = update.get("message")
                if message:
                    try:
                        handle_message(token, message, admin_ids, allow_all_users, cooldown)
                    except Exception as exc:
                        chat_id = (message.get("chat") or {}).get("id")
                        if chat_id is not None:
                            send_message(token, chat_id, f"Не удалось запустить отчёт: {exc}", with_keyboard=True)
                        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"Polling error: {exc}", file=sys.stderr, flush=True)
            time.sleep(5)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BotError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
