"""Offline tests. Every peer, body, credential marker and transport is synthetic."""

import asyncio
import base64
import copy
import io
import json
import os
import socket
import tempfile
import unittest
import uuid
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError

from telethon import errors, functions as f, types as t
from scripts import telegram_account_sync as s
from scripts import telegram_account_login as login


DATE = datetime(2024, 1, 1, tzinfo=timezone.utc)
GLOBAL = dict(pts=10, qts=0, seq=1, date=s.utc(DATE))


def update_state(pts=10, seq=1):
    return t.updates.State(pts=pts, qts=0, date=DATE, seq=seq, unread_count=0)


def user(ident=2):
    return t.User(id=ident, access_hash=123, first_name="Synthetic", bot=False)


def channel(ident=8, megagroup=False):
    return t.Channel(id=ident, title="Synthetic", photo=t.ChatPhotoEmpty(),
                     date=DATE, access_hash=123, megagroup=megagroup)


def message(ident=1, peer=None, **kwargs):
    return t.Message(id=ident, peer_id=peer or t.PeerUser(2), date=DATE,
                     message=kwargs.pop("message", "synthetic body"), **kwargs)


def dialog(peer=None, top=10, pts=None):
    return t.Dialog(peer=peer or t.PeerUser(2), top_message=top,
                    read_inbox_max_id=0, read_outbox_max_id=0,
                    unread_count=0, unread_mentions_count=0, unread_reactions_count=0,
                    unread_poll_votes_count=0, notify_settings=t.PeerNotifySettings(), pts=pts)


def dialogs_result(entities, pinned=False):
    ds, ms, users, chats = [], [], [], []
    for entity in entities:
        if isinstance(entity, t.User):
            peer = t.PeerUser(entity.id)
            users.append(entity)
        elif isinstance(entity, t.Channel):
            peer = t.PeerChannel(entity.id)
            chats.append(entity)
        else:
            peer = t.PeerChat(entity.id)
            chats.append(entity)
        ds.append(dialog(peer, pts=10 if isinstance(entity, t.Channel) else None))
        ms.append(message(10, peer))
    if pinned:
        return t.messages.PeerDialogs(ds, ms, chats, users, update_state())
    return t.messages.Dialogs(ds, ms, chats, users)


def history(*messages):
    return t.messages.Messages(list(messages), [], [], [])


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


class Tokens:
    def __init__(self):
        self.refreshes = 0

    async def get(self, force=False):
        if force:
            self.refreshes += 1
        return "synthetic-oidc"


class FakeTransport:
    """Strict subset of the exact broker contract, including conservative cost."""

    def __init__(self, chats=None, quota=45000, global_state=True):
        self.chats = copy.deepcopy(chats or {})
        self.messages = {}
        self.tombstones = set()
        self.global_tombstones = set()
        self.state = {"v": 1, "global": copy.deepcopy(GLOBAL)} if global_state else None
        self.cursor = None
        self.complete = False
        self.quota = quota
        self.requests, self.batches, self.receipts = [], [], {}
        self.finish = None
        self.failures = []
        self.owner = 1
        self.lost_reply = False
        self.lease_active = True

    @staticmethod
    def response(value):
        return 200, s.json_bytes(value)

    async def request(self, method, url, headers, data, timeout):
        endpoint = url.rsplit("/", 1)[-1]
        self.requests.append((endpoint, data, headers))
        if self.failures and self.failures[0][0] == endpoint:
            _, status = self.failures.pop(0)
            return status, b"synthetic-error-body-must-not-leak"
        body = json.loads(data)
        if endpoint == "claim":
            self.lease_active = True
            return self.response(dict(owner_id=self.owner, generation=1, lease_id="fake-lease",
                                      lease_until=s.utc(DATE), quota_remaining=self.quota,
                                      dialogs_complete=self.complete, dialog_cursor=self.cursor,
                                      update_state=self.state))
        if endpoint == "state":
            after = body.get("after_chat_id", "")
            ids = sorted(cid for cid in self.chats if cid > after)
            selected = ids[:200]
            keys = ("chat_id", "chat_type", "top_message_id", "latest_synced_id",
                    "history_before_id", "history_complete", "history_status",
                    "channel_pts", "deleted_before_id")
            rows = [{key: self.chats[cid][key] for key in keys if key in self.chats[cid]}
                    for cid in selected]
            return self.response(dict(chats=rows, next_chat_id=selected[-1] if len(ids) > 200 else None))
        if endpoint == "finish":
            assert set(body) <= {"lease_id", "generation", "status", "retry_after_seconds", "chat_id"}
            if (not self.lease_active or body.get("lease_id") != "fake-lease" or
                    body.get("generation") != 1):
                return 409, b""
            assert body["status"] in ("idle", "quota", "flood_wait", "error", "reconciliation_required")
            assert "chat_id" not in body or body["status"] == "reconciliation_required"
            if body["status"] == "reconciliation_required":
                cid = s.chat_id(body["chat_id"]) if "chat_id" in body else None
                value = copy.deepcopy(self.state or {})
                value["reconciliation_required"] = {"scope": "channel" if cid else "global"}
                if cid:
                    value["reconciliation_required"]["chat_id"] = cid
                    if cid in self.chats:
                        self.chats[cid].update(history_complete=False, history_status="paused")
                self.state = value
            self.finish = body
            self.lease_active = False
            return self.response({"ok": True})
        assert endpoint == "batch"
        bid = body["batch_id"]
        assert uuid.UUID(bid).version == 4
        if bid in self.receipts:
            original, result = self.receipts[bid]
            assert original == data
            return self.response(result)
        counts = [len(body.get(key, [])) for key in s.ARRAYS]
        assert max(counts) <= 100 and sum(counts) <= 200
        assert len(data) <= s.MAX_JSON
        cost = s.write_cost(body)
        affected = [key for key in self.messages if key[1] in body.get("global_deleted", []) and
                    self.chats[key[0]]["chat_type"] not in ("channel", "supergroup")]
        cost += 6 * len(affected)
        if cost > self.quota:
            return 429, b""
        for row in body.get("dialogs", []):
            assert isinstance(row["chat_title"], str) and row["chat_title"].strip()
            assert len(row["chat_title"].encode("utf-16-le")) // 2 <= 180
            cid = row["chat_id"]
            self.chats.setdefault(cid, dict(chat_id=cid, latest_synced_id=0,
                                           history_complete=False, history_status="pending"))
            self.chats[cid].update(row)
        for row in body.get("messages", []):
            for key, limit in (("body", 6000), ("sender_name", 120), ("content_type", 32)):
                assert isinstance(row[key], str) and row[key].strip()
                assert len(row[key].encode("utf-16-le")) // 2 <= limit
            key = (row["chat_id"], row["message_id"])
            assert key[0] in self.chats
            global_deleted = key[1] in self.global_tombstones and self.chats[key[0]]["chat_type"] not in ("channel", "supergroup")
            if key not in self.tombstones and not global_deleted:
                self.messages[key] = row
        for row in body.get("deleted", []):
            key = (row["chat_id"], row["message_id"])
            assert key[0] in self.chats
            self.tombstones.add(key)
            self.messages.pop(key, None)
        for mid in body.get("global_deleted", []):
            assert isinstance(mid, int) and not isinstance(mid, bool) and 0 < mid <= s.MAX_ID
            self.global_tombstones.add(mid)
        for key in affected:
            self.messages.pop(key, None)
        for cp in body.get("checkpoints", []):
            cid = cp["chat_id"]
            assert cid in self.chats
            prior = self.chats[cid]
            mids = [r["message_id"] for r in body.get("messages", []) if r["chat_id"] == cid]
            if "latest_synced_id" in cp:
                assert cp["latest_synced_id"] <= max([prior.get("latest_synced_id", 0)] + mids)
            if "history_before_id" in cp:
                assert mids and cp["history_before_id"] >= min(mids)
                old = prior.get("history_before_id")
                assert not old or cp["history_before_id"] <= old
            self.chats[cid].update(cp)
        state = body.get("state", {})
        if "update_state" in state:
            assert len(s.json_bytes(state["update_state"])) <= s.MAX_STATE
            self.state = copy.deepcopy(state["update_state"])
        if "dialog_cursor" in state:
            assert isinstance(state["dialog_cursor"], dict)
            self.cursor = copy.deepcopy(state["dialog_cursor"])
        if "dialogs_complete" in state:
            self.complete = state["dialogs_complete"]
        self.quota -= cost
        self.batches.append(copy.deepcopy(body))
        result = dict(ok=True, batch_id=bid, quota_remaining=self.quota)
        self.receipts[bid] = data, result
        if self.lost_reply:
            self.lost_reply = False
            raise s.HttpFailure(0)
        return self.response(result)


