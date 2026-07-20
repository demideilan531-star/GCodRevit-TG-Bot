<?php
// Copy this file to telegram-webhook-config.php on SpaceWeb and fill real values.
// Do not commit real tokens or passwords to GitHub.

return [
    'telegram_bot_token' => 'PASTE_TELEGRAM_BOT_TOKEN_HERE',
    'telegram_admin_ids' => '1839693017',
    'telegram_webhook_secret' => 'CHANGE_ME_TO_LONG_RANDOM_STRING',

    'github_token' => 'PASTE_GITHUB_PAT_HERE',
    'github_repository' => 'demideilan531-star/GCodRevit-TG-Bot',
    'github_workflow_id' => 'hourly-gmail-telegram.yml',
    'github_ref' => 'main',

    'cooldown_seconds' => 300,
];
