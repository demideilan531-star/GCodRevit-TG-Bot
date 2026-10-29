# Continuous Telegram Account Collector

Status (2026-10-29): implementation and offline tests only. Not deployed or
authorized against the real account. The bot's current webhook, production
Worker, databases and crons have not been changed. No paid resource was created.

## Execution Plan

- [x] Inspect the existing Worker, archive draft and available infrastructure.
- [x] Add a server-mode collector that reuses the archive protocol and UI.
- [x] Add narrowly scoped, body-signed service authentication, off by default.
- [x] Add an isolated Linux container definition and synthetic regression tests.
- [ ] Finish owner-operated Telegram sign-in and official API app registration.
- [ ] Authorize a dedicated user session and verify the configured account ID.
- [ ] Confirm an existing suitable server, or approve a paid Cloudflare runtime.
- [ ] Build and smoke-test the actual Linux image on that runtime.
- [ ] Provision ACCOUNT_CONTEXT_DB, configure its gates/secrets, merge and deploy.
- [ ] Confirm owner consent in the Mini App and run real history/live/privacy QA.

## Confirmed Scope

All accessible cloud dialogs, including archived/private/bot/group/channel/saved
dialogs, with available text history, captions and attachment markers. The owner
explicitly chose not to download photos, videos, documents or voice recordings.
There is no media bucket or automatic AI analysis. Secret chats on other devices,
deleted history and inaccessible chats cannot be recovered by this client.

The account archive stays private to the configured administrator. The existing
Mini App can list/search chats, page through old messages, export Markdown and
create a separately consented, scoped expiring link. An MCP server does not gain
automatic access merely because the collection service exists.

## Runtime Design

`scripts/telegram_account_service.py` is a Linux process, separate from the bot
webhook. It keeps one authorized Telethon connection and supervises bounded
seven-minute lease cycles. Durable progress lives in the existing archive broker,
not in the container filesystem. Stop/redeploy/reconnect resumes committed cursors.
Only allowlisted read RPCs are permitted, with the same owner-ID check as the
Actions runner. The service cannot send messages, mark messages read or join chats.

Updates are polled approximately every ten seconds when idle and between history
or dialog pages when due. This is continuous background polling, not an instant
push-delivery guarantee. RPC pacing, long replies, initial discovery, Telegram
FloodWait, server outages and quotas can add delay. A bounded lease is released
before the next cycle; it is not a fifteen-minute scheduled Actions job.

Peer metadata is reused only for the same owner generation. A full dialog refresh
is repeated every six hours; new message peers can be discovered through update
responses earlier. A restart, incomplete discovery or generation change forces
discovery. Old history progresses round-robin without delaying an active chat
until the entire account has been loaded. A 20,000-credit reserve stops old-history
backfill before it consumes the remaining live-update budget. This reserve is not
an unlimited live-message allowance; actual account load may require a larger
approved budget/storage plan.

Every thirty seconds a minimal authenticated heartbeat rechecks the owner gate,
lease and generation before the next live-update read. It returns no chat records
and does not prolong the lease or consume an ingestion receipt. Owner pause is
noticed within this interval plus any already-running RPC; it is not delayed until
the next five-minute empty-state checkpoint.

Empty updates whose only change is the timestamp are held in memory for up to five
minutes. The previous durable timestamp safely replays after a crash. Any change to
pts, seq, deletions or other cursor fields is persisted immediately. Idempotent
body/batch IDs survive transport retries; cursors never advance on a rejected batch.

Quota exhaustion waits until UTC midnight. Telegram FloodWait is honored for its
full duration even when the broker finish fails; an acknowledged broker finish
also preserves that wait across service restarts. A revoked
service key or a detected reconciliation gap stops retrying in-process. Unexpected
errors use bounded backoff. Large gaps (`DifferenceTooLong`) and lost-permission
recovery still require explicit reconciliation: the draft blocks affected context
instead of exposing stale potentially deleted messages or claiming completeness.

## Narrow Service Authentication

The existing GitHub OIDC path is retained. The new optional path is accepted only
by `POST /internal/account-context/{claim,state,batch,finish,heartbeat}` and requires:

- `TELEGRAM_ACCOUNT_SERVICE_ENABLED=true` (absent means disabled).
- `TELEGRAM_ACCOUNT_SERVICE_ID=gcod-account-collector` on both ends.
- `TELEGRAM_ACCOUNT_SERVICE_SECRET`: a random 32-byte key encoded as 64 lowercase
  hexadecimal characters, stored in the Worker secret store and runtime secrets.
- All existing archive configuration and explicit Mini App owner consent.

The service HMAC-SHA256 signs the protocol version, HTTP method, exact path,
configured service ID, UUIDv4 lease-run ID, Unix timestamp and SHA256 of the exact
JSON bytes. Timestamp tolerance is 60 seconds. Signatures use constant-time Web
Crypto verification. Queries, alternate paths and unrelated owner APIs are not
accepted. Replays within that window can only repeat the same operation; the
existing lease generation/CAS and batch receipts prevent altered/repeated writes.
Keep TLS and host clock synchronization enabled. Service identity is namespaced
separately from Actions runs; the two transports cannot own a lease simultaneously.

