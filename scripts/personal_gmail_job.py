import imaplib
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = Path("/tmp/personal_gmail_state.json")
REPORT_PATH = Path("/tmp/personal_gmail_report.txt")
IMAGE_PATH = Path("/tmp/personal_gmail_report.png")
CAPTION_PATH = Path("/tmp/personal_gmail_caption.txt")


def broker_request(path, payload):
    base_url = os.environ["GMAIL_BROKER_URL"].rstrip("/")
    token = os.environ["GMAIL_BROKER_TOKEN"]
    request = Request(
        f"{base_url}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "GCodRevit-Personal-Gmail-Workflow",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Gmail broker returned HTTP {error.code}") from error


def mask(value):
    if value:
        print(f"::add-mask::{value}")


def validate_login(account, password):
    mailbox = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    try:
        mailbox.login(account, password)
    finally:
        try:
            mailbox.logout()
        except Exception:
            pass


def load_report_module(claim):
    os.environ.update(
        {
            "GMAIL_EMAIL": claim["email"],
            "GMAIL_APP_PASSWORD": claim["app_password"],
            "GMAIL_STATE_PATH": str(STATE_PATH),
            "GMAIL_REPORT_PATH": str(REPORT_PATH),
            "GMAIL_IMAGE_PATH": str(IMAGE_PATH),
            "GMAIL_CAPTION_PATH": str(CAPTION_PATH),
            "GMAIL_SINCE_UTC": claim.get("since_utc") or "",
            "REPORT_TIMEZONE": "Europe/Moscow",
            "ONE_TIME_LABEL": "Одноразовые письма",
        }
    )
    STATE_PATH.write_text(
        json.dumps(claim.get("state") or {"uids": [], "uidvalidity": None}, ensure_ascii=False),
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location(
        "personal_hourly_gmail_report", ROOT / "scripts" / "hourly_gmail_report.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def telegram_send_photo(chat_id):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    boundary = f"----gcod-{uuid.uuid4().hex}"
    caption = CAPTION_PATH.read_text(encoding="utf-8")
    photo = IMAGE_PATH.read_bytes()
    parts = []

    def field(name, value):
        parts.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )

    field("chat_id", chat_id)
    field("caption", caption)
    parts.extend(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="photo"; filename="gmail-report.png"\r\n',
            b"Content-Type: image/png\r\n\r\n",
            photo,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    request = Request(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urlopen(request, timeout=120) as response:
        result = json.load(response)
    if result.get("ok") is not True:
        raise RuntimeError("Telegram did not accept the Gmail report")


def build_and_send_report(claim):
    report = load_report_module(claim)
    items, archived, warnings, cutoff = report.fetch()
    text, metrics, conclusion, action = report.build(items, archived, warnings, cutoff)
    REPORT_PATH.write_text(text, encoding="utf-8")
    report.render(text, metrics, conclusion, action)
    report.caption(text, metrics, conclusion, action)
    telegram_send_photo(claim["chat_id"])
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def main():
    request_id = os.environ["GMAIL_REQUEST_ID"]
    claim = broker_request("/internal/gmail/claim", {"request_id": request_id})
    mask(claim.get("email"))
    mask(claim.get("app_password"))
    try:
        if claim["kind"] == "validate":
            validate_login(claim["email"], claim["app_password"])
            state = None
        elif claim["kind"] == "report":
            state = build_and_send_report(claim)
        else:
            raise RuntimeError("Unknown Gmail request kind")
        payload = {"request_id": request_id, "success": True}
        if state is not None:
            payload["state"] = state
        broker_request("/internal/gmail/complete", payload)
    except Exception as error:
        try:
            broker_request(
                "/internal/gmail/complete",
                {"request_id": request_id, "success": False, "error": str(error)[:500]},
            )
        finally:
            raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Personal Gmail job failed: {error}", file=sys.stderr)
        raise SystemExit(1)

