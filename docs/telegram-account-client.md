# Telegram Account Client

Implementation only. No real API application/session exists, no authorization has
been attempted by this client, and synchronization must remain disabled while
Telegram application creation is blocked. Do not retry `my.telegram.org` or use
someone else's application credentials to evade that restriction.

## Files And Verification

For the separate always-running Linux service transport, see
`docs/telegram-account-service.md`. The Actions runner below stays available as a
bounded scheduled alternative, not as a 24/7 process. Neither mode is enabled in
production yet.

- `scripts/telegram_account_sync.py`: non-interactive read-only runner.
- `scripts/telegram_account_login.py`: separately invoked, local QR bootstrap.
- `scripts/telegram-account-requirements.txt`: Telethon 1.45.0 and pinned dependencies.
- `.github/workflows/telegram-context-sync.yml`: main-only, opt-in scheduled job.
- `tests/test_telegram_account_sync.py`: synthetic clients and HTTP transports only.

Install the requirements into an isolated environment, then run from the repository:

```powershell
python -B -m unittest discover -s tests -p test_telegram_account_sync.py
```

No test needs account credentials, Telegram access, a live broker, or fake live
authentication. Dependency installation is separate from the network-free tests.

## Workflow And Credentials

The repository variable `TELEGRAM_CONTEXT_SYNC_ENABLED` must be unset or `false`
until the owner is ready, the private backend is configured, and the authorization
has been explicitly approved. This implementation does not set that variable.

