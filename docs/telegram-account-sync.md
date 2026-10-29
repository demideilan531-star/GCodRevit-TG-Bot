# Telegram Account Archive

Status: draft implementation with offline verification, not enabled in production. The existing Secretary collector and scoped share links remain the active integration. No real-account completeness or live Telegram authorization has been verified.

Setup blocker (2026-10-26): the owner authorized creation of `GCod Personal Context` on the official `my.telegram.org/apps` page. After a fresh sign-in, Telegram rejected creation with `Too many attempts. Please try again later.` No application credentials or user session were obtained. The page did not provide a retry time. Do not repeatedly submit, rotate identities, use a different API application to evade this limit, or enable production synchronization without the owner's completed authorization.

A single delayed normal retry returned the sign-in page again. It did not prove application creation or resolve the earlier restriction. No repeated retry job was created.

## Scope

The owner requested automatic access to the complete available cloud dialog list and old history, including archived dialogs, groups and channels. This requires a separate user-authorized MTProto client; the Bot API cannot supply the user's dialog list or old history. Secret chats from other devices, deleted messages and inaccessible history cannot be recovered by a new session.

The client code must not send messages, join chats, change profile or message state, or automatically forward the archive to an AI service. Telegram does not issue a read-only user session: a leaked session still grants broad account access. The owner must approve sign-in and can terminate that session in Telegram Settings / Devices.

## Components

The separate continuous-service implementation and its still-pending activation
gates are documented in `docs/telegram-account-service.md`. It reuses the broker
and UI below but does not require Actions OIDC. Service authentication is disabled
unless explicitly configured; it does not remove the owner-consent requirement.

- An official, owner-created Telegram API application; the account owner enters login codes and any 2FA password outside this chat.
- A mature Telethon client, pinned to a verified release, with no custom MTProto implementation.
- Resumable, budget-limited background synchronization in the existing GitHub Actions project. Scheduled runs can be delayed and are not a real-time transport. The existing Secretary webhook continues receiving eligible new private-chat messages.
- Private account archive tables in a separate planned `ACCOUNT_CONTEXT_DB` binding, independent of `CHAT_CONTEXT_DB` and the Secretary connection tables. History is retained until explicitly deleted, rather than filtered by its original message date. The draft schema is in `cloudflare-worker/account-migrations/0001_create_account_archive.sql`; this database has not yet been created or migrated remotely.
- A narrowly authenticated ingest API using GitHub OIDC, restricted to the exact repository ID, main branch, dedicated workflow, event type and audience. No permanent bearer credential in URLs.
- The existing owner-authenticated Mini App for dialog discovery, pagination and scoped sharing. Other allowed assistant users never inherit access to this account's archive.

## Required Invariants

1. A run must verify that the signed-in Telegram account ID matches the configured owner before reading or storing any dialog.
2. All record keys and deduplication use owner, canonical Telegram chat ID and message ID. Secretary and account copies of a message must not appear twice.
3. Cursors advance only with a committed, idempotent batch. Replays do not consume another quota or skip history.
4. Exhausting a run's time or row budget is not evidence that history is complete. Completion requires an exhausted Telegram history iterator; dialog discovery has a separate completion flag.
5. One expiring lease per owner, bound to a workflow run and generation. Pause, reset and deletion invalidate stale writes.
6. Chat/message tombstones prevent an in-flight or retried backfill from resurrecting deleted context.
7. New messages, history backfill and recent edits have separate checkpoints. The archive does not infer deletion from an incomplete or failed page.
8. Account data, API hash, auth session, login codes, QR login tokens and message bodies never enter Git logs, Actions logs, artifacts, caches or test fixtures.
9. The client honors FloodWait. No account/session rotation or rate-limit evasion. Backfill pauses on quota, storage pressure or unavailable history and reports the reason.
10. No billing activation or paid resources. Initial quota budgets must leave headroom for existing bot functions; a large archive may require multiple days or an explicitly approved storage change.
11. Existing public links remain scoped, expiring and revocable. No account-wide public endpoint or automatically created share link.
12. Previously issued Secretary links must keep their original data source; archive messages must not be merged into their responses implicitly. New archive sharing requires explicit source selection and a newly signed scope. Preserve v1 signatures for existing links.
13. Synchronization is disabled by default. Only activate it after account-ID verification and explicit owner confirmation; stop or disconnect are distinct from terminating the Telegram session itself.
14. Persist a dialog-discovery cursor and global/per-channel Telegram update state, not just per-chat newest message IDs. A StringSession contains authorization, not a complete update checkpoint. Recent-message rescans alone cannot guarantee old edits and deletions are captured.
15. Reserve a conservative write budget before accepting each batch, reconcile it with actual D1 rows-written metrics, and include index, checkpoint, deletion, receipt and control writes. A message count is not a D1 write count. Enforce a storage watermark before the archive database is full.