The key grants archive-ingestion control and metadata checkpoints only, not private
message exports, bot administration, Gmail, Sport or other users' data. Rotate it
to revoke the collector independently. Telegram API hash/session never enter the
Worker, D1, URLs, Git, image layers or logs. A leaked Telegram user session has broad
account access despite the read-only code; revoke it in Telegram Settings/Devices.

## Deployment Bundle

`deploy/account-collector/Dockerfile` copies only the two runtime scripts and pinned
requirements. Its Dockerfile-specific ignore file excludes all other build files.
It runs as UID/GID 10001, without a writable root filesystem or Linux capabilities
in the included Compose configuration. Secrets are external mounted files, not
image contents. `GCOD_CREDENTIALS_DIR` must be an absolute private directory outside
Git/cloud synchronization, containing `api_id`, `api_hash`, `user_session` and
`service_secret`, readable only by the operator and container UID 10001. Do not
commit them or paste values into commands, chat or deployment logs.

On a confirmed existing Linux/Docker server, after the authorization and broker
setup gates are complete:

```sh
docker compose -f deploy/account-collector/compose.yaml config --quiet
docker compose -f deploy/account-collector/compose.yaml build --pull
docker compose -f deploy/account-collector/compose.yaml up -d
curl --fail http://127.0.0.1:8088/healthz
```

The only inbound endpoint is a non-sensitive health check: it returns a fixed state
label and a boolean, never messages, peer IDs, sessions or keys. It is bound to
loopback in Compose. A plain Linux process binds to loopback unless
`COLLECTOR_HEALTH_BIND` is explicitly set; the image uses its container interface.
There is no login endpoint, remote shell or public MCP API.
Health is not proof that the entire history has been collected; check real archive
counters/cursors as well. Docker health marks a fault but does not itself restart
an unhealthy live process; process failures use `restart: unless-stopped`.

SpaceWeb's panel was unreachable during this check; the account's exact service
type and daemon/container permissions are not verified. Do not assume a PHP shared
hosting plan is a VPS. Cloudflare Containers is another possible runtime, but needs
its own controller/deployment and the Workers Paid plan; this generic Compose file
is not a Cloudflare deployment. Billing/API permission changes are separate gates.
The current OAuth token can access Workers/D1 but not account subscription details
(the read-only subscriptions query returned 403). A normal dashboard sign-in later
confirmed Workers Free as the current plan. The owner selected checking existing
SpaceWeb without new expenses, not a paid Cloudflare upgrade. No new scopes were
requested. SpaceWeb DNS resolves and an unauthenticated HTTPS HEAD returns 302 to
the official `mcp.sweb.ru` login. Both panel/login pages timed out in the browser;
no hosting account settings were retrieved or changed. Related service emails
confirmed the existing domain certificates but did not identify a current plan.
One read-only SSH attempt to the existing documented account/host on port 22
also timed out before authentication; no password attempts or host-key bypasses
were used. The website deployment project contained no saved hosting connection.
The provider documents SSH on current hosting plans, normally enabled for 24 hours
from the panel, and Python 3.11 support. Neither enabled SSH nor a sufficient
account-specific process limit has been confirmed, so a VPS purchase is not assumed.

## Release Checklist

Local verification: 314 Node tests and 109 Python tests passed with synthetic
Telegram/HTTP clients; Worker dry-run succeeded. CI and Compose YAML parsed with
PyYAML 6.0.2. Docker is not installed on this computer; a separate unprivileged,
credential-free Linux image-build/smoke job was added to the draft PR CI. Real
account authorization, server capacity and production traffic remain unverified.

Keep the current PR in draft until runtime build, authorization and real-account
QA are complete. Disable the Actions schedule if selecting the service transport,
even though leases fence accidental overlap. Do not rebind the bot webhook.
Use one selected old dialog and synthetic new/edit/delete messages to verify
collection, replay after restart, owner pause, unauthorized access and scoped link
revocation. Do not dump unrelated chat bodies into test logs or automatically
create public account-wide links. Mark history complete only after an empty
history page, not after a successful service start or a partially loaded test.

Rollback: pause in the Mini App, disable the service gate, stop the collector and
revoke its dedicated Telegram device if needed. Retain the private archive unless
the owner explicitly chooses deletion. Other bot features do not depend on this
service.

Sources checked 2026-10-29:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- https://developers.cloudflare.com/containers/
- https://developers.cloudflare.com/containers/platform/pricing/
- https://core.telegram.org/api/obtaining_api_id
- https://help.sweb.ru/ssh-dostup_84.html
- https://help.sweb.ru/zapusk-skripta-python_150.html
- https://help.sweb.ru/ogranicheniya-na-sistemnye-resursy_17.html
