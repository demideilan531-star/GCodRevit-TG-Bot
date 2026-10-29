"""Dormant local bootstrap. Never invoke from CI, chat automation or the runner.

Only a person in a private interactive terminal may start a QR authorization.
No phone/code fallback, automatic retries, session printing or secret upload.
"""

import argparse
import asyncio
import csv
import ctypes
import getpass
import io
import logging
import os
from pathlib import Path
import re
import subprocess
import sys

from telethon import TelegramClient, errors
from telethon.sessions import StringSession

try:
    from .telegram_account_sync import SafeError, integer
except ImportError:
    from telegram_account_sync import SafeError, integer


def require_local_terminal(env, stdin, stdout):
    if env.get("CI") or env.get("GITHUB_ACTIONS") or not stdin.isatty() or not stdout.isatty():
        raise SafeError("interactive_local_terminal_required")


def local_config(env):
    try:
        api_id = integer(int(env.get("TELEGRAM_API_ID", "")), 1, 2147483647)
        owner = integer(int(env.get("TELEGRAM_ACCOUNT_OWNER_ID", "")), 1)
        api_hash = env.get("TELEGRAM_API_HASH", "")
        if not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
            raise ValueError()
    except (TypeError, ValueError):
        raise SafeError("local_credentials_missing") from None
    return api_id, api_hash, owner


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or str(path).startswith("\\\\"):
        raise SafeError("local_absolute_path_required")
    path = path.resolve()
    if path.exists() or not path.parent.is_dir():
        raise SafeError("new_directory_required")
    if Path.home().resolve() not in path.parents:
        raise SafeError("user_local_directory_required")
    if any((p / ".git").exists() for p in path.parents):
        raise SafeError("session_in_repository_forbidden")
    if any(p.lower() in ("onedrive", "dropbox", "google drive", "icloud") for p in path.parts):
        raise SafeError("cloud_sync_directory_forbidden")
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        kernel.GetDriveTypeW.restype = ctypes.c_uint
        if kernel.GetDriveTypeW(path.anchor) != 3:  # Fixed, local volume only.
            raise SafeError("local_fixed_volume_required")
    path.mkdir(mode=0o700)
    if os.name == "nt":
        system = Path(os.environ["SystemRoot"]) / "System32"
        result = subprocess.run([str(system / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        rows = list(csv.reader(io.StringIO(result.stdout.decode("utf-8", errors="replace"))))
        sid = rows[-1][-1] if rows else ""
        if not re.fullmatch(r"S-1-[0-9-]+", sid):
            raise SafeError("local_acl_failed")
        # The new directory has no explicit inherited grants to preserve.
        subprocess.run([str(system / "icacls.exe"), str(path), "/inheritance:r",
                        "/grant:r", "*" + sid + ":(OI)(CI)F"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        path.chmod(0o700)
    return path


def dpapi_encrypt(data):
    """Current Windows user/machine only; no plaintext auth key on disk."""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt.CryptProtectData.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR,
                                     ctypes.POINTER(Blob), ctypes.c_void_p,
                                     ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptProtectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), buffer)
    target = Blob()
    try:
        if not crypt.CryptProtectData(ctypes.byref(source), "GCod Telegram session", None,
                                      None, None, 1, ctypes.byref(target)):
            raise SafeError("local_encryption_failed")
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.memset(buffer, 0, len(data))
        if target.data:
            kernel.LocalFree(target.data)


def write_private_session(directory, session):
    data = session.encode("ascii")
    if os.name == "nt":
        data = dpapi_encrypt(data)
        name = "session.dpapi"
    else:
        name = "session.txt"
    path = directory / name
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def show_qr(url):
    # The QR is displayed only to the local person, never returned to a broker,
    # written to an image file or emitted in Actions/chat logs.
    import qrcode
    qr = qrcode.QRCode(border=4)
    qr.add_data(url)
    qr.make(fit=True)
    qr.print_ascii(tty=False, invert=True)


async def authorize(api_id, api_hash, owner, directory):
    session = StringSession()
    client = TelegramClient(session, api_id, api_hash, receive_updates=True,
                            flood_sleep_threshold=0, request_retries=0,
                            connection_retries=1, auto_reconnect=False, timeout=10)
    try:
        await client.connect()
        qr = await client.qr_login()
        print("Scan locally in Telegram Settings / Devices. Do not share or record this QR.")
        show_qr(qr.url)
        try:
            await qr.wait(timeout=60)
        except errors.SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password (hidden): ")
            try:
                await client.sign_in(password=password)
            finally:
                password = None
        me = await client.get_me()
        if me is None or me.id != owner or getattr(me, "bot", False):
            raise SafeError("owner_mismatch")
        await client.set_receive_updates(False)
        write_private_session(directory, session.save())
    finally:
        await asyncio.wait_for(client.disconnect(), 5)


def main(argv=None):
    logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser(description="Private local QR bootstrap; never use in CI.")
    parser.add_argument("--start-qr", action="store_true", help="Explicitly start one local QR attempt")
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="New private local directory, outside repositories and cloud-sync folders")
    args = parser.parse_args(argv)
    try:
        require_local_terminal(os.environ, sys.stdin, sys.stdout)
        if not args.start_qr:
            raise SafeError("explicit_qr_start_required")
        config = local_config(os.environ)
        if input("Type AUTHORIZE to create a local Telegram device session: ") != "AUTHORIZE":
            raise SafeError("authorization_not_confirmed")
        directory = private_directory(args.output_dir)
        asyncio.run(asyncio.wait_for(authorize(*config, directory), timeout=120))
    except (Exception, KeyboardInterrupt):
        print("Local authorization not completed. No sync enabled. Check Telegram Devices for a new session.")
        return 1
    print("Local session saved privately. Nothing uploaded; account sync remains disabled.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
