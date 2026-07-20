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

Секреты не нужно добавлять в код, README, логи или комментарии.

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
