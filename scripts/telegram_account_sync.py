"""Read-only, lease-bound account archive client. No interactive authorization.

All persistent progress belongs to the broker, not to Telethon's StringSession.
Never include exceptions or remote objects in logs: they may contain account data.
"""

import asyncio
import base64
import copy
import hashlib
import json
import logging
import os
import re
import sys
import time
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from telethon import TelegramClient, __version__ as telethon_version, errors, functions, types, utils
from telethon.sessions import StringSession


MAX_JSON = 1024 * 1024
MAX_STATE = 16 * 1024
MAX_ID = 2147483647
PAGE = 50
ARRAYS = ("dialogs", "messages", "deleted", "global_deleted", "checkpoints")
COSTS = dict(dialogs=8, messages=12, deleted=12, global_deleted=12, checkpoints=4)
READ_RPCS = (
    functions.users.GetUsersRequest,
    functions.updates.GetStateRequest,
    functions.updates.GetDifferenceRequest,
    functions.updates.GetChannelDifferenceRequest,
    functions.messages.GetDialogsRequest,
    functions.messages.GetPinnedDialogsRequest,
    functions.messages.GetHistoryRequest,
)
UNAVAILABLE = (
    errors.ChannelPrivateError, errors.ChatAdminRequiredError,
    errors.PeerIdInvalidError, errors.ChannelInvalidError,
)


class SafeError(Exception):
    """Fixed-message failure; never wrap a remote exception's text."""


class StopRun(SafeError):
    def __init__(self, status="idle", retry_after_seconds=None):
        super().__init__(status)
        self.status = status
        self.retry_after_seconds = retry_after_seconds


class HttpFailure(SafeError):
    def __init__(self, status):
        super().__init__("http_failure")
        self.status = status


def json_bytes(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                      allow_nan=False).encode("ascii")


def integer(value, minimum=0, maximum=None):
    if isinstance(value, bool) or not isinstance(value, int):
        raise SafeError("invalid_integer")
    if value < minimum or (maximum is not None and value > maximum):
        raise SafeError("invalid_integer")
    return value


def chat_id(value, kind=None):
    if not isinstance(value, str) or not re.fullmatch(r"-?[1-9][0-9]{0,18}", value):
        raise SafeError("invalid_chat_id")
    number = int(value)
    if not -(1 << 63) <= number <= (1 << 63) - 1:
        raise SafeError("invalid_chat_id")
    if kind is not None:
        valid = ((kind in ("private", "bot", "saved") and number > 0) or
                 (kind == "group" and -1000000000000 < number < 0) or
                 (kind in ("channel", "supergroup") and number <= -1000000000000))
        if not valid:
            raise SafeError("invalid_chat_id_type")
    return value


def canonical(peer):
    return chat_id(str(utils.get_peer_id(peer)))


def text_value(value, limit):
    if not isinstance(value, str):
        return ""
    # Preserve message text, but not control/bidi/surrogate characters.
    value = unicodedata.normalize("NFC", value)
    result, units = [], 0
    for char in value:
        if char not in "\n\t" and unicodedata.category(char) in ("Cc", "Cf", "Cs"):
            continue
        width = 2 if ord(char) > 0xFFFF else 1
        if units + width > limit:
            break
        result.append(char)
        units += width
    return "".join(result)


def utc(value):
    if not isinstance(value, datetime):
        raise SafeError("invalid_date")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def from_utc(value):
    if not isinstance(value, str) or len(value) > 40:
        raise SafeError("invalid_date")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise SafeError("invalid_date")
    return result.astimezone(timezone.utc)


def state_size(value):
    if not isinstance(value, dict) or len(json_bytes(value)) > MAX_STATE:
        raise SafeError("invalid_state")
    def validate(item, depth=0):
        if depth > 16:
            raise SafeError("invalid_state")
        if isinstance(item, dict):
            for key, nested in item.items():
                if not isinstance(key, str) or re.search(
                        r"session|auth_key|api_hash|api_id|password|phone|token|secret", key, re.I):
                    raise SafeError("sensitive_state_key")
                validate(nested, depth + 1)
        elif isinstance(item, list):
            for nested in item:
                validate(nested, depth + 1)
    validate(value)
    return copy.deepcopy(value)


def write_cost(body):
    return 64 + sum(len(body.get(key, [])) * COSTS[key] for key in ARRAYS)


class Budget:
    def __init__(self, seconds=420, clock=time.monotonic, sleep=asyncio.sleep):
        self.clock = clock
        self.sleep = sleep
        self.end = clock() + min(max(seconds, 1), 450)

    def remaining(self):
        return self.end - self.clock()

    def check(self, reserve=15):
        if self.remaining() <= reserve:
            raise StopRun()

    async def wait(self, seconds):
        self.check(seconds + 15)
        await self.sleep(seconds)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpTransport:
    """No redirects, no HTTP debug logging, no error response-body retention."""

    async def request(self, method, url, headers, body, timeout):
        def send():
            req = Request(url, data=body, headers=headers, method=method)
            try:
                with build_opener(NoRedirect()).open(req, timeout=timeout) as response:
                    data = response.read(2 * MAX_JSON + 1)
                    if len(data) > 2 * MAX_JSON:
                        raise SafeError("response_too_large")
                    return response.status, data
            except HTTPError as exc:
                status = exc.code
                exc.close()
                return status, b""
            except (URLError, OSError, TimeoutError):
                raise HttpFailure(0) from None
        return await asyncio.to_thread(send)


