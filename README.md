# GCodRevit-TG-Bot

Репозиторий управляет публикациями в Telegram-канал через GitHub Actions и Telegram Bot API.

Основной workflow для ручных публикаций: `.github/workflows/telegram-post.yml`.

## Что умеет бот

1. Пост с текстом: `sendMessage`.
2. Пост с фото и текстом: `sendPhoto`.
3. Пост с видео и текстом: `sendVideo` с `supports_streaming=true`.

## Секреты GitHub

В настройках репозитория должны быть заданы:

- `TELEGRAM_BOT_TOKEN` — токен Telegram-бота.
- `TELEGRAM_CHAT_ID` — ID канала или чата для публикации.
- `GMAIL_EMAIL` — Gmail-адрес для анализа.
- `GMAIL_APP_PASSWORD` — пароль приложения Gmail.

Секреты не нужно добавлять в код, README, логи или комментарии.

## Кнопка отчёта Gmail

Скрипт `scripts/gmail_button_bot.py` запускает Telegram-бота с одной кнопкой:

```text
📬 Отчёт по Gmail
```

По нажатию кнопки бот запускает workflow `.github/workflows/hourly-gmail-telegram.yml`.
Workflow анализирует Gmail, создаёт картинку по шаблону и публикует в канал один пост: фото + подпись.

Для запуска кнопочного бота нужны переменные окружения:

- `TELEGRAM_BOT_TOKEN` — токен того же Telegram-бота.
- `TELEGRAM_ADMIN_IDS` — Telegram user ID пользователей, которым разрешено нажимать кнопку, через запятую.
- `GITHUB_TOKEN` или `GH_PAT` — GitHub token с правом запускать Actions workflow.
- `GITHUB_REPOSITORY` — по умолчанию `demideilan531-star/GCodRevit-TG-Bot`.
- `GMAIL_WORKFLOW_ID` — по умолчанию `hourly-gmail-telegram.yml`.
- `GITHUB_REF` — по умолчанию `main`.

Если нужно временно открыть кнопку всем пользователям, можно явно задать `TELEGRAM_ALLOW_ALL_USERS=true`. Для отчётов по личной почте это не рекомендуется.

Запуск:

```bash
python3 scripts/gmail_button_bot.py
```

Этот процесс должен работать постоянно на сервере, локальной машине или хостинге. GitHub Actions не подходит для постоянного ожидания нажатий кнопок.

## Как опубликовать

Открой GitHub Actions, выбери workflow `Telegram Post`, нажми `Run workflow`.

Поля:

- `post_type`: `text`, `photo` или `video`.
- `text`: текст поста или подпись к фото/видео.
- `media_url`: прямая ссылка на изображение или MP4.
- `repository_path`: путь к файлу внутри репозитория, если медиа уже лежит в репозитории.
- `parse_mode`: `HTML` или `MarkdownV2`, только если текст специально подготовлен под этот формат.
- `disable_notification`: отправка без уведомления.

Для текстового поста заполняется только `post_type=text` и `text`.

Для фото нужно выбрать `post_type=photo` и передать `media_url` или `repository_path`.
Поддерживаются JPG, PNG и WebP.

Для видео нужно выбрать `post_type=video` и передать `media_url` или `repository_path`.
Поддерживается MP4.

## Длинный текст

Telegram ограничивает длину подписи к фото и видео. Если текст длиннее лимита подписи, workflow отправит медиа с первой частью текста, а оставшийся текст отправит следующими сообщениями.

## Техническая логика

Единая отправка реализована в `scripts/telegram_post.py`.

Скрипт проверяет:

- что заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`;
- что текст не пустой;
- что для фото/видео передан файл или URL;
- что Telegram вернул `ok=true` и `result.message_id`;
- что для фото в ответе есть `result.photo`;
- что для видео в ответе есть `result.video`.

Старые workflow оставлены для совместимости, но новые обычные публикации лучше запускать через `Telegram Post`.
