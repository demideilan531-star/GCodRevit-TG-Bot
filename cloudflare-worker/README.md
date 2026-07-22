# GCodRevit Telegram Worker

Cloudflare Worker handles Telegram buttons immediately and starts GitHub
Actions workflows for Gmail reports and GCodRevit video posts in the
background.

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
5. Verify `GET /health` returns `OK`, then send `/start` to the bot.

The GitHub token only needs Actions read/write access to
`demideilan531-star/GCodRevit-TG-Bot`.
