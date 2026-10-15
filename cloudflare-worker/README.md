# GCodRevit Telegram Worker

Cloudflare Worker handles Telegram buttons immediately, serves the task-manager
Mini App, and starts GitHub Actions workflows for Gmail reports, GCod repository
reports, and GCodRevit video posts in the background.

## Required secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `GMAIL_CREDENTIALS_KEY` - a Base64-encoded random 32-byte AES key used only
  to encrypt users' Google app passwords in D1;
- `GMAIL_BROKER_TOKEN` - a random token shared only by this Worker and the
  personal Gmail GitHub Actions workflow.

Do not store secret values in this directory or commit them to GitHub.

## Deploy

1. Create a Cloudflare Worker named `gcodrevit-telegram-bot`.
2. Connect this directory to Cloudflare Workers Builds or deploy it with
   `npm run deploy`.
3. Add the required encrypted secrets in Worker settings.
4. Set the Telegram webhook to the Worker's public HTTPS URL.
5. Verify `GET /health` and `GET /health/github` return `OK`, then send
   `/start` to the bot. The GitHub health endpoint exposes no repository data.

## Task manager

The task manager is native to the Telegram workflow and does not use Excel as
its primary storage:

- `TASKS_DB` is a Cloudflare D1 binding containing tasks;
- `AI` is the Workers AI binding used to extract a title, independent subtasks,
  description, due date and predefined flags from text, and to transcribe voice
  messages;
- `ASSETS` serves the Telegram Mini App at `/tasks/`;
- the Mini App API accepts only signed Telegram `initData` from the administrator
  or active users stored in `assistant_users`.

Create the database and apply migrations before the first deploy:

```bash
wrangler d1 create gcodrevit-tasks --location=eeur
wrangler d1 migrations apply gcodrevit-tasks --remote
wrangler deploy
```

The D1 identifier returned by the first command belongs in
`wrangler.jsonc`. No extra AI API key is required. Workers AI is authorized by
the Cloudflare account binding.

Send ordinary text or a voice message up to 5 MB directly to the bot. Every
non-command message that is not one of the Gmail, GitHub, video, or weather
buttons is treated as a new task. `/task <description>` remains available as an
explicit alternative.

The bot creates a draft and shows `Сохранить`, `Отменить`, and `Изменить`.
On `/start`, the bot configures a `Задачи` Telegram menu button next to the
message field. It opens list and calendar views inside Telegram. Tasks can also
be created, edited, completed, filtered, and deleted there. A prominent
`Open App` profile button requires enabling the same URL as the bot's Main Mini
App through `@BotFather`.

Predefined flags are `Работа`, `Учёба`, `GCodRevit`, `Личное`, and `Срочно`.
Compound requests are stored as one parent task with independently completable
subtasks. `Срочно` is inferred only from an explicit user request; words such as
`важно` do not enable it automatically. Existing tasks receive an empty subtask
list when migration `0002_add_subtasks.sql` is applied.
All deadlines are stored as ISO 8601 and displayed in `Europe/Moscow`.

## Morning briefing

The briefing is delivered daily at 08:00 `Europe/Moscow` to the configured main
administrator's private chat. `/briefing` requests an extra report independently
of the schedule; the dedicated briefing keyboard button is hidden. Each report
is one personal image for the current day. Weather appears above
unfinished tasks due today, with overdue and undated tasks shown
separately when present. Completed, draft, archived, future, and other users'
tasks are excluded. An empty list explicitly says that there are no tasks for
today; a database error is reported separately and never treated as an empty
list. Long lists are summarized with the remaining count available in the
calendar.

The native Cloudflare cron is `0 5 * * *` (UTC). It uses the same private job
pipeline as manual requests, with a stable opaque ID per owner and Moscow date
to prevent duplicate cron deliveries. Routing/status metadata is retained for
seven days for this deduplication; no task text is stored in the job records.
`MORNING_BRIEFING_ENABLED=false` disables only automatic delivery.
`MORNING_BRIEFING_USER_ID` must be a positive, authorized administrator ID;
ordinary users and channels are never scheduled automatically.

