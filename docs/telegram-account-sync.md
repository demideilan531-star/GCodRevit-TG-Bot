# Telegram Account Archive

Status: implementation in progress, not enabled in production. The existing Secretary collector and scoped share links remain the active integration.

Setup blocker (2026-10-26): the owner authorized creation of `GCod Personal Context` on the official `my.telegram.org/apps` page. After a fresh sign-in, Telegram rejected creation with `Too many attempts. Please try again later.` No application credentials or user session were obtained. The page did not provide a retry time. Do not repeatedly submit, rotate identities, use a different API application to evade this limit, or enable production synchronization without the owner's completed authorization.

## Scope

The owner requested automatic access to the complete available cloud dialog list and old history, including archived dialogs, groups and channels. This requires a separate user-authorized MTProto client; the Bot API cannot supply the user's dialog list or old history. Secret chats from other devices, deleted messages and inaccessible history cannot be recovered by a new session.

The client code must not send messages, join chats, change profile or message state, or automatically forward the archive to an AI service. Telegram does not issue a read-only user session: a leaked session still grants broad account access. The owner must approve sign-in and can terminate that session in Telegram Settings / Devices.

## Components

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
