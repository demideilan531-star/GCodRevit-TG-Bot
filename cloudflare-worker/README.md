# GCodRevit Telegram Worker

Cloudflare Worker handles Telegram buttons immediately, serves the task-manager
Mini App, and starts GitHub Actions workflows for Gmail reports, GCod repository
reports, and GCodRevit video posts in the background.

## Required secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `GITHUB_TOKEN`

Do not store secret values in this directory or commit them to GitHub.

## Deploy

1. Create a Cloudflare Worker named `gcodrevit-telegram-bot`.
2. Connect this directory to Cloudflare Workers Builds or deploy it with
   `npm run deploy`.
3. Add the three required encrypted secrets in Worker settings.
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
- the Mini App API accepts only signed Telegram `initData` from users listed in
  `TELEGRAM_ADMIN_IDS`.

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

The GitHub token needs Actions read/write access to
`demideilan531-star/GCodRevit-TG-Bot` and Contents read access to
`demideilan531-star/GCod-`.
