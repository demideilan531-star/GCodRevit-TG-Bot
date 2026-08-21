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

- `TASKS_DB` is a Cloudflare D1 binding containing tasks and short-lived input
  sessions;
- `AI` is the Workers AI binding used to extract a title, description, due date
  and predefined flags from text, and to transcribe voice messages;
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

Use the bot in one of three ways:

1. Press `➕ Задача`, then send ordinary text.
2. Press `➕ Задача`, then send a voice message up to 5 MB.
3. Send `/task <description>` without opening capture mode.

Send `/cancel` to leave capture mode without creating a task. Pressing any of
the existing Gmail, GitHub, video, or weather buttons also leaves capture mode
and performs the original action.

The bot creates a draft and shows `Сохранить`, `Отменить`, and `Изменить`.
The `📅 Задачи` keyboard button opens list and calendar views inside Telegram.
Tasks can also be created, edited, completed, filtered, and deleted there.

Predefined flags are `Работа`, `Учёба`, `GCodRevit`, `Личное`, and `Срочно`.
All deadlines are stored as ISO 8601 and displayed in `Europe/Moscow`.

The GitHub token needs Actions read/write access to
`demideilan531-star/GCodRevit-TG-Bot` and Contents read access to
`demideilan531-star/GCod-`.