def https_url(value, origin=False):
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.username or
            parts.password or parts.fragment or
            (origin and (parts.path not in ("", "/") or parts.query))):
        raise SafeError("invalid_https_url")
    return value.rstrip("/") if origin else value


class OidcTokens:
    """JWT exp is used only for early refresh; verification is the broker's job."""

    def __init__(self, transport, request_url, request_token, audience,
                 clock=time.monotonic, wall=time.time):
        self.transport = transport
        self.url = https_url(request_url)
        host = urlsplit(self.url).hostname
        if not host.endswith(".actions.githubusercontent.com"):
            raise SafeError("invalid_oidc_endpoint")
        self.request_token = request_token
        self.audience = audience
        self.clock, self.wall = clock, wall
        self.token = None
        self.refresh_at = 0

    async def get(self, force=False):
        if self.token and not force and self.clock() < self.refresh_at:
            return self.token
        parts = urlsplit(self.url)
        query = [(k, v) for k, v in parse_qsl(parts.query) if k != "audience"]
        query.append(("audience", self.audience))
        url = urlunsplit(parts._replace(query=urlencode(query)))
        status, data = await self.transport.request(
            "GET", url, {"Authorization": "Bearer " + self.request_token}, None, 10)
        if status != 200:
            raise HttpFailure(status)
        try:
            token = json.loads(data)["value"]
            middle = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(middle + "=" * (-len(middle) % 4)))
            ttl = float(claims["exp"]) - self.wall() - 30
            if not isinstance(token, str) or not 0 < len(token) <= 16384 or ttl <= 0:
                raise ValueError()
        except (ValueError, KeyError, TypeError, IndexError):
            raise SafeError("invalid_oidc_response") from None
        self.token = token
        self.refresh_at = self.clock() + min(240, ttl)
        return token


class Broker:
    def __init__(self, origin, tokens, transport, budget):
        self.origin = https_url(origin, origin=True)
        self.tokens, self.transport, self.budget = tokens, transport, budget

    async def post(self, endpoint, body, finishing=False):
        if endpoint not in ("claim", "state", "batch", "finish", "heartbeat"):
            raise SafeError("invalid_endpoint")
        data = json_bytes(body)  # Frozen bytes, including batch_id, for every retry.
        if len(data) > MAX_JSON:
            raise SafeError("batch_too_large")
        refreshed = False
        for attempt in range(4):
            self.budget.check(2 if finishing else 15)
            url = self.origin + "/internal/account-context/" + endpoint
            signer = getattr(self.tokens, "headers", None)
            headers = (signer(url, data) if signer else
                       {"Authorization": "Bearer " + await self.tokens.get()})
            try:
                status, response = await self.transport.request(
                    "POST", url, {**headers, "Content-Type": "application/json"},
                    data, min(10, max(1, self.budget.remaining() - 1)))
            except HttpFailure:
                status, response = 0, b""
            if status == 401 and not refreshed and not signer:
                await self.tokens.get(force=True)
                refreshed = True
                continue
            if status in (429, 507):
                raise StopRun("quota")
            if status == 200:
                try:
                    result = json.loads(response)
                    if not isinstance(result, dict):
                        raise ValueError()
                    return result
                except (ValueError, TypeError):
                    raise SafeError("invalid_broker_response") from None
            if status not in (0, 408, 500, 502, 503, 504) or attempt == 3:
                raise HttpFailure(status)
            await self.budget.wait(2 ** attempt)
        raise SafeError("http_retry_exhausted")


class VerifiedClient(TelegramClient):
    """Also verifies get_me invoked internally by Telethon.connect()."""

    def __init__(self, owner, *args, **kwargs):
        self.owner = owner
        self.owner_verified = False
        super().__init__(*args, **kwargs)

    async def get_me(self, input_peer=False):
        if input_peer:
            raise SafeError("self_peer_not_allowed")
        me = await super().get_me()
        if me is None or me.id != self.owner or getattr(me, "bot", False):
            raise SafeError("owner_mismatch")
        self.owner_verified = True
        return me

    async def __call__(self, request, ordered=False, flood_sleep_threshold=None):
        if not isinstance(request, READ_RPCS):
            raise SafeError("rpc_not_allowed")
        if isinstance(request, functions.users.GetUsersRequest):
            if not all(isinstance(p, types.InputUserSelf) for p in request.id):
                raise SafeError("rpc_not_allowed")
        elif not self.owner_verified:
            raise SafeError("owner_not_verified")
        return await super().__call__(request, ordered=ordered, flood_sleep_threshold=0)


