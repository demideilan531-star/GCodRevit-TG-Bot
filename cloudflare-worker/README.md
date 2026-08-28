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