## Activation Gates

1. The owner obtains their own Telegram application credentials and completes the local QR bootstrap described in `telegram-account-client.md`. Authorization sessions are broad account credentials, not read-only keys. Keep all credential values out of chat, Git and recordings.
2. Provision the session and API credentials to this repository's encrypted GitHub Secrets using a separately reviewed, owner-approved secret-provisioning step. The current bootstrap only creates a locally protected session file; secret upload is not implemented.
3. Create a separate D1 archive database without Billing. Add its real `ACCOUNT_CONTEXT_DB` binding with `account-migrations` to the Worker configuration and apply that migration only to that new database. Do not migrate or replace the Secretary or task databases.
4. Configure Worker variables: `TELEGRAM_ACCOUNT_OWNER_ID` (the verified administrator ID), `TELEGRAM_CONTEXT_REPOSITORY_ID` (immutable GitHub numeric repository ID), `TELEGRAM_CONTEXT_OIDC_AUDIENCE` (a fixed audience shared with the workflow), and an initial `TELEGRAM_ACCOUNT_DAILY_WRITE_BUDGET` of 45000. `GITHUB_REPOSITORY` must remain the exact repository slug. Set `TELEGRAM_ACCOUNT_SYNC_ENABLED=true` only after these checks. This does not enable the owner's control row by itself.
5. Configure repository variables `TELEGRAM_CONTEXT_BROKER_URL` (this Worker's HTTPS origin) and the same audience. Keep `TELEGRAM_CONTEXT_SYNC_ENABLED=false` while preparing. No new permanent Worker ingest token is needed.
6. Review/merge the feature, deploy the Worker, explicitly confirm the owner's account in the authenticated Mini App, then enable the repository gate. First use a manual workflow run and verify metadata counts and progress without printing message bodies. Only then leave the 15-minute schedule enabled. Existing webhooks and crons need no replacement.
7. Test pause/restart, a selected old chat, a new message, an edit, a deletion and a separately consented expiring share. Revoke the test share afterwards. A partially loaded history is not a successful full-account test.

Current implementation pauses safely on update gaps and inaccessible histories. Automatic full reconciliation after `DifferenceTooLong`, physical range purges, and recovery after lost chat permissions are not implemented. Gap markers block affected private reads and both new and previously issued context links; metadata stays visible. Do not clear a marker or reset a baseline and call it reconciliation. Large archives can also exhaust the free storage or write budget before completion. These limitations must be reviewed before production activation, not concealed as a completed integration.

Rollback: disable the repository gate, pause the archive in the Mini App, and set the Worker feature flag false. Revoke the dedicated device in Telegram Settings / Devices to revoke the session itself. Do not drop databases or permanently delete archives without a separate owner decision.

## Privacy And Terms

The archive is private by default. Exporting selected context to another agent is a separate user action, not a blanket license to feed all stored chats to AI. Telegram's current content licensing terms require explicit, informed, continuing and context-specific consent from all relevant users for the described AI uses. Do not claim that personal account authorization alone provides that consent.

References:

- https://core.telegram.org/api/obtaining_api_id
- https://core.telegram.org/api/auth
- https://core.telegram.org/method/messages.getDialogs
- https://core.telegram.org/method/messages.getHistory
- https://core.telegram.org/api/terms
- https://telegram.org/tos/content-licensing
- https://docs.github.com/en/actions/reference/security/oidc
- https://developers.cloudflare.com/d1/platform/limits/