class ReadOnlyTelegram:
    def __init__(self, client, owner, budget):
        self.client, self.owner, self.budget = client, owner, budget
        self.verified = False
        self.last_call = -100.0

    async def connect(self):
        self.budget.check()
        await asyncio.wait_for(self.client.connect(), min(30, self.budget.remaining() - 15))
        me = await asyncio.wait_for(self.client.get_me(), min(30, self.budget.remaining() - 15))
        if me is None or me.id != self.owner or getattr(me, "bot", False):
            raise SafeError("owner_mismatch")
        self.verified = True

    async def rpc(self, request):
        if not self.verified or not isinstance(request, READ_RPCS):
            raise SafeError("rpc_not_allowed")
        self.budget.check()
        # At most one content RPC/second, sequentially, without speculative reads.
        delay = 1 - (self.budget.clock() - self.last_call)
        if delay > 0:
            await self.budget.wait(delay)
        self.last_call = self.budget.clock()
        try:
            return await asyncio.wait_for(self.client(request), min(30, self.budget.remaining() - 15))
        except errors.FloodWaitError as exc:
            raise StopRun("flood_wait", max(1, int(exc.seconds))) from None

    async def disconnect(self):
        await asyncio.wait_for(self.client.disconnect(), 5)


def entity_type(entity, owner):
    if isinstance(entity, (types.Channel, types.ChannelForbidden)):
        return "supergroup" if getattr(entity, "megagroup", False) else "channel"
    if isinstance(entity, (types.Chat, types.ChatForbidden)):
        return "group"
    if isinstance(entity, types.User):
        return "saved" if entity.id == owner else "bot" if entity.bot else "private"
    raise SafeError("unsupported_peer")


def display_name(entity, limit):
    if entity is None:
        return "[unknown]"
    value = getattr(entity, "title", None)
    if value is None:
        value = " ".join(filter(None, (getattr(entity, "first_name", ""),
                                       getattr(entity, "last_name", ""))))
    value = text_value(value, limit)
    return value if value.strip() else "[unknown]"


def ephemeral(value, depth=0):
    if value is None:
        return False
    if depth > 4:
        return True
    if any(getattr(value, key, None) is not None
           for key in ("ttl_period", "ttl_seconds", "expires_at", "expiration_date")):
        return True
    if any(bool(getattr(value, key, False)) for key in ("view_once", "ephemeral", "self_destruct")):
        return True
    if isinstance(value, types.MessageMediaStory):
        return True
    if ephemeral(getattr(value, "media", None), depth + 1):
        return True
    return any(ephemeral(item, depth + 1) for item in getattr(value, "extended_media", []) or [])


def normalize_message(message, entities):
    if isinstance(message, types.MessageEmpty):
        return None
    if not isinstance(message, (types.Message, types.MessageService)):
        raise SafeError("unsupported_message")
    mid = integer(message.id, 1, MAX_ID)
    peer = canonical(message.peer_id)
    if ephemeral(message):
        # Keep only enough metadata to advance the committed ID cursors. Never
        # retain self-destructing text, captions, sender names or media fields.
        return dict(chat_id=peer, message_id=mid, sender_name="[hidden]",
                    direction="outgoing" if message.out else "incoming",
                    content_type="ephemeral", body="[ephemeral]",
                    sent_at=utc(message.date), edited_at=None)
    sender = entities.get(canonical(message.from_id)) if message.from_id else None
    body = text_value(getattr(message, "message", ""), 6000)
    media = getattr(message, "media", None)
    markers = {
        "MessageMediaPhoto": "photo", "MessageMediaDocument": "document",
        "MessageMediaContact": "contact", "MessageMediaGeo": "location",
        "MessageMediaGeoLive": "location", "MessageMediaVenue": "location",
        "MessageMediaPoll": "poll", "MessageMediaDice": "dice",
        "MessageMediaGame": "game", "MessageMediaInvoice": "invoice",
        "MessageMediaStory": "story", "MessageMediaPaidMedia": "paid_media",
    }
    if isinstance(message, types.MessageService):
        kind, body = "service", "[service]"
    elif media is None or isinstance(media, (types.MessageMediaEmpty, types.MessageMediaWebPage)):
        kind = "text"
    else:
        kind = markers.get(type(media).__name__, "media")
        if not body.strip():
            body = "[" + kind + "]"
    if not body.strip():
        body = "[empty]"
    return dict(chat_id=peer, message_id=mid, sender_name=display_name(sender, 120),
                direction="outgoing" if message.out else "incoming", content_type=kind,
                body=body, sent_at=utc(message.date),
                edited_at=utc(message.edit_date) if getattr(message, "edit_date", None) else None)