class FakeClient:
    def __init__(self, entities=None, archived=None):
        self.entities = entities or []
        self.archived = archived or []
        self.calls = []
        self.handlers = {}
        self.me = user(1)

    async def connect(self):
        self.calls.append("connect")

    async def disconnect(self):
        self.calls.append("disconnect")

    async def get_me(self):
        self.calls.append("get_me")
        return self.me

    async def __call__(self, request):
        self.calls.append(request)
        handler = self.handlers.get(type(request))
        if handler is not None:
            if isinstance(handler, BaseException):
                value = handler
            elif isinstance(handler, list):
                value = handler.pop(0)
            else:
                value = handler(request)
            if isinstance(value, BaseException):
                raise value
            return value
        if isinstance(request, f.messages.GetPinnedDialogsRequest):
            return dialogs_result([], pinned=True)
        if isinstance(request, f.messages.GetDialogsRequest):
            entities = self.archived if request.folder_id == 1 else self.entities
            start = 0
            if not isinstance(request.offset_peer, t.InputPeerEmpty):
                last = s.canonical(request.offset_peer)
                start = next(i + 1 for i, e in enumerate(entities) if s.canonical(e) == last)
            return dialogs_result(entities[start:start + request.limit])
        if isinstance(request, f.updates.GetStateRequest):
            return update_state()
        if isinstance(request, f.updates.GetDifferenceRequest):
            return t.updates.DifferenceEmpty(DATE, request.pts // 10)
        if isinstance(request, f.messages.GetHistoryRequest):
            return history()
        raise AssertionError("unexpected fake RPC")


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.no_network = patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden"))
        self.no_network.start()
        self.addCleanup(self.no_network.stop)
        self.clock = Clock()
        self.budget = s.Budget(450, clock=self.clock, sleep=self.clock.sleep)
        self.transport = FakeTransport()
        self.tokens = Tokens()
        self.broker = s.Broker("https://synthetic.invalid", self.tokens, self.transport, self.budget)
        self.client = FakeClient()
        self.tg = s.ReadOnlyTelegram(self.client, 1, self.budget)
        self.runner = s.Runner(self.tg, self.broker, 1, self.budget)

    def prepared(self, chats=None):
        self.runner.lease = "fake-lease"
        self.runner.generation = 1
        self.runner.quota = self.transport.quota
        self.runner.update = {"v": 1, "global": copy.deepcopy(GLOBAL)}
        self.runner.chats = copy.deepcopy(chats or {})
        self.transport.chats = copy.deepcopy(self.runner.chats)

    async def test_owner_mismatch_does_not_read(self):
        self.client.me = user(99)
        self.assertEqual(await self.runner.run(), "error")
        self.assertFalse(any(isinstance(c, s.READ_RPCS) for c in self.client.calls))
        self.assertEqual(self.transport.batches, [])

    async def test_broker_owner_mismatch_does_not_connect(self):
        self.transport.owner = 99
        self.assertEqual(await self.runner.run(), "error")
        self.assertNotIn("connect", self.client.calls)

    async def test_unauthorized_does_not_bootstrap(self):
        self.client.me = None
        self.assertEqual(await self.runner.run(), "error")
        self.assertEqual(self.transport.batches, [])

    async def test_rpc_allowlist_and_owner_gate(self):
        with self.assertRaises(s.SafeError):
            await self.tg.rpc(f.messages.GetHistoryRequest(t.InputPeerSelf(), 0, None, 0, 10, 0, 0, 0))
        await self.tg.connect()
        with self.assertRaises(s.SafeError):
            await self.tg.rpc(f.messages.ReadHistoryRequest(t.InputPeerSelf(), 1))
        with self.assertRaises(s.SafeError):
            await self.tg.rpc(f.messages.SendMessageRequest(t.InputPeerSelf(), "never send"))

    async def test_verified_client_blocks_mutations_and_pre_owner_state(self):
        client = s.VerifiedClient(1, StringSessionForTest(), 1, "0" * 32, receive_updates=False)
        with self.assertRaises(s.SafeError):
            await client(f.updates.GetStateRequest())
        with self.assertRaises(s.SafeError):
            await client(f.messages.ReadHistoryRequest(t.InputPeerSelf(), 1))

    async def test_verified_get_me_rejects_wrong_owner_before_telethon_initialization(self):
        client = s.VerifiedClient(1, StringSessionForTest(), 1, "0" * 32, receive_updates=False)
        with patch.object(s.TelegramClient, "get_me", AsyncMock(return_value=user(99))), \
                self.assertRaises(s.SafeError):
            await client.get_me()
        self.assertFalse(client.owner_verified)

    async def test_transport_discards_error_bodies_without_logging(self):
        response = io.BytesIO(b"synthetic-token-and-private-response-body")
        opener = SimpleNamespace(open=lambda *args, **kwargs: (_ for _ in ()).throw(
            HTTPError("https://synthetic.invalid", 400, "synthetic", {}, response)))
        output = io.StringIO()
        with patch.object(s, "build_opener", return_value=opener), \
                redirect_stdout(output), redirect_stderr(output):
            status, data = await s.HttpTransport().request("POST", "https://synthetic.invalid", {}, b"{}", 1)
        self.assertEqual((status, data), (400, b""))
        self.assertEqual(output.getvalue(), "")

    async def test_global_deleted_counts_toward_total_array_cap(self):
        self.prepared()
        with self.assertRaises(s.SafeError):
            await self.runner.batch(global_deleted=list(range(1, 101)), messages=[{}] * 100,
                                    checkpoints=[{}])
        self.assertEqual(self.transport.batches, [])

    async def test_entire_index_above_200_with_archive_and_types(self):
        group = t.Chat(7, "Synthetic", t.ChatPhotoEmpty(), 2, DATE, 1)
        bot = user(4)
        bot.bot = True
        self.client.entities = [user(1), bot, group] + [user(i) for i in range(100, 352)]
        self.client.archived = [channel(8), channel(9, megagroup=True)]
        self.assertEqual(await self.runner.run(), "idle")
        self.assertEqual(len(self.transport.chats), 257)
        self.assertTrue(self.transport.complete)
        self.assertTrue(self.transport.chats["-1000000000008"]["archived"])
        self.assertEqual(self.transport.chats["-7"]["chat_type"], "group")
        self.assertEqual(self.transport.chats["1"]["chat_type"], "saved")
        self.assertEqual(self.transport.chats["4"]["chat_type"], "bot")
        self.assertEqual(self.transport.chats["-1000000000009"]["chat_type"], "supergroup")
        calls = [r for r in self.client.calls if isinstance(r, f.messages.GetDialogsRequest)]
        self.assertGreater(len(calls), 4)
        self.assertTrue(all(r.exclude_pinned for r in calls))

    async def test_pinned_metadata_is_not_omitted(self):
        self.client.handlers[f.messages.GetPinnedDialogsRequest] = lambda req: dialogs_result(
            [user(3)] if req.folder_id == 0 else [], pinned=True)
        self.assertEqual(await self.runner.run(), "idle")
        self.assertIn("3", self.transport.chats)

    async def test_state_has_no_200_cap(self):
        self.transport.chats = {str(i): dict(chat_id=str(i), chat_type="private") for i in range(1, 452)}
        self.prepared(self.transport.chats)
        self.runner.chats = {}
        await self.runner.read_state()
        self.assertEqual(len(self.runner.chats), 451)
        self.assertEqual(sum(e == "state" for e, _, _ in self.transport.requests), 3)

    async def test_history_id_one_and_empty_page_only_completion(self):
        self.client.entities = [user(2)]
        self.client.handlers[f.messages.GetHistoryRequest] = lambda req: history(message(1)) if req.offset_id == 0 else history()
        self.assertEqual(await self.runner.run(), "idle")
        self.assertEqual(self.transport.chats["2"]["history_before_id"], 1)
        self.assertFalse(self.transport.chats["2"]["history_complete"])
        # New independent process, same broker progress, no StringSession state.
        clock = Clock()
        budget = s.Budget(450, clock=clock, sleep=clock.sleep)
        broker = s.Broker("https://synthetic.invalid", Tokens(), self.transport, budget)
        tg = s.ReadOnlyTelegram(self.client, 1, budget)
        second = s.Runner(tg, broker, 1, budget)
        self.assertEqual(await second.run(), "idle")
        self.assertTrue(self.transport.chats["2"]["history_complete"])
        offsets = [r.offset_id for r in self.client.calls if isinstance(r, f.messages.GetHistoryRequest)]
        self.assertEqual(offsets, [0, 1])

    async def test_budget_after_nonempty_response_does_not_complete_or_advance(self):
        self.client.entities = [user(2)]
        def stop(req):
            self.clock.now = 436
            return history(message(5))
        self.client.handlers[f.messages.GetHistoryRequest] = stop
        self.assertEqual(await self.runner.run(), "idle")
        self.assertFalse(self.transport.chats["2"].get("history_complete", False))
        self.assertIsNone(self.transport.chats["2"].get("history_before_id"))

    async def test_flood_wait_no_retry_and_generic_finish(self):
        self.client.handlers[f.messages.GetPinnedDialogsRequest] = errors.FloodWaitError(None, capture=77)
        self.assertEqual(await self.runner.run(), "flood_wait")
        self.assertEqual(self.transport.finish["retry_after_seconds"], 77)
        self.assertEqual(sum(isinstance(c, f.messages.GetPinnedDialogsRequest) for c in self.client.calls), 1)

    async def test_failed_batch_does_not_advance_cursor(self):
        self.prepared()
        self.transport.failures = [("batch", 409)]
        with self.assertRaises(s.HttpFailure):
            await self.runner.batch(state={"dialog_cursor": {"v": 1, "folder": 1}})
        self.assertIsNone(self.runner.cursor)
        self.assertIsNone(self.transport.cursor)

    async def test_lost_reply_retries_exact_bytes_and_cost_once(self):
        self.prepared()
        self.transport.lost_reply = True
        await self.runner.batch(state={"dialog_cursor": {"v": 1, "folder": 1}})
        calls = [data for endpoint, data, _ in self.transport.requests if endpoint == "batch"]
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.transport.quota, 45000 - 64)
        self.assertEqual(self.runner.cursor["folder"], 1)

    async def test_401_refresh_keeps_batch_id(self):
        self.prepared()
        self.transport.failures = [("batch", 401)]
        await self.runner.batch(state={"dialogs_complete": True})
        self.assertEqual(self.tokens.refreshes, 1)
        calls = [data for endpoint, data, _ in self.transport.requests if endpoint == "batch"]
        self.assertEqual(calls[0], calls[1])

    async def test_quota_is_write_cost_not_message_count(self):
        self.transport.quota = 64 + 2 * 12 + 4
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0)})
        rows = [s.normalize_message(message(i), {}) for i in (5, 4, 3)]
        with self.assertRaises(s.StopRun) as raised:
            await self.runner.messages(rows, history_cid="2")
        self.assertEqual(raised.exception.status, "quota")
        self.assertEqual(len(self.transport.messages), 2)
        self.assertEqual(self.transport.chats["2"]["history_before_id"], 4)
        self.assertFalse(self.transport.chats["2"]["history_complete"])

    async def test_http_429_and_507_stop_as_quota(self):
        for status in (429, 507):
            self.transport.failures = [("batch", status)]
            with self.assertRaises(s.StopRun) as raised:
                await self.broker.post("batch", {"synthetic": True})
            self.assertEqual(raised.exception.status, "quota")

    async def test_large_unicode_batches_respect_bytes_and_checkpoints(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0)})
        rows = [s.normalize_message(message(i, message="\u4e00" * 6000), {}) for i in range(100, 0, -1)]
        await self.runner.messages(rows, history_cid="2")
        self.assertGreater(len(self.transport.batches), 1)
        self.assertEqual(self.transport.chats["2"]["history_before_id"], 1)
        self.assertEqual(len(self.transport.messages), 100)

    async def test_global_slice_edit_delete_persist_only_after_rows(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0),
                       "3": dict(chat_id="3", chat_type="private", latest_synced_id=0)})
        await self.tg.connect()
        self.client.handlers[f.updates.GetDifferenceRequest] = [
            t.updates.DifferenceSlice([message(11)], [], [], [], [user(2)], update_state(11, 2)),
            t.updates.Difference([], [], [t.UpdateEditMessage(message(11, message="edited"), 12, 1),
                                       t.UpdateDeleteMessages([10], 13, 1)], [], [], update_state(13, 3)),
        ]
        await self.runner.global_difference()
        self.assertEqual(self.transport.messages[("2", 11)]["body"], "edited")
        self.assertIn(10, self.transport.global_tombstones)
        self.assertEqual(self.transport.tombstones, set())
        self.assertEqual(self.runner.update["global"]["pts"], 13)
        requests = [r for r in self.client.calls if isinstance(r, f.updates.GetDifferenceRequest)]
        self.assertEqual([r.pts for r in requests], [10, 11])
        final = self.transport.batches[-1]
        self.assertEqual(final["state"]["update_state"]["global"]["pts"], 13)

    async def test_failed_update_ingest_does_not_ack_global(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0)})
        await self.tg.connect()
        self.client.handlers[f.updates.GetDifferenceRequest] = [
            t.updates.Difference([message(11)], [], [], [], [], update_state(11, 2))]
        self.transport.failures = [("batch", 500)] * 4
        with self.assertRaises(s.HttpFailure):
            await self.runner.global_difference()
        self.assertEqual(self.runner.update["global"], GLOBAL)
        self.assertEqual(self.transport.state["global"], GLOBAL)

    async def test_channel_difference_slices_edits_deletions_and_durable_pts(self):
        cid = "-1000000000008"
        self.prepared({cid: dict(chat_id=cid, chat_type="channel", latest_synced_id=0, channel_pts=10)})
        self.runner.peers[cid] = t.InputPeerChannel(8, 123)
        await self.tg.connect()
        self.client.handlers[f.updates.GetChannelDifferenceRequest] = [
            t.updates.ChannelDifference(11, [message(5, t.PeerChannel(8))], [], [], [], final=False),
            t.updates.ChannelDifference(12, [], [t.UpdateDeleteChannelMessages(8, [4], 12, 1)], [], [], final=True),
        ]
        await self.runner.channel_difference(cid)
        self.assertEqual(self.transport.chats[cid]["channel_pts"], 12)
        calls = [r for r in self.client.calls if isinstance(r, f.updates.GetChannelDifferenceRequest)]
        self.assertEqual([r.pts for r in calls], [10, 11])
        self.assertIn((cid, 4), self.transport.tombstones)

    async def test_channel_trigger_processed_before_global_ack(self):
        cid = "-1000000000008"
        self.prepared({cid: dict(chat_id=cid, chat_type="channel", latest_synced_id=0, channel_pts=10)})
        self.runner.peers[cid] = t.InputPeerChannel(8, 123)
        await self.tg.connect()
        self.client.handlers[f.updates.GetDifferenceRequest] = [
            t.updates.Difference([], [], [t.UpdateChannelTooLong(8, pts=12)], [], [], update_state(11, 2))]
        self.client.handlers[f.updates.GetChannelDifferenceRequest] = [t.updates.ChannelDifferenceEmpty(12, final=True)]
        await self.runner.global_difference()
        self.assertEqual(self.transport.batches[-2]["checkpoints"][0]["channel_pts"], 12)
        self.assertEqual(self.transport.batches[-1]["state"]["update_state"]["global"]["pts"], 11)

    async def test_difference_too_long_never_false_success(self):
        self.transport.quota = 0
        self.prepared()
        saved_cursor = dict(v=1, folder=1, phase="page", id=7)
        self.runner.cursor = copy.deepcopy(saved_cursor)
        self.transport.cursor = copy.deepcopy(saved_cursor)
        await self.tg.connect()
        self.client.handlers[f.updates.GetDifferenceRequest] = [t.updates.DifferenceTooLong(99)]
        with self.assertRaises(s.SafeError):
            await self.runner.global_difference()
        self.assertEqual(self.transport.state["global"]["pts"], 10)
        self.assertEqual(self.transport.state["reconciliation_required"]["scope"], "global")
        self.assertEqual(self.runner.update["global"], GLOBAL)
        self.assertEqual(self.runner.cursor, saved_cursor)
        self.assertEqual(self.transport.cursor, saved_cursor)
        self.assertEqual(self.transport.quota, 0)
        self.assertEqual(self.transport.batches, [])
        self.assertEqual(self.transport.finish["status"], "reconciliation_required")
        self.assertNotIn("chat_id", self.transport.finish)
        self.assertFalse(self.transport.lease_active)

    async def test_channel_too_long_pauses_without_advancing_pts(self):
        cid = "-1000000000008"
        self.transport.quota = 0
        self.prepared({cid: dict(chat_id=cid, chat_type="channel", latest_synced_id=0,
                                 channel_pts=10, history_before_id=7, history_complete=True)})
        self.runner.peers[cid] = t.InputPeerChannel(8, 123)
        await self.tg.connect()
        self.client.handlers[f.updates.GetChannelDifferenceRequest] = [
            t.updates.ChannelDifferenceTooLong(dialog(t.PeerChannel(8), pts=99), [], [], [], final=True)]
        with self.assertRaises(s.SafeError):
            await self.runner.channel_difference(cid)
        self.assertEqual(self.transport.chats[cid]["channel_pts"], 10)
        self.assertEqual(self.transport.chats[cid]["history_before_id"], 7)
        self.assertFalse(self.transport.chats[cid]["history_complete"])
        self.assertEqual(self.transport.chats[cid]["history_status"], "paused")
        self.assertEqual(self.transport.finish["chat_id"], cid)
        self.assertEqual(self.transport.finish["status"], "reconciliation_required")
        self.assertEqual(self.transport.quota, 0)
        self.assertEqual(self.transport.batches, [])

    async def test_range_gap_precedes_message_ingest_with_zero_quota(self):
        self.transport.quota = 0
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0)})
        await self.tg.connect()
        self.client.handlers[f.updates.GetDifferenceRequest] = [t.updates.Difference(
            [message(11)], [], [t.UpdateChannelAvailableMessages(8, 7)], [], [], update_state(11, 2))]
        with self.assertRaises(s.SafeError):
            await self.runner.global_difference()
        self.assertEqual(self.transport.finish["chat_id"], "-1000000000008")
        self.assertEqual(self.transport.state["reconciliation_required"],
                         dict(scope="channel", chat_id="-1000000000008"))
        self.assertEqual(self.transport.state["global"], GLOBAL)
        self.assertEqual(self.transport.batches, [])
        self.assertEqual(self.transport.messages, {})
        self.assertNotIn("-1000000000008", self.transport.chats)

    async def test_gap_finish_followed_by_final_finish_409_preserves_flag(self):
        self.transport.quota = 0
        self.client.handlers[f.updates.GetDifferenceRequest] = [t.updates.DifferenceTooLong(99)]
        with patch.object(self.runner, "discover", AsyncMock()), \
                patch.object(self.runner, "refresh_metadata", AsyncMock()):
            self.assertEqual(await self.runner.run(), "error")
        finishes = [data for endpoint, data, _ in self.transport.requests if endpoint == "finish"]
        self.assertEqual(len(finishes), 2)
        self.assertEqual(finishes[0], finishes[1])
        self.assertEqual(self.transport.finish["status"], "reconciliation_required")
        self.assertEqual(self.transport.state["reconciliation_required"], {"scope": "global"})
        self.assertEqual(self.transport.state["global"], GLOBAL)
        self.assertEqual(self.transport.quota, 0)
        self.assertEqual(self.transport.batches, [])

    async def test_multiple_range_gap_chats_escalate_to_global_finish(self):
        self.transport.quota = 0
        self.prepared()
        with self.assertRaises(s.SafeError):
            await self.runner.other_updates([t.UpdateChannelAvailableMessages(8, 7),
                                             t.UpdateChannelAvailableMessages(9, 6)])
        self.assertNotIn("chat_id", self.transport.finish)
        self.assertEqual(self.transport.state["reconciliation_required"], {"scope": "global"})
        self.assertEqual(self.transport.quota, 0)
        self.assertEqual(self.transport.batches, [])

    async def test_first_gap_finish_409_is_not_treated_as_acknowledged(self):
        self.prepared()
        self.transport.failures = [("finish", 409)]
        with self.assertRaises(s.HttpFailure) as raised:
            await self.runner.gap()
        self.assertEqual(raised.exception.status, 409)
        self.assertIsNone(self.runner._gap_finish_body)
        self.assertNotIn("reconciliation_required", self.runner.update)
        self.assertNotIn("reconciliation_required", self.transport.state)

    async def test_ordinary_final_finish_409_is_not_ignored(self):
        self.transport.failures = [("finish", 409)]
        self.assertEqual(await self.runner.run(), "error")
        self.assertIsNone(self.runner._gap_finish_body)

    async def test_regular_finish_statuses_do_not_clear_existing_gap(self):
        marker = dict(scope="channel", chat_id="-1000000000008")
        self.transport.state["reconciliation_required"] = copy.deepcopy(marker)
        for status in ("idle", "quota", "error", "flood_wait"):
            self.transport.lease_active = True
            await self.broker.post("finish", dict(lease_id="fake-lease", generation=1,
                                                  status=status), finishing=True)
            self.assertEqual(self.transport.state["reconciliation_required"], marker)
            self.assertEqual(self.transport.state["global"], GLOBAL)

    async def test_claimed_gap_stops_before_connect_and_regular_finish_preserves_it(self):
        self.transport.state["reconciliation_required"] = {"scope": "global"}
        self.assertEqual(await self.runner.run(), "error")
        self.assertNotIn("connect", self.client.calls)
        self.assertEqual(self.transport.finish["status"], "error")
        self.assertEqual(self.transport.state["reconciliation_required"], {"scope": "global"})
        self.assertEqual(self.transport.batches, [])

    async def test_gap_finish_rejects_noncanonical_chat_id_before_transport(self):
        self.prepared()
        with self.assertRaises(s.SafeError):
            await self.runner.gap("-01000000000008")
        self.assertEqual(self.transport.requests, [])

    async def test_common_deletion_uses_one_global_id_not_peer_fanout(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private"),
                       "-7": dict(chat_id="-7", chat_type="group"),
                       "-1000000000008": dict(chat_id="-1000000000008", chat_type="channel")})
        await self.runner.deletions([5])
        self.assertEqual(self.transport.tombstones, set())
        self.assertEqual(self.transport.global_tombstones, {5})
        self.assertEqual(len(self.transport.batches), 1)
        self.assertEqual(self.transport.batches[0]["global_deleted"], [5])

    async def test_common_delete_ids_resume_between_runs_under_credit_limit(self):
        self.transport.quota = 76
        self.prepared({"2": dict(chat_id="2", chat_type="private"),
                       "3": dict(chat_id="3", chat_type="private")})
        with self.assertRaises(s.StopRun):
            await self.runner.deletions([5, 6], event_pts=11)
        self.assertEqual(self.transport.global_tombstones, {5})
        self.assertEqual(self.transport.state["common_delete_cursor"]["after_message_id"], 5)
        self.assertNotIn("chat_id", self.transport.state["common_delete_cursor"])
        # An independent run restores opaque state from claim, not RAM.
        restored = s.Runner(self.tg, self.broker, 1, self.budget)
        restored.lease, restored.generation = "fake-lease", 1
        restored.chats = copy.deepcopy(self.transport.chats)
        restored.update = copy.deepcopy(self.transport.state)
        restored.quota = self.transport.quota = 76
        await restored.deletions([5, 6], event_pts=11)
        self.assertEqual(self.transport.global_tombstones, {5, 6})
        self.assertEqual(self.transport.batches[-1]["global_deleted"], [6])
        self.assertNotIn("common_delete_cursor", restored.update)
        self.assertEqual(restored.update["common_delete_pts"], 11)
        before = len(self.transport.batches)
        await restored.deletions([5, 6], event_pts=11)
        self.assertEqual(len(self.transport.batches), before)

    async def test_global_tombstone_blocks_later_unknown_dialog_not_channels(self):
        self.prepared()
        await self.runner.deletions([5], event_pts=11)
        self.runner.entities["2"] = user(2)
        self.runner.entities["-1000000000008"] = channel(8)
        await self.runner.messages([s.normalize_message(message(5), {})])
        await self.runner.messages([s.normalize_message(message(5, t.PeerChannel(8)), {})])
        self.assertNotIn(("2", 5), self.transport.messages)
        self.assertIn(("-1000000000008", 5), self.transport.messages)

    async def test_global_delete_actual_affected_rows_use_receipt_quota(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=5)})
        self.transport.messages[("2", 5)] = s.normalize_message(message(5), {})
        before = self.runner.quota
        await self.runner.deletions([5], event_pts=11)
        self.assertEqual(self.runner.quota, before - 64 - 12 - 6)
        self.assertNotIn(("2", 5), self.transport.messages)

    async def test_global_delete_chunks_at_100_and_has_constant_cost_across_peers(self):
        self.prepared({str(i): dict(chat_id=str(i), chat_type="private") for i in range(1, 501)})
        await self.runner.deletions(list(range(1, 102)), event_pts=120)
        self.assertEqual([len(b["global_deleted"]) for b in self.transport.batches], [100, 1])
        self.assertEqual(self.transport.quota, 45000 - 2 * 64 - 101 * 12)
        self.assertEqual(self.runner.update["common_delete_pts"], 120)

    async def test_stable_metadata_does_not_rewrite_entire_account(self):
        chats = {str(i): dict(chat_id=str(i), chat_type="private", top_message_id=10,
                              latest_synced_id=10, history_complete=True)
                 for i in range(100, 351)}
        self.transport.chats = copy.deepcopy(chats)
        self.client.entities = [user(i) for i in range(100, 351)]
        self.assertEqual(await self.runner.run(), "idle")
        rewritten = sum(len(b.get("dialogs", [])) for b in self.transport.batches)
        self.assertEqual(rewritten, 25)

    async def test_dialog_refresh_does_not_overwrite_old_channel_pts(self):
        cid = "-1000000000008"
        self.prepared({cid: dict(chat_id=cid, chat_type="channel", top_message_id=10,
                                 channel_pts=5)})
        result = dialogs_result([channel(8)])
        self.runner.remember(result)
        record = self.runner.dialog_record(result.dialogs[0], result, 0)
        await self.runner.store_dialogs([record], {cid: 10}, force=True)
        self.assertEqual(self.transport.chats[cid]["channel_pts"], 5)

    async def test_unknown_update_peer_gets_metadata_before_messages(self):
        self.prepared()
        self.runner.entities["2"] = user(2)
        await self.runner.messages([s.normalize_message(message(4), {})])
        self.assertIn("dialogs", self.transport.batches[0])
        self.assertIn("messages", self.transport.batches[1])

    async def test_initial_global_baseline_precedes_dialog_read(self):
        self.transport.state = None
        self.assertEqual(await self.runner.run(), "idle")
        rpcs = [r for r in self.client.calls if isinstance(r, s.READ_RPCS)]
        self.assertIsInstance(rpcs[0], f.updates.GetStateRequest)
        self.assertEqual(self.transport.state["global"], GLOBAL)

    async def test_ephemeral_marker_can_advance_same_batch_history_checkpoint(self):
        self.prepared({"2": dict(chat_id="2", chat_type="private", latest_synced_id=0)})
        row = s.normalize_message(message(1, ttl_period=60, message="synthetic-self-destruct"), {})
        await self.runner.messages([row], history_cid="2")
        self.assertEqual(self.transport.messages[("2", 1)]["body"], "[ephemeral]")
        self.assertEqual(self.transport.chats["2"]["history_before_id"], 1)
        self.assertEqual(self.transport.chats["2"]["latest_synced_id"], 1)

    async def test_local_qr_wrong_owner_never_exports_session(self):
        qr = SimpleNamespace(url="synthetic-not-a-login-token", wait=AsyncMock())
        client = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock(),
                                 qr_login=AsyncMock(return_value=qr),
                                 get_me=AsyncMock(return_value=user(99)))
        with patch.object(login, "TelegramClient", return_value=client), \
                patch.object(login, "show_qr"), \
                patch.object(login, "write_private_session") as writer, \
                redirect_stdout(io.StringIO()), self.assertRaises(s.SafeError):
            await login.authorize(1, "0" * 32, 1, Path.home())
        writer.assert_not_called()
        client.disconnect.assert_awaited_once()

    async def test_resumable_dialog_cursor_rehydrates_prefix_without_skipping(self):
        self.client.entities = [user(2), user(3)]
        self.transport.cursor = dict(v=1, folder=0, phase="page", id=10,
                                     date=s.utc(DATE), peer=s.packed_peer(t.InputPeerUser(2, 123)))
        self.transport.chats["2"] = dict(chat_id="2", chat_type="private", latest_synced_id=0)
        self.assertEqual(await self.runner.run(), "idle")
        self.assertIn("2", self.runner.peers)
        self.assertIn("3", self.runner.peers)
        self.assertTrue(self.transport.complete)
        self.assertEqual(self.transport.cursor, {})

    async def test_history_unavailable_is_not_complete(self):
        self.client.entities = [user(2)]
        self.client.handlers[f.messages.GetHistoryRequest] = [errors.PeerIdInvalidError(None)]
        self.assertEqual(await self.runner.run(), "idle")
        self.assertEqual(self.transport.chats["2"]["history_status"], "unavailable")
        self.assertFalse(self.transport.chats["2"]["history_complete"])

    async def test_oidc_refreshes_before_five_minutes_and_expiry(self):
        clock = Clock()
        class OidcTransport:
            calls = 0
            async def request(inner, method, url, headers, body, timeout):
                inner.calls += 1
                claims = base64.urlsafe_b64encode(s.json_bytes({"exp": 1000 + clock.now + 300})).decode().rstrip("=")
                return 200, s.json_bytes({"value": "header." + claims + ".signature"})
        transport = OidcTransport()
        tokens = s.OidcTokens(transport, "https://vstoken.actions.githubusercontent.com/synthetic?api-version=2.0",
                              "synthetic-request-token", "synthetic-audience", clock=clock,
                              wall=lambda: 1000 + clock.now)
        await tokens.get()
        clock.now = 239
        await tokens.get()
        self.assertEqual(transport.calls, 1)
        clock.now = 240
        await tokens.get()
        self.assertEqual(transport.calls, 2)