Required GitHub Secrets: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_USER_SESSION`, `TELEGRAM_ACCOUNT_OWNER_ID`. Required repository variables:
`TELEGRAM_CONTEXT_BROKER_URL` (HTTPS origin only),
`TELEGRAM_CONTEXT_OIDC_AUDIENCE`. GitHub supplies `ACTIONS_ID_TOKEN_REQUEST_URL`
and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; these are not permanent broker secrets.

The workflow runs only on `refs/heads/main`, for manual dispatch or the 15-minute
schedule. One concurrency group queues runs without cancelling a session in
flight. Job timeout is eight minutes. The runner normally budgets seven minutes,
reserves time for `finish`/disconnect and has a 475-second outer watchdog. Setup
time counts against the job timeout. A hard job cancellation may leave the lease
until its ten-minute expiry; it never declares history complete.

OIDC credentials are refreshed after at most 240 seconds or 30 seconds before
expiry, whichever is earlier, and once immediately on a 401. A retry retains the
exact JSON bytes and UUIDv4 batch ID. No redirects are followed. The broker must
still verify issuer, signature, audience, exact repository ID, ref, workflow path
and allowed event type. Client-side JWT decoding is only a refresh timer.

## Progress Model

The runner follows `docs/telegram-account-protocol.md`, including the backend's
`global_deleted` extension. The bounded opaque `update_state` uses schema `v: 1` with:

- `global`: `pts`, `qts`, UTC `date`, `seq`.
- `backfill_after_chat_id`: lexical round-robin history scheduling.
- `metadata_after_chat_id`: rotating title/archive metadata refresh.
- `common_delete_pts` and optional `common_delete_cursor`: continuation of a
  common-box deletion event, with event digest and exclusive message ID cursor.
- Optional `reconciliation_required`: a durable, fail-closed gap indicator.

`dialog_cursor` has `v`, `folder` (0 normal, 1 archive), `phase` (pinned/page), and
optional exclusive `id`, UTC `date`, `peer`. Only the minimal input-peer kind/ID
and access hash needed by Telegram pagination are retained. An access hash is peer
addressing metadata, not an authorization key. Neither cursor contains a session,
login token, API hash, raw entity serialization or message body. Do not log them.
Completion writes an empty cursor object `{}`, accepted by the backend's structured
state validator; a missing, null initial, or empty cursor starts a new index pass.

The client verifies `get_me().id == TELEGRAM_ACCOUNT_OWNER_ID` before archive
reads. The guarded Telethon subclass also covers `get_me` called internally by
`connect`, so a wrong account cannot progress to Telethon's state initialization.
No `start()`, phone-code fallback or auto-login occurs in the runner.

Both folders are explicitly paginated with separately fetched pinned dialogs;
there is no 200-dialog account cap. Broker `/state` also follows all 200-row pages.
Known unchanged dialogs are not all rewritten every run. New/changed-top dialogs
are stored immediately, and 25 existing dialog titles/archive flags are refreshed
per run, rotating lexically. Thus a title-only or archive-only change can be delayed
by several runs. Metadata always precedes ingestion of an unknown chat's messages.
StringSession does not retain entity access hashes; after resuming a discovery
cursor, a read-only full pass rehydrates prefix peers before history work.

Global `GetDifference` slices and channel `GetChannelDifference` slices process
new messages, edits and explicit deletions before committing their next state.
`UpdateChannelTooLong` is a catch-up trigger, not automatically a lost-history gap.
Existing channel `pts` is never overwritten by a fresh dialog snapshot. Explicit
common-box deletes have account-wide IDs but no peer ID: the client sends
`global_deleted: [message_id]` tombstones, which also protect common dialogs not
yet discovered. It never fans out a common deletion across chats. Channel deletes
still use `deleted` with a chat ID. The exclusive message-ID cursor commits with
each deletion batch so low credits do not restart the event indefinitely.

Messages/media with TTL, self-destruct, view-once or ephemeral flags, including
story media, are normalized only as `[ephemeral]` placeholders. No text, caption,
sender name or embedded media metadata from those records is ingested. Their IDs
can still advance a same-batch checkpoint. All structured-state keys are checked
recursively against the backend's sensitive-key denylist.
Empty names/text use safe placeholders, and string limits count UTF-16 code units
without splitting a Unicode scalar to match the JavaScript backend validator.
Canonical chat IDs are nonzero signed int64 strings without leading zeros; private,
bot and saved IDs are positive, basic groups are between -1e12 and zero, and marked
channel/supergroup IDs are at most -1e12.

Backfill uses decreasing exclusive `offset_id`, with `min_id=max_id=0`. One history
page (50 messages) per eligible chat per run gives other chats a turn. Message ID 1
is ingested, then a subsequent empty request proves exhaustion. A short nonempty
page, timeout, unavailable peer, quota stop or budget stop never implies completion.
`finish: idle` means only that this run stopped normally; it does not mean the
entire account or every history is complete.

Each array has at most 100 records, total at most 200, encoded JSON at most 1 MiB.
The conservative credit reservation is
`64 + messages*12 + dialogs*8 + deleted*12 + global_deleted*12 + checkpoints*4`,
not a message-count budget. The server additionally reserves 6 credits per archive
row affected by a global deletion; only it can know that count. Its committed quota
receipt is authoritative, and a rejected package never advances the deletion cursor.
Packages shrink to fit remaining base credits. Checkpoint IDs are derived only
from that package's messages and prior committed values. Server receipts are the
authority; no cursor advances on a failed package. 429/507 stop as `quota`.
FloodWait is never retried in the same run: `finish: flood_wait` includes only its
integer delay so the backend can block the next claim until the wait expires.

## Quota-Independent Gap Finish

The bounded protocol extension is on the existing `finish` endpoint, not on `batch`:

```json
{"lease_id":"fictional-lease","generation":1,"status":"reconciliation_required","chat_id":"-1000000000008"}
```

`chat_id` is optional and canonical. Without it the scope is global; with it the
scope is channel/per-chat. The request contains no update state or message data.
The backend atomically sets `update_state.reconciliation_required` to
`{scope:"global"}` or `{scope:"channel",chat_id}`, marks a known affected chat
`history_complete:false, history_status:"paused"`, and releases the lease. All
other structured state, global/channel pts and history/dialog cursors are retained.
This safety control operation is **not charged to the ingest budget** and must
work with `quota_remaining:0`. Owner, signed run, lease, generation and database-clock
expiry checks still apply; zero credits do not bypass authorization or lease expiry.

The runner calls this endpoint directly from `gap()`, checks `{ok:true}`, then raises
a fixed-message error and stops. No quota-charged batch is attempted. Cleanup repeats
the same gap-finish body; its expected 409 after the acknowledged lease release is
harmless. A first gap-finish 409, or a regular finish 409 without that acknowledgement,
is not treated as success. If the backend cannot acknowledge the safety operation,
the client does not advance progress or claim that quarantine was persisted.

Explicit `UpdateChannelAvailableMessages` signals are checked before message ingest
for the difference page and report that event's canonical channel ID. They do not
depend on the current difference call's scope or on pre-existing dialog metadata.
If one page contains gap signals for multiple chats, it escalates to the global
marker because a finish request can identify only one chat.
`UpdateDeleteHistory` is absent from Telethon 1.45.0; no support is claimed for it.

Ordinary `idle`, `quota`, `flood_wait` and `error` finishes must never clear an existing
reconciliation flag. The runner refuses archive reads on a later claim containing
one. Only deliberate owner/operator reconciliation may clear it. Backend enforcement
must deny affected private message reads, exports and new/existing account-archive
shares while the source-wide flag or affected chat's paused state applies; a status
label alone is not sufficient. The Worker implements these guards in
`src/account-visibility.js`; backend regression tests exercise them separately from
this Python client's tests.

## Local Bootstrap, Not Yet Used

Only after the owner independently obtains their own application credentials, a
person may run the bootstrap in a private local terminal. Do not invoke it from
this chat, CI, terminal recordings, or an agent. It requires TTY input/output,
`--start-qr`, and a typed `AUTHORIZE` confirmation. Credentials and expected numeric
owner ID come from the local environment, never command-line arguments or chat.

```powershell
python scripts/telegram_account_login.py --start-qr --output-dir "$env:LOCALAPPDATA\GCodTelegramAuth"
```

The output directory must be new, on a local fixed volume, under the current user,
outside repositories and common cloud-sync folders. Only one QR attempt is made;
expiry/FloodWait never automatically creates another. A QR is displayed directly
in that person's terminal, never printed as a token URL or written to an image.
Any 2FA password uses hidden terminal input. Do not capture or forward the QR.

The expected owner is checked before exporting a session. On Windows the directory
ACL grants only the current user and `session.dpapi` is additionally encrypted by
current-user Windows DPAPI. On POSIX the directory/file modes are 0700/0600 and
`session.txt` contains the StringSession. Existing files are never overwritten.
No SQLite session file is created. Python cannot guarantee memory zeroization.

This utility does not upload GitHub Secrets or enable the workflow. A separate,
owner-operated secret provisioning step is still required. The Windows file is
DPAPI ciphertext, not a value to paste into `TELEGRAM_USER_SESSION`: it must be
decrypted in memory under the same Windows user/machine and delivered to GitHub
Secrets without console output. Such an upload command is intentionally not
implemented here. Terminate an unwanted device in Telegram Settings / Devices;
disabling the workflow does not revoke a Telegram session.

## Known Limits And Required Integration Work

- Live Telegram and broker integration are unverified because no real credentials
  exist. All verification is offline. Do not present this as activated production
  synchronization or proven real-account completeness.
- `DifferenceTooLong` / `ChannelDifferenceTooLong` use the quota-independent gap
  finish and stop with `error`, retaining the old update checkpoint. Automatic full gap
  reconciliation is **not implemented**. Subsequent runs fail closed until a
  deliberate operator reset/reconciliation. Old deletions cannot be reconstructed
  just by reading current history; resetting a baseline alone is not a repair.
- Range deletions such as `UpdateChannelAvailableMessages` also use gap finish and
  fail closed. The protocol still cannot ingest a range tombstone or perform a
  physical range purge. Such events are not expanded into guessed deletions; automatic
  range reconciliation and continued syncing around an affected chat are not implemented.
- Dialog ordering can move during Telegram pagination; repeated index passes discover
  peers missed by a moving snapshot. An extremely large list can exhaust a run while
  rehydrating peers. No timeout is reported as an exhausted index/history.
- An inaccessible history is marked `unavailable`, never `complete`. Automatic retry
  of such histories after permissions change is not implemented. Secret/deleted
  cloud history, attachments, stories and separate saved-topic subdialogs are not
  recovered. No send/join/read-ack/profile RPC is permitted by the runner.
- No automatic export to AI, public links, session brokering, deployment, commit or
  push is performed by the client. Context-specific sharing/consent is implemented
  separately in the authenticated backend/UI and is never initiated by this runner.

Primary implementation references: [Telethon 1.45.0](https://pypi.org/project/Telethon/1.45.0/),
[Telethon client API](https://docs.telethon.dev/en/stable/modules/client.html),
[Telegram update recovery](https://core.telegram.org/api/updates),
[common deletion event](https://core.telegram.org/constructor/updateDeleteMessages).