def packed_peer(peer):
    if isinstance(peer, types.InputPeerSelf):
        return {"kind": "self"}
    if isinstance(peer, types.InputPeerUser):
        return dict(kind="user", id=str(peer.user_id), access_hash=str(peer.access_hash))
    if isinstance(peer, types.InputPeerChannel):
        return dict(kind="channel", id=str(peer.channel_id), access_hash=str(peer.access_hash))
    if isinstance(peer, types.InputPeerChat):
        return dict(kind="chat", id=str(peer.chat_id))
    raise SafeError("unsupported_input_peer")


def unpacked_peer(value):
    if not value:
        return types.InputPeerEmpty()
    kind = value.get("kind")
    if kind == "self":
        return types.InputPeerSelf()
    ident = integer(int(value["id"]), 1)
    if kind == "chat":
        return types.InputPeerChat(ident)
    access_hash = int(value["access_hash"])
    if kind == "user":
        return types.InputPeerUser(ident, access_hash)
    if kind == "channel":
        return types.InputPeerChannel(ident, access_hash)
    raise SafeError("invalid_peer_cursor")


@dataclass(repr=False)
class Config:
    api_id: int
    api_hash: str
    session: str
    owner: int
    origin: str
    audience: str
    oidc_url: str
    oidc_token: str

    @classmethod
    def from_env(cls, env):
        names = ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_USER_SESSION",
                 "TELEGRAM_ACCOUNT_OWNER_ID", "TELEGRAM_CONTEXT_BROKER_URL",
                 "TELEGRAM_CONTEXT_OIDC_AUDIENCE", "ACTIONS_ID_TOKEN_REQUEST_URL",
                 "ACTIONS_ID_TOKEN_REQUEST_TOKEN")
        if any(not env.get(n) for n in names):
            raise SafeError("configuration_missing")
        values = [env[n] for n in names]
        try:
            values[0] = integer(int(values[0]), 1, MAX_ID)
            values[3] = integer(int(values[3]), 1, (1 << 63) - 1)
        except (ValueError, TypeError):
            raise SafeError("invalid_configuration") from None
        if not re.fullmatch(r"[0-9a-fA-F]{32}", values[1]):
            raise SafeError("invalid_configuration")
        https_url(values[4], origin=True)
        return cls(*values)