Current Moscow temperature and hourly samples come from the existing public
Yandex Weather page. No pressure or paid weather/model API is included.
Periods use Moscow time and half-open boundaries: morning before 13:00,
afternoon 13:00-17:00, evening 17:00-00:00. Min/max temperatures are calculated
from dated hourly samples, never by relabeling the site's standard dayparts.
Only today's samples count; duplicate desktop/mobile entries are removed.
If past hours are missing, the image identifies the remaining hours or an
elapsed period instead of inventing data. A source failure leaves tasks intact.
The separate weather button is unchanged.

Delivery flow:

1. The Worker creates a 20-minute `briefing_requests` record and one placeholder
   message. The database stores routing/status only, not a duplicate task list.
2. `morning-briefing.yml` receives only the opaque request ID. It authenticates
   to `POST /internal/briefing/claim` using the existing `GMAIL_BROKER_TOKEN`.
3. The Worker rechecks the immutable owner's access and returns owner-filtered
   tasks and the role-specific main keyboard with `Cache-Control: no-store`.
   Each request can be claimed only once.
4. `scripts/morning_briefing.py` uses Pillow and sends one PNG with `sendPhoto`.
   Only after Telegram confirms delivery is the progress placeholder deleted;
   reply-keyboard messages cannot reliably be converted into media in place.
   The short caption does not duplicate task text.
   Progress has no reply keyboard. The final photo owns the persistent main
   keyboard, so deleting progress cannot hide the other assistant controls.
   The image footer reads `С любовью для вас`.
   No private image/data is committed, uploaded as an artifact, or logged.
5. `/internal/briefing/complete` finishes the request. Failures edit the same
   placeholder. One active request per owner prevents repeated-click queues.

Before deploying this version, apply migration `0004_add_briefing_requests.sql`
and publish the workflow to the default branch. The workflow reuses repository
secrets `GMAIL_BROKER_TOKEN`, `TELEGRAM_BOT_TOKEN` and variable `GMAIL_BROKER_URL`;
their values must match the Worker. No new credentials are needed. Without the
broker configuration the existing task-only text response remains available.
The GitHub workflow has no cron of its own; Cloudflare is the only scheduler.

Verification: Node tests `test_morning_briefing.mjs`, `test_briefing_jobs.mjs`,
and Python `test_morning_briefing.py` cover owner isolation, permissions,
one-shot claims, failures, hourly boundaries, and long/empty task layouts.

## Roles and personal assistants

`TELEGRAM_ADMIN_IDS` contains the main administrators. An administrator keeps
the Gmail, GitHub, video, and weather controls. Ordinary users see only personal
Gmail and weather controls; their tasks and Gmail state are isolated by the
immutable Telegram user ID.

The administrator manages access in the bot:

```text
/allow @username
/block @username
/users
```

After `/allow`, the user sends `/start`. The Worker matches the allowlisted
username once and binds it to that user's Telegram ID. Typing a hidden admin
button manually does not bypass the server-side permission check.

## Personal Gmail

An ordinary user taps `📬 Моя почта`, sends an email address, and then sends a
16-character Google app password. The main Google password must never be sent.
The credential message is immediately deleted, the app password is encrypted
with AES-GCM, and only ciphertext is stored in D1.

Personal reports are processed by `.github/workflows/personal-gmail.yml`.
GitHub receives only a random request ID as workflow input. It claims the
encrypted account through the authenticated Worker broker, masks the temporary
credential in Actions logs, sends the report to the requesting private chat,
and returns the new checkpoint. A successful report advances
`last_checked_at`; a failed report does not, so the next press covers the same
period again.

Required GitHub repository configuration:

- secret `GMAIL_BROKER_TOKEN`, equal to the Worker secret of the same name;
- existing secret `TELEGRAM_BOT_TOKEN`;
- variable `GMAIL_BROKER_URL`, set to the public Worker origin, for example
  `https://gcodrevit-telegram-bot.demideilan531.workers.dev`.

Use `/gmail_reset` in the private bot chat to remove a failed or obsolete Gmail
connection. Use `/gmail_cancel` to stop an unfinished setup dialog.

The GitHub token needs Actions read/write access to
`demideilan531-star/GCodRevit-TG-Bot` and Contents read access to
`demideilan531-star/GCod-`.
