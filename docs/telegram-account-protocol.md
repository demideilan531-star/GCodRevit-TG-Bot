# Account Context Sync Protocol (Implementation Contract)

The account setup is still blocked by Telegram application registration. All examples are fictional. No production session is available, and no account sync is enabled.

## Runner

Use Telethon 1.45.0 and its public APIs, with credentials from `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION`. Do not reuse a published/default API ID. `TELEGRAM_ACCOUNT_OWNER_ID` is a required numeric account ID; call get_me and compare IDs before fetching dialogs or history. `TELEGRAM_CONTEXT_BROKER_URL` is an HTTPS origin. GitHub Actions provides OIDC; request a token with audience from `TELEGRAM_CONTEXT_OIDC_AUDIENCE`. Never print credentials, session strings, QR tokens, peer titles, message bodies, HTTP response bodies or cursors. No artifacts/cache containing account data.

The dedicated workflow is `.github/workflows/telegram-context-sync.yml`, main branch only, `workflow_dispatch` and schedule every 15 minutes. `permissions: contents: read, id-token: write`; one concurrency group, no overlapping sessions. It must be gated by repository variable `TELEGRAM_CONTEXT_SYNC_ENABLED == 'true'`. A run is bounded to 8 minutes, honors FloodWait, and does not log in interactively. The first authorization is a separate, local bootstrap, not part of Actions.

## JSON API

All internal endpoints are POST under `/internal/account-context/`. Send `Authorization: Bearer <short-lived GitHub OIDC token>`, JSON, max 1 MiB. No Telegram session or API credentials are sent to this API. The backend binds every operation to its configured owner, never an owner from the body.

- `claim` body `{}`. Returns `{owner_id, generation, lease_id, lease_until, quota_remaining, dialogs_complete, dialog_cursor, update_state}`. Disabled/unconfigured = 409/503, another active run = 409. Lease is ten minutes and idempotent for the same signed run.
- `state` body `{lease_id, generation, after_chat_id?: string}`. Returns `{chats, next_chat_id}` in canonical chat ID lexical order, 200 per page. Chat fields: `chat_id`, `chat_type`, `top_message_id`, `latest_synced_id`, `history_before_id`, `history_complete`, `history_status`, `channel_pts`, `deleted_before_id`. No body text is returned.
- `batch` body `{lease_id, generation, batch_id, dialogs?: [], messages?: [], deleted?: [], checkpoints?: [], state?: {dialogs_complete?, dialog_cursor?, update_state?}}`. `batch_id` is UUIDv4; retain it across retries of the exact same body. Different body under the same ID = 409. Returns `{ok:true, batch_id, quota_remaining}` after a committed, idempotent batch. 429 = daily write budget exhausted; 507 = storage watermark, stop the run. Other failures do not advance cursors.
- `finish` body `{lease_id, generation, status: 'idle'|'flood_wait'|'quota'|'error'|'reconciliation_required', retry_after_seconds?: integer, chat_id?: canonical string}`. Releases the lease and sets a generic public status. `chat_id` is allowed only with `reconciliation_required`; omitted means a global gap. This privacy stop writes a durable global/per-chat marker independently of exhausted ingestion credits. It preserves previous update cursors, blocks further claims and denies affected body reads/exports/shares until deliberate reconciliation. Known affected chat history becomes paused, never complete. No exception strings or message contents in the request. Returns `{ok:true}`. Do not mark history complete here.

Batch record cap: each array <=100 and sum of array lengths <=200. An additional `global_deleted` array contains common-message IDs (positive integers) from explicit `UpdateDeleteMessages` events. The common sequence is account-wide for private chats, saved messages, bots and basic groups, not for channels/supergroups. The backend stores one account-wide tombstone per ID, including for common dialogs not discovered yet; do not fan out these events to every chat. Per-channel deletions still use `deleted` with a chat ID. Budget for global deletion is 12 credits per ID plus 6 per existing affected archive message.

- Dialog: `{chat_id: string, chat_type: 'private'|'bot'|'group'|'supergroup'|'channel'|'saved', chat_title: string<=180, archived: boolean, top_message_id: nonnegative integer, last_message_at: ISO UTC|null}`.
- Message: `{chat_id: string, message_id: positive integer, sender_name: string<=120, direction:'incoming'|'outgoing', content_type: string<=32, body: string<=6000, sent_at: ISO UTC, edited_at: ISO UTC|null}`. Preserve text and captions. Other media become safe textual markers; do not download attachments, copy media paths, file IDs, phone numbers or coordinates.
- Deleted: `{chat_id:string, message_id:positive integer}`. Only explicit Telegram deletion events, never infer from a partial history response.
- Checkpoint: `{chat_id:string, latest_synced_id?:nonnegative integer, history_before_id?:positive integer|null, history_complete?:boolean, history_status?:'pending'|'loading'|'complete'|'unavailable'|'paused', channel_pts?:nonnegative integer|null}`.

All dates normalize to ISO UTC. Canonical chat IDs must match Bot API IDs (`telethon.utils.get_peer_id`): private positive, basic groups negative, channels/supergroups `-100...`. IDs are strings in JSON, message IDs are <=2147483647.

Only metadata fields specified here are accepted. `dialog_cursor` and `update_state` are bounded structured JSON (<=16KiB each), never serialization of a client/session/entity. A dialog cursor can include offsets and peer IDs required for paging; no auth keys, login data or API hash.

## Correctness

Get the entire dialog index, including archive folder, with explicit pagination/resume. Do not hard-cap the account to 200 dialogs. Fetch metadata before history. Persist committed batches before changing local cursors. A timeout, per-run budget, FloodWait or page cap never implies history is exhausted.

Global update state and per-channel pts must survive separate runs. A StringSession alone does not save them. Process explicit new/edit/delete differences, acknowledge state only after those changes commit; handle difference-too-long as incomplete reconciliation, not success. Fetch old history progressively with a separate decreasing history cursor. Use exclusive min/max IDs carefully, including ID 1.

Read operations only: no send/join/profile changes/read acknowledgements. The code should use a narrow explicit RPC allowlist or wrapper so unrelated client helpers cannot accidentally send messages. Do not bypass Telegram limits or present artificial progress as full completion.

Old Secretary links keep the Secretary source. New account-archive links use a separately signed scope and require explicit context-specific sharing consent.
