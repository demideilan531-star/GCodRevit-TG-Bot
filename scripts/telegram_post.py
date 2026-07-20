#!/usr/bin/env python3
"""Publish text, photo+text, or video+text posts to Telegram."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
MESSAGE_LIMIT = 3900
CAPTION_LIMIT = 1000


class TelegramPostError(RuntimeError):
    pass


def split_text(text: str, limit: int) -> list[str]:
    text = text.strip()
    if not text:
        return []

    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break

        cut = max(
            remaining.rfind("\n\n", 0, limit + 1),
            remaining.rfind("\n", 0, limit + 1),
            remaining.rfind(" ", 0, limit + 1),
        )
        if cut < int(limit * 0.55):
            cut = limit

        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()

    return chunks


def read_text(args: argparse.Namespace) -> str:
    values = []
    if args.text:
        values.append(args.text)
    if args.text_file:
        values.append(Path(args.text_file).read_text(encoding="utf-8"))

    text = "\n\n".join(value.strip() for value in values if value and value.strip())
    if not text:
        raise TelegramPostError("Post text is empty.")
    return text


def post_json(token: str, method: str, payload: dict[str, str]) -> dict:
    data = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        TELEGRAM_API.format(token=token, method=method),
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    return send_request(request)


def post_multipart(
    token: str,
    method: str,
    fields: dict[str, str],
    file_field: str,
    file_path: Path,
    content_type: str,
) -> dict:
    boundary = "----codex-telegram-" + uuid.uuid4().hex
    parts: list[bytes] = []

    for name, value in fields.items():
        if value is None:
            continue
        parts.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )

    filename = file_path.name or "media"
    parts.extend(
        [
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="{file_field}"; '
                f'filename="{filename}"\r\n'
            ).encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            file_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )

    request = urllib.request.Request(
        TELEGRAM_API.format(token=token, method=method),
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    return send_request(request)


def send_request(request: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        raise TelegramPostError(f"Telegram request failed: {exc.reason}") from exc

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise TelegramPostError(f"Telegram returned non-JSON response: {raw[:200]}") from exc

    if payload.get("ok") is not True:
        raise TelegramPostError(payload.get("description") or "Telegram returned ok=false.")

    message_id = payload.get("result", {}).get("message_id")
    if not message_id:
        raise TelegramPostError("Telegram did not return result.message_id.")
    return payload


def download_media(url: str, suffix: str) -> Path:
    target = Path(tempfile.gettempdir()) / f"telegram-post-{uuid.uuid4().hex}{suffix}"
    request = urllib.request.Request(url, headers={"User-Agent": "GCodRevit-TG-Bot/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            with target.open("wb") as handle:
                shutil.copyfileobj(response, handle)
    except urllib.error.URLError as exc:
        raise TelegramPostError(f"Media download failed: {exc.reason}") from exc

    if target.stat().st_size == 0:
        raise TelegramPostError("Downloaded media file is empty.")
    return target


def prepare_media(media_type: str, media_url: str | None, media_path: str | None) -> Path:
    if media_url and media_path:
        raise TelegramPostError("Use either media_url or repository_path, not both.")
    if not media_url and not media_path:
        raise TelegramPostError(f"{media_type} post requires media_url or repository_path.")

    if media_path:
        path = Path(media_path)
        if not path.exists():
            raise TelegramPostError(f"Media file does not exist: {media_path}")
        if not path.is_file():
            raise TelegramPostError(f"Media path is not a file: {media_path}")
        if path.stat().st_size == 0:
            raise TelegramPostError(f"Media file is empty: {media_path}")
        return path

    parsed = urllib.parse.urlparse(media_url or "")
    suffix = Path(parsed.path).suffix
    if not suffix:
        suffix = ".mp4" if media_type == "video" else ".jpg"
    return download_media(media_url or "", suffix)


def content_type_for(media_type: str, path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if media_type == "photo":
        allowed = {"image/jpeg", "image/png", "image/webp"}
        content_type = guessed or "application/octet-stream"
        if content_type not in allowed:
            raise TelegramPostError(
                f"Unsupported photo type: {content_type}. Use JPG, PNG, or WebP."
            )
        return content_type

    content_type = guessed or "application/octet-stream"
    if content_type not in {"video/mp4", "application/octet-stream"}:
        raise TelegramPostError(f"Unsupported video type: {content_type}. Use MP4.")
    return "video/mp4"


def verify_video(path: Path) -> None:
    if shutil.which("ffprobe") is None:
        print("ffprobe is not available; skipping MP4 metadata check.", file=sys.stderr)
        return

    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size",
            "-of",
            "default=noprint_wrappers=1",
            str(path),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise TelegramPostError(f"ffprobe could not read video: {result.stderr.strip()}")
    print(result.stdout.strip())


def validate_result(payload: dict, post_type: str) -> int:
    result = payload.get("result", {})
    message_id = result.get("message_id")
    if post_type == "photo" and "photo" not in result:
        raise TelegramPostError("Telegram response has no result.photo.")
    if post_type == "video" and "video" not in result:
        raise TelegramPostError("Telegram response has no result.video.")
    return int(message_id)


def common_fields(chat_id: str, parse_mode: str | None, disable_notification: bool) -> dict[str, str]:
    fields = {"chat_id": chat_id}
    if parse_mode:
        fields["parse_mode"] = parse_mode
    if disable_notification:
        fields["disable_notification"] = "true"
    return fields


def publish_text(token: str, chat_id: str, text: str, parse_mode: str | None, disable_notification: bool) -> list[int]:
    message_ids = []
    for chunk in split_text(text, MESSAGE_LIMIT):
        payload = common_fields(chat_id, parse_mode, disable_notification)
        payload["text"] = chunk
        message_ids.append(validate_result(post_json(token, "sendMessage", payload), "text"))
    return message_ids


def publish_media(
    token: str,
    chat_id: str,
    post_type: str,
    text: str,
    media_path: Path,
    parse_mode: str | None,
    disable_notification: bool,
) -> list[int]:
    content_type = content_type_for(post_type, media_path)
    if post_type == "video":
        verify_video(media_path)

    chunks = split_text(text, CAPTION_LIMIT)
    caption = chunks[0] if chunks else ""
    method = "sendPhoto" if post_type == "photo" else "sendVideo"
    file_field = "photo" if post_type == "photo" else "video"

    fields = common_fields(chat_id, parse_mode, disable_notification)
    if caption:
        fields["caption"] = caption
    if post_type == "video":
        fields["supports_streaming"] = "true"

    message_ids = [
        validate_result(
            post_multipart(token, method, fields, file_field, media_path, content_type),
            post_type,
        )
    ]

    for chunk in split_text("\n\n".join(chunks[1:]), MESSAGE_LIMIT):
        payload = common_fields(chat_id, parse_mode, disable_notification)
        payload["text"] = chunk
        message_ids.append(validate_result(post_json(token, "sendMessage", payload), "text"))

    return message_ids


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish a Telegram channel post.")
    parser.add_argument("--type", choices=["text", "photo", "video"], required=True)
    parser.add_argument("--text", default="")
    parser.add_argument("--text-file")
    parser.add_argument("--media-url")
    parser.add_argument("--repository-path")
    parser.add_argument("--parse-mode", choices=["", "HTML", "MarkdownV2"], default="")
    parser.add_argument("--disable-notification", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token:
        raise TelegramPostError("TELEGRAM_BOT_TOKEN secret is not set.")
    if not chat_id:
        raise TelegramPostError("TELEGRAM_CHAT_ID secret is not set.")

    text = read_text(args)
    parse_mode = args.parse_mode or None

    if args.type == "text":
        message_ids = publish_text(token, chat_id, text, parse_mode, args.disable_notification)
    else:
        media_path = prepare_media(args.type, args.media_url, args.repository_path)
        message_ids = publish_media(
            token,
            chat_id,
            args.type,
            text,
            media_path,
            parse_mode,
            args.disable_notification,
        )

    print(f"Telegram accepted {args.type} post. message_ids={','.join(map(str, message_ids))}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TelegramPostError as exc:
        print(f"Telegram publication failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