def StringSessionForTest():
    # Empty memory session, no auth key, file, login or external connection.
    return s.StringSession()


class PureTests(unittest.TestCase):
    def test_ttl_and_view_once_never_retain_content(self):
        specimens = [message(1, ttl_period=60),
                     message(2, media=t.MessageMediaPhoto(ttl_seconds=10)),
                     message(3, media=t.MessageMediaDocument(ttl_seconds=2147483647))]
        marked = message(4)
        marked.view_once = True
        specimens.append(marked)
        for msg in specimens:
            with self.subTest(mid=msg.id):
                msg.message = "synthetic-ephemeral-content-never-persist"
                msg.from_id = t.PeerUser(2)
                row = s.normalize_message(msg, {"2": user(2)})
                self.assertEqual(row["content_type"], "ephemeral")
                self.assertEqual(row["body"], "[ephemeral]")
                self.assertEqual(row["sender_name"], "[hidden]")
                self.assertNotIn(b"synthetic-ephemeral-content", s.json_bytes(row))

    def test_nested_sensitive_state_keys_rejected(self):
        for key in ("session", "auth_key", "api_hash", "api_id", "password", "phone", "token", "secret"):
            with self.subTest(key=key), self.assertRaises(s.SafeError):
                s.state_size({"v": 1, "nested": [{"prefix_" + key + "_suffix": "synthetic"}]})
        self.assertEqual(s.state_size({"peer": {"access_hash": "123"}})["peer"]["access_hash"], "123")

    def test_login_forbids_ci_and_noninteractive_output(self):
        class Terminal:
            def isatty(self):
                return True
        class Pipe:
            def isatty(self):
                return False
        with self.assertRaises(s.SafeError):
            login.require_local_terminal({"CI": "true"}, Terminal(), Terminal())
        with self.assertRaises(s.SafeError):
            login.require_local_terminal({}, Terminal(), Pipe())

    def test_login_main_does_not_connect_or_echo_credentials_in_ci(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"CI": "true", "TELEGRAM_API_HASH": "synthetic-token-never-print"}), \
                patch.object(login, "TelegramClient") as factory, redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(login.main(["--start-qr", "--output-dir", str(Path.home() / "not-created")]), 1)
        factory.assert_not_called()
        self.assertNotIn("synthetic-token", output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())

    def test_qr_render_is_local_matrix_not_raw_token_url(self):
        output = io.StringIO()
        with redirect_stdout(output):
            login.show_qr("synthetic-not-a-telegram-login-token")
        self.assertGreater(len(output.getvalue()), 100)
        self.assertNotIn("synthetic-not-a-telegram-login-token", output.getvalue())

    def test_login_refuses_repository_session_directory(self):
        path = Path(__file__).resolve().parents[1] / "never-created-session-directory"
        with self.assertRaises(s.SafeError):
            login.private_directory(path)
        self.assertFalse(path.exists())

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI check")
    def test_windows_session_file_is_encrypted_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = login.private_directory(Path(temporary) / "synthetic-private-session")
            login.write_private_session(directory, "synthetic-not-a-telegram-session")
            raw = (directory / "session.dpapi").read_bytes()
            self.assertNotIn(b"synthetic-not-a-telegram-session", raw)
            with self.assertRaises(FileExistsError):
                login.write_private_session(directory, "synthetic-second-session")

    def test_canonical_ids(self):
        self.assertEqual(s.canonical(t.PeerUser(3)), "3")
        self.assertEqual(s.canonical(t.PeerChat(7)), "-7")
        self.assertEqual(s.canonical(t.PeerChannel(8)), "-1000000000008")

    def test_chat_ids_are_nonzero_canonical_signed_int64(self):
        for value in ("0", "-0", "01", "-01", "+1", "9223372036854775808", "-9223372036854775809"):
            with self.subTest(value=value), self.assertRaises(s.SafeError):
                s.chat_id(value)
        self.assertEqual(s.chat_id("9223372036854775807"), "9223372036854775807")
        self.assertEqual(s.chat_id("-9223372036854775808"), "-9223372036854775808")

    def test_chat_id_sign_and_marked_range_match_type(self):
        for value, kind in (("1", "private"), ("2", "bot"), ("1", "saved"),
                            ("-999999999999", "group"), ("-1000000000000", "channel"),
                            ("-1000000000008", "supergroup")):
            self.assertEqual(s.chat_id(value, kind), value)
        for value, kind in (("-7", "private"), ("7", "group"), ("-1000000000000", "group"),
                            ("-8", "channel"), ("8", "supergroup")):
            with self.subTest(value=value, kind=kind), self.assertRaises(s.SafeError):
                s.chat_id(value, kind)

    def test_media_metadata_not_uploaded_and_captions_preserved(self):
        media = t.MessageMediaContact("synthetic-phone", "synthetic-contact", "", 42, "synthetic-vcard")
        row = s.normalize_message(message(1, media=media), {})
        self.assertEqual(row["body"], "synthetic body")
        self.assertEqual(row["content_type"], "contact")
        raw = s.json_bytes(row)
        self.assertNotIn(b"synthetic-phone", raw)
        self.assertNotIn(b"synthetic-vcard", raw)
        row = s.normalize_message(message(1, media=media, message=""), {})
        self.assertEqual(row["body"], "[contact]")

    def test_normalization_utc_bounds_and_controls(self):
        msg = message(7, from_id=t.PeerUser(2), out=True, message="a\x00b\u202e" + "x" * 7000)
        msg.date = DATE.astimezone(timezone(timedelta(hours=3)))
        row = s.normalize_message(msg, {"2": t.User(2, first_name="N" * 200)})
        self.assertEqual(row["sent_at"], "2024-01-01T00:00:00Z")
        self.assertEqual(row["direction"], "outgoing")
        self.assertEqual(len(row["body"]), 6000)
        self.assertTrue(row["body"].startswith("ab"))
        self.assertEqual(len(row["sender_name"]), 120)

    def test_utf16_limits_and_nonempty_fields_match_backend(self):
        row = s.normalize_message(message(7, message="\U0001f600" * 6000), {})
        self.assertEqual(len(row["body"].encode("utf-16-le")) // 2, 6000)
        self.assertEqual(len(row["body"]), 3000)
        self.assertEqual(row["sender_name"], "[unknown]")
        empty = s.normalize_message(message(1, message="\x00\n\t"), {})
        self.assertEqual(empty["body"], "[empty]")

    def test_empty_and_invalid_message_do_not_imply_deletion(self):
        self.assertIsNone(s.normalize_message(t.MessageEmpty(1, t.PeerUser(2)), {}))
        with self.assertRaises(s.SafeError):
            s.normalize_message(message(2147483648), {})

    def test_cursor_and_state_bounds(self):
        peer = t.InputPeerChannel(8, 123)
        self.assertEqual(s.canonical(s.unpacked_peer(s.packed_peer(peer))), s.canonical(peer))
        with self.assertRaises(s.SafeError):
            s.state_size({"large": "x" * 17000})

    def test_https_origin_rejects_redirectable_input(self):
        for value in ("http://synthetic.invalid", "https://u:p@synthetic.invalid", "https://synthetic.invalid/path", "https://synthetic.invalid/?x=1"):
            with self.assertRaises(s.SafeError):
                s.https_url(value, origin=True)

    def test_main_logs_only_fixed_status(self):
        async def fail():
            raise RuntimeError("synthetic body, peer title, auth string")
        output = io.StringIO()
        with patch.object(s, "async_main", fail), redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(s.main(), 1)
        self.assertEqual(output.getvalue(), "Account context sync: error\n")

    def test_workflow_is_gated_main_only_no_data_cache_or_artifacts(self):
        path = Path(__file__).resolve().parents[1] / ".github/workflows/telegram-context-sync.yml"
        workflow = path.read_text(encoding="utf-8")
        self.assertIn("vars.TELEGRAM_CONTEXT_SYNC_ENABLED == 'true'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("timeout-minutes: 8", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertNotIn("upload-artifact", workflow)
        self.assertNotIn("actions/cache", workflow)
        self.assertNotIn("pull_request", workflow)


if __name__ == "__main__":
    unittest.main()