class Runner:
    def __init__(self, telegram, broker, owner, budget, live_interval=None):
        self.tg, self.broker, self.owner, self.budget = telegram, broker, owner, budget
        self.lease = None
        self.generation = None
        self.quota = 0
        self.chats = {}
        self.entities = {}
        self.peers = {}
        self.index_records = {}
        self.update = {"v": 1}
        self.cursor = None
        self._gap_finish_body = None
        self.live_interval = live_interval
        self.last_live_check = budget.clock()
        self.retry_after_seconds = None
        self.last_http_status = None

    async def live_tick(self):
        if (self.live_interval is not None and 'global' in self.update and
                self.budget.clock() - self.last_live_check >= self.live_interval):
            self.last_live_check = self.budget.clock()
            await self.global_difference()

    async def batch(self, **parts):
        self.budget.check()
        body = dict(lease_id=self.lease, generation=self.generation,
                    batch_id=str(uuid.uuid4()), **parts)
        counts = [len(body.get(key, [])) for key in ARRAYS]
        if max(counts) > 100 or sum(counts) > 200 or len(json_bytes(body)) > MAX_JSON:
            raise SafeError("invalid_batch")
        for name in ("dialog_cursor", "update_state"):
            if name in parts.get("state", {}) and parts["state"][name] is not None:
                state_size(parts["state"][name])
        if write_cost(body) > self.quota:
            raise StopRun("quota")
        result = await self.broker.post("batch", body)
        if result.get("ok") is not True or result.get("batch_id") != body["batch_id"]:
            raise SafeError("invalid_batch_receipt")
        self.quota = integer(result.get("quota_remaining"))
        for dialog in parts.get("dialogs", []):
            self.chats.setdefault(dialog["chat_id"], {}).update(dialog)
        for checkpoint in parts.get("checkpoints", []):
            self.chats[checkpoint["chat_id"]].update(checkpoint)
        if "update_state" in parts.get("state", {}):
            self.update = copy.deepcopy(parts["state"]["update_state"])
        if "dialog_cursor" in parts.get("state", {}):
            self.cursor = copy.deepcopy(parts["state"]["dialog_cursor"])

    async def save_update(self, value):
        await self.batch(state={"update_state": state_size(value)})

    async def read_state(self):
        after = None
        while True:
            request = dict(lease_id=self.lease, generation=self.generation)
            if after is not None:
                request["after_chat_id"] = after
            result = await self.broker.post("state", request)
            rows = result.get("chats")
            if not isinstance(rows, list) or len(rows) > 200:
                raise SafeError("invalid_chat_state")
            for row in rows:
                cid = chat_id(row["chat_id"], row["chat_type"])
                self.chats[cid] = copy.deepcopy(row)
            next_id = result.get("next_chat_id")
            if next_id is None:
                break
            next_id = chat_id(next_id)
            if after is not None and next_id <= after:
                raise SafeError("nonadvancing_state_page")
            after = next_id

    def remember(self, result):
        for entity in list(getattr(result, "users", [])) + list(getattr(result, "chats", [])):
            try:
                cid = canonical(entity)
                self.entities[cid] = entity
                if int(cid) == self.owner:
                    self.peers[cid] = types.InputPeerSelf()
                else:
                    self.peers[cid] = utils.get_input_peer(entity)
            except (TypeError, ValueError):
                # Forbidden/min entities may lack an access hash. Never guess one.
                continue

    def dialog_record(self, dialog, result, folder):
        cid = canonical(dialog.peer)
        entity = self.entities.get(cid)
        kind = entity_type(entity, self.owner)
        top = integer(dialog.top_message, 0, MAX_ID)
        date = next((getattr(m, "date", None) for m in result.messages
                     if m.id == top and getattr(m, "peer_id", None) and
                     canonical(m.peer_id) == cid), None)
        return dict(chat_id=cid, chat_type=kind, chat_title=display_name(entity, 180),
                    archived=folder == 1, top_message_id=top,
                    last_message_at=utc(date) if date else None)

    async def store_dialogs(self, records, pts, force=False):
        for row in records:
            chat_id(row["chat_id"], row["chat_type"])
        if not force:
            records = [r for r in records if r["chat_id"] not in self.chats or
                       any(self.chats[r["chat_id"]].get(key) != r[key]
                           for key in ("chat_type", "top_message_id")) or
                       (r["chat_id"] in pts and
                        self.chats[r["chat_id"]].get("channel_pts") is None)]
        start = 0
        while start < len(records):
            end = min(start + 100, len(records))
            while end > start:
                selected = records[start:end]
                checkpoints = [dict(chat_id=r["chat_id"], channel_pts=pts[r["chat_id"]])
                               for r in selected if r["chat_id"] in pts and
                               self.chats.get(r["chat_id"], {}).get("channel_pts") is None]
                parts = dict(dialogs=selected, checkpoints=checkpoints)
                if write_cost(parts) <= self.quota:
                    break
                end -= 1
            if end == start:
                raise StopRun("quota")
            await self.batch(**parts)
            start = end

    async def discover(self, hydrate_only=False):
        cursor = None if hydrate_only else self.cursor
        cursor = state_size(cursor) if cursor else {"v": 1, "folder": 0, "phase": "pinned"}
        while cursor["folder"] < 2:
            folder = integer(cursor["folder"], 0, 1)
            pinned = cursor["phase"] == "pinned"
            if pinned:
                result = await self.tg.rpc(functions.messages.GetPinnedDialogsRequest(folder_id=folder))
            else:
                result = await self.tg.rpc(functions.messages.GetDialogsRequest(
                    offset_date=from_utc(cursor["date"]) if cursor.get("date") else None,
                    offset_id=integer(cursor.get("id", 0), 0, MAX_ID),
                    offset_peer=unpacked_peer(cursor.get("peer")),
                    limit=100, hash=0, exclude_pinned=True, folder_id=folder))
            self.remember(result)
            dialogs = [d for d in result.dialogs if isinstance(d, types.Dialog)]
            records = [self.dialog_record(d, result, folder) for d in dialogs]
            self.index_records.update((r["chat_id"], r) for r in records)
            pts = {canonical(d.peer): integer(d.pts) for d in dialogs
                   if getattr(d, "pts", None) is not None}
            if not hydrate_only:
                await self.store_dialogs(records, pts)
            if pinned:
                next_cursor = {"v": 1, "folder": folder, "phase": "page"}
            elif not dialogs:
                next_cursor = {"v": 1, "folder": folder + 1, "phase": "pinned"}
            else:
                last = dialogs[-1]
                cid = canonical(last.peer)
                record = records[-1]
                if last.top_message and record["last_message_at"] is None:
                    raise SafeError("dialog_offset_unavailable")
                next_cursor = dict(v=1, folder=folder, phase="page", id=last.top_message,
                                   date=record["last_message_at"], peer=packed_peer(self.peers[cid]))
                if next_cursor == cursor:
                    raise SafeError("nonadvancing_dialog_page")
            if not hydrate_only:
                done = next_cursor["folder"] == 2
                await self.batch(state=dict(dialogs_complete=done,
                                            dialog_cursor={} if done else next_cursor))
            cursor = next_cursor
            await self.live_tick()

    async def refresh_metadata(self):
        # /state deliberately omits titles/archive flags. A small rotating sweep
        # refreshes those without rewriting an entire stable account every run.
        after = self.update.get("metadata_after_chat_id", "")
        ids = sorted(self.index_records)
        ids = ([cid for cid in ids if cid > after] + [cid for cid in ids if cid <= after])[:25]
        if ids:
            await self.store_dialogs([self.index_records[cid] for cid in ids], {}, force=True)
            value = copy.deepcopy(self.update)
            value["metadata_after_chat_id"] = ids[-1]
            await self.save_update(value)

    async def ensure_dialog(self, cid):
        if cid in self.chats:
            return
        entity = self.entities.get(cid)
        if entity is None:
            raise SafeError("update_peer_unavailable")
        await self.store_dialogs([dict(chat_id=cid, chat_type=entity_type(entity, self.owner),
                                      chat_title=display_name(entity, 180), archived=False,
                                      top_message_id=0, last_message_at=None)], {})

    async def messages(self, rows, history_cid=None, state=None):
        for cid in dict.fromkeys(r["chat_id"] for r in rows):
            await self.ensure_dialog(cid)
        start = 0
        while start < len(rows):
            end = min(start + 100, len(rows))
            while end > start:
                selected = rows[start:end]
                by_chat = {}
                for row in selected:
                    by_chat.setdefault(row["chat_id"], []).append(row["message_id"])
                checkpoints = []
                for cid, ids in by_chat.items():
                    cp = dict(chat_id=cid, latest_synced_id=max(
                        max(ids), self.chats[cid].get("latest_synced_id", 0)))
                    if cid == history_cid:
                        cp.update(history_before_id=min(ids), history_complete=False,
                                  history_status="loading")
                    checkpoints.append(cp)
                parts = dict(messages=selected, checkpoints=checkpoints)
                if state is not None and end == len(rows):
                    parts["state"] = state
                # Reserve envelope room, independent of variable lease ID length.
                if (len(checkpoints) <= 100 and len(selected) + len(checkpoints) <= 200 and
                        len(json_bytes(parts)) < MAX_JSON - 2048 and write_cost(parts) <= self.quota):
                    break
                end -= 1
            if end == start:
                raise StopRun("quota")
            await self.batch(**parts)
            start = end

    async def deletions(self, ids, cid=None, event_pts=None):
        mids = sorted(set(integer(mid, 1, MAX_ID) for mid in ids))
        if cid:
            await self.ensure_dialog(cid)
        durable = cid is None and event_pts is not None
        cursor = None
        digest = hashlib.sha256(json_bytes(mids)).hexdigest()
        if durable:
            integer(event_pts, 1)
            if event_pts <= self.update.get("common_delete_pts", 0):
                return
            cursor = self.update.get("common_delete_cursor")
            if cursor and (cursor["pts"] != event_pts or cursor["digest"] != digest):
                raise SafeError("common_delete_replay_changed")
            if not mids:
                value = copy.deepcopy(self.update)
                value["common_delete_pts"] = event_pts
                value.pop("common_delete_cursor", None)
                await self.save_update(value)
                return
        start = 0
        if cursor:
            start = next((i for i, mid in enumerate(mids) if mid > cursor["after_message_id"]), len(mids))
        while start < len(mids):
            count = min(100, len(mids) - start, max(0, (self.quota - 64) // 12))
            if not count:
                raise StopRun("quota")
            selected = mids[start:start + count]
            parts = ({"deleted": [dict(chat_id=cid, message_id=mid) for mid in selected]}
                     if cid else {"global_deleted": selected})
            if durable:
                value = copy.deepcopy(self.update)
                if start + count == len(mids):
                    value["common_delete_pts"] = event_pts
                    value.pop("common_delete_cursor", None)
                else:
                    value["common_delete_cursor"] = dict(
                        pts=event_pts, digest=digest, after_message_id=selected[-1])
                parts["state"] = {"update_state": value}
            await self.batch(**parts)
            start += count

    async def gap(self, cid=None):
        body = dict(lease_id=self.lease, generation=self.generation,
                    status="reconciliation_required")
        if cid is not None:
            body["chat_id"] = chat_id(cid)
        # This safety control operation must not depend on remaining ingest
        # credits. The server sets the flag and releases the lease atomically.
        result = await self.broker.post("finish", body, finishing=True)
        if result.get("ok") is not True:
            raise SafeError("invalid_gap_receipt")
        self._gap_finish_body = copy.deepcopy(body)
        value = copy.deepcopy(self.update)
        value["reconciliation_required"] = {"scope": "channel" if cid else "global"}
        if cid:
            value["reconciliation_required"]["chat_id"] = cid
            if cid in self.chats:
                self.chats[cid].update(history_complete=False, history_status="paused")
        self.update = value
        raise SafeError("reconciliation_required")

    async def check_gap_updates(self, updates, channel=None):
        affected = set()
        for update in updates:
            if isinstance(update, types.UpdateChannelAvailableMessages):
                affected.add(canonical(types.PeerChannel(update.channel_id)))
            if isinstance(update, types.UpdateChannelTooLong):
                cid = canonical(types.PeerChannel(update.channel_id))
                if cid == channel:
                    affected.add(cid)
        if affected:
            # A finish can carry one chat ID. Multiple affected peers require a
            # source-wide marker rather than silently recording only the first.
            await self.gap(next(iter(affected)) if len(affected) == 1 else None)

    async def other_updates(self, updates, channel=None):
        await self.check_gap_updates(updates, channel=channel)
        common_deletes = sorted((u for u in updates if isinstance(u, types.UpdateDeleteMessages)),
                                key=lambda u: u.pts)
        pending = self.update.get("common_delete_cursor")
        if channel is None and pending and not any(u.pts == pending["pts"] for u in common_deletes):
            raise SafeError("common_delete_replay_missing")
        for update in updates:
            if isinstance(update, (types.UpdateNewMessage, types.UpdateEditMessage,
                                   types.UpdateNewChannelMessage, types.UpdateEditChannelMessage)):
                row = normalize_message(update.message, self.entities)
                if row:
                    await self.messages([row])
            elif isinstance(update, types.UpdateDeleteChannelMessages):
                await self.deletions(update.messages, canonical(types.PeerChannel(update.channel_id)))
            elif isinstance(update, types.UpdateDeleteMessages):
                continue
            elif isinstance(update, types.UpdateChannelTooLong):
                cid = canonical(types.PeerChannel(update.channel_id))
                await self.channel_difference(cid)
        for update in common_deletes:
            await self.deletions(update.messages, event_pts=update.pts)

    async def channel_difference(self, cid):
        await self.ensure_dialog(cid)
        peer = self.peers.get(cid)
        pts = self.chats[cid].get("channel_pts")
        if peer is None or pts is None:
            # Do not acknowledge the global trigger without a durable baseline.
            raise SafeError("channel_baseline_unavailable")
        while True:
            result = await self.tg.rpc(functions.updates.GetChannelDifferenceRequest(
                channel=utils.get_input_channel(peer), filter=types.ChannelMessagesFilterEmpty(),
                pts=integer(pts), limit=100, force=True))
            self.remember(result)
            if isinstance(result, types.updates.ChannelDifferenceTooLong):
                await self.gap(cid)
            if not isinstance(result, (types.updates.ChannelDifference,
                                       types.updates.ChannelDifferenceEmpty)):
                raise SafeError("unexpected_channel_difference")
            await self.check_gap_updates(getattr(result, "other_updates", []), channel=cid)
            rows = [normalize_message(m, self.entities) for m in getattr(result, "new_messages", [])]
            await self.messages([r for r in rows if r])
            await self.other_updates(getattr(result, "other_updates", []), channel=cid)
            next_pts = integer(result.pts)
            if next_pts < pts or (not result.final and next_pts == pts):
                raise SafeError("nonadvancing_channel_difference")
            await self.batch(checkpoints=[dict(chat_id=cid, channel_pts=next_pts)])
            pts = next_pts
            if result.final:
                return

    @staticmethod
    def global_state(value):
        return dict(pts=integer(value.pts), qts=integer(value.qts),
                    date=utc(value.date), seq=integer(value.seq))

    async def global_difference(self):
        while True:
            old = self.update["global"]
            result = await self.tg.rpc(functions.updates.GetDifferenceRequest(
                pts=integer(old["pts"]), qts=integer(old["qts"]), date=from_utc(old["date"]),
                pts_limit=1000, qts_limit=100))
            self.remember(result)
            if isinstance(result, types.updates.DifferenceTooLong):
                await self.gap()
            next_update = copy.deepcopy(self.update)
            if isinstance(result, types.updates.DifferenceEmpty):
                if result.seq < old["seq"] or self.update.get("common_delete_cursor"):
                    raise SafeError("incomplete_global_difference")
                next_update["global"] = dict(old, date=utc(result.date), seq=integer(result.seq))
                await self.save_update(next_update)
                return
            if not isinstance(result, (types.updates.Difference, types.updates.DifferenceSlice)):
                raise SafeError("unexpected_global_difference")
            await self.check_gap_updates(result.other_updates)
            # Encrypted messages are intentionally not normalized or uploaded.
            rows = [normalize_message(m, self.entities) for m in result.new_messages]
            await self.messages([r for r in rows if r])
            await self.other_updates(result.other_updates)
            sliced = isinstance(result, types.updates.DifferenceSlice)
            new = self.global_state(result.intermediate_state if sliced else result.state)
            if any(new[k] < old[k] for k in ("pts", "qts", "seq")) or (sliced and new == old):
                raise SafeError("nonadvancing_global_difference")
            # Channel processing may have persisted reconciliation flags. Never
            # overwrite those with an earlier copy of the global state.
            next_update = copy.deepcopy(self.update)
            next_update["global"] = new
            await self.save_update(next_update)
            if not sliced:
                return

    def history_allowed(self):
        return True

    async def backfill(self):
        after = self.update.get("backfill_after_chat_id", "")
        ids = sorted(self.chats)
        ids = [cid for cid in ids if cid > after] + [cid for cid in ids if cid <= after]
        for cid in ids:
            self.budget.check()
            if not self.history_allowed():
                return
            row = self.chats[cid]
            if row.get("history_complete") or row.get("history_status") in ("unavailable", "paused"):
                continue
            peer = self.peers.get(cid)
            if peer is None:
                await self.batch(checkpoints=[dict(chat_id=cid, history_status="unavailable")])
                continue
            before = row.get("history_before_id") or 0
            try:
                result = await self.tg.rpc(functions.messages.GetHistoryRequest(
                    peer=peer, offset_id=integer(before, 0, MAX_ID), offset_date=None,
                    add_offset=0, limit=PAGE, max_id=0, min_id=0, hash=0))
            except UNAVAILABLE:
                await self.batch(checkpoints=[dict(chat_id=cid, history_status="unavailable")])
                continue
            self.remember(result)
            messages = result.messages
            update = copy.deepcopy(self.update)
            update["backfill_after_chat_id"] = cid
            if not messages:
                await self.batch(checkpoints=[dict(chat_id=cid, history_complete=True,
                                                   history_status="complete")],
                                 state={"update_state": update})
                continue
            rows = [normalize_message(m, self.entities) for m in messages]
            rows = [m for m in rows if m]
            if not rows or any(m["chat_id"] != cid or
                               (before and m["message_id"] >= before) for m in rows):
                raise SafeError("nonadvancing_history_page")
            rows.sort(key=lambda m: m["message_id"], reverse=True)
            await self.messages(rows, history_cid=cid, state={"update_state": update})
            await self.live_tick()

    async def run(self, cached_generation=None):
        status, retry = "error", None
        try:
            claim = await self.broker.post("claim", {})
            if str(claim.get("owner_id")) != str(self.owner):
                raise SafeError("broker_owner_mismatch")
            self.lease, self.generation = claim["lease_id"], claim["generation"]
            cached = cached_generation == self.generation and bool(self.peers)
            self.quota = integer(claim.get("quota_remaining"))
            self.cursor = claim.get("dialog_cursor")
            self.update = state_size(claim.get("update_state") or {"v": 1})
            if self.update.get("v") != 1 or self.update.get("reconciliation_required"):
                raise SafeError("reconciliation_required")
            await self.tg.connect()
            await self.read_state()
            if "global" not in self.update:
                value = copy.deepcopy(self.update)
                value["global"] = self.global_state(await self.tg.rpc(functions.updates.GetStateRequest()))
                await self.save_update(value)
            resumed = bool(self.cursor)
            if not cached or resumed:
                await self.discover()
            if resumed:
                # StringSession does not retain entity access hashes. Rehydrate
                # prefix peers read-only; never serialize a Telethon entity.
                await self.discover(hydrate_only=True)
            if not cached or resumed:
                await self.refresh_metadata()
            await self.global_difference()
            await self.backfill()
            await self.global_difference()
            if self.live_interval is not None:
                while True:
                    await self.budget.wait(self.live_interval)
                    await self.global_difference()
            status = "idle"  # Transport idle, not a declaration of history completion.
        except StopRun as exc:
            status, retry = exc.status, exc.retry_after_seconds
        except errors.FloodWaitError as exc:
            status, retry = "flood_wait", max(1, int(exc.seconds))
        except HttpFailure as exc:
            self.last_http_status = exc.status
            status = "error"
        except (Exception, asyncio.CancelledError):
            status = "error"
        finally:
            if self.lease:
                body = (copy.deepcopy(self._gap_finish_body) if self._gap_finish_body else
                        dict(lease_id=self.lease, generation=self.generation, status=status))
                if retry is not None and not self._gap_finish_body:
                    body["retry_after_seconds"] = retry
                try:
                    await self.broker.post("finish", body, finishing=True)
                except HttpFailure as exc:
                    # Only an acknowledged gap finish proves the lease was
                    # released. Do not ignore unrelated or first-finish 409s.
                    if not (self._gap_finish_body and exc.status == 409):
                        status = "error"
                except (Exception, asyncio.CancelledError):
                    status = "error"
            try:
                await self.tg.disconnect()
            except (Exception, asyncio.CancelledError):
                status = "error"
        self.retry_after_seconds = retry
        return status


async def async_main():
    if telethon_version != "1.45.0":
        raise SafeError("unsupported_telethon_version")
    config = Config.from_env(os.environ)
    budget = Budget()
    transport = HttpTransport()
    tokens = OidcTokens(transport, config.oidc_url, config.oidc_token, config.audience)
    broker = Broker(config.origin, tokens, transport, budget)
    session = StringSession(config.session)
    if not session.auth_key:
        raise SafeError("session_missing")
    client = VerifiedClient(config.owner, session, config.api_id, config.api_hash,
                            receive_updates=False, catch_up=False, flood_sleep_threshold=0,
                            request_retries=0, connection_retries=1, auto_reconnect=False,
                            timeout=10, raise_last_call_error=True)
    telegram = ReadOnlyTelegram(client, config.owner, budget)
    return await Runner(telegram, broker, config.owner, budget).run()


def main():
    logging.disable(logging.CRITICAL)
    try:
        status = asyncio.run(asyncio.wait_for(async_main(), timeout=475))
    except (Exception, KeyboardInterrupt):
        status = "error"
    print("Account context sync: " + status)
    return 1 if status == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
