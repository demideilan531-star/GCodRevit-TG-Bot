# GCodRevit-TG-Bot

Репозиторий управляет публикациями в Telegram-канал через GitHub Actions и Telegram Bot API.

Основной workflow для ручных публикаций: `.github/workflows/telegram-post.yml`.

## Что умеет бот

1. Пост с текстом: `sendMessage`.
2. Пост с фото и текстом: `sendPhoto`.
3. Пост с видео и текстом: `sendVideo` с `supports_streaming=true`.
4. Автоматический пост из сырого видео через GitHub Models без отдельного API-ключа ИИ.
5. Отчёт об изменениях `GCod-` с автоматически собранной картинкой и живой подписью.
6. Встроенный менеджер задач: создание из текста или голоса и календарь внутри Telegram.

## Менеджер задач

Кнопка `➕ Задача` включает приём следующего текстового или голосового
сообщения. Worker распознаёт формулировку, выделяет название, описание, срок и
флажки, а затем показывает черновик перед сохранением.

Кнопка `📅 Задачи` открывает Telegram Mini App со списком и календарём. В нём
можно создать или изменить задачу, отметить выполнение, отфильтровать записи по
флажкам и удалить ненужное. Основная база — Cloudflare D1, поэтому отдельный
Excel-файл для ежедневной работы не нужен.

Архитектура и команды развёртывания описаны в
`cloudflare-worker/README.md`. Токен внешнего AI API не используется: голос и
структурирование текста выполняются через привязку Cloudflare Workers AI.

## Секреты GitHub

В настройках репозитория должны быть заданы:

- `TELEGRAM_BOT_TOKEN` — токен Telegram-бота.
- `TELEGRAM_CHAT_ID` — ID канала или чата для публикации.
- `GMAIL_EMAIL` — Gmail-адрес для анализа.
- `GMAIL_APP_PASSWORD` — пароль приложения Gmail.

Секреты не нужно добавлять в код, README, логи или комментарии.

Для GitHub Models отдельный секрет не нужен. Workflow получает временный
`GITHUB_TOKEN` автоматически и запрашивает только разрешение `models: read`.

## Кнопка GitHub

Кнопка `🧩 GitHub` анализирует приватный репозиторий
`demideilan531-star/GCod-` без платного API ИИ. Cloudflare Worker читает
коммиты и агрегирует статистику по файлам, после чего запускает
`.github/workflows/github-report.yml`. Workflow создаёт PNG и публикует один
пост с подписью в канал из секрета `TELEGRAM_CHAT_ID`.

Цепочка:

1. Бот сразу подтверждает нажатие в личном чате.
2. Worker читает последние коммиты `GCod-` через GitHub REST API.
3. В workflow передаются только данные будущего публичного поста: счётчики,
   направления работ и короткие выводы. Исходный код не передаётся.
4. Python и Pillow собирают картинку и подпись без внешнего AI API.
5. Telegram получает один `sendPhoto`, а пользователь — сообщение о завершении.

Fine-grained token в Cloudflare Secret `GITHUB_TOKEN` должен иметь доступ к
двум репозиториям:

- `GCodRevit-TG-Bot`: `Actions: Read and write`, `Metadata: Read`;
- `GCod-`: `Contents: Read`, `Metadata: Read`.

Повторное нажатие блокируется на 60 секунд. Настройки находятся в
`cloudflare-worker/wrangler.jsonc`: `GCOD_REPOSITORY`, `GCOD_REF_NAME`,
`GITHUB_LOOKBACK_DAYS` и `GITHUB_WORKFLOW_ID`.

## Автоматический пост из видео

Кнопка `🎬 Видео GCodRevit` работает через Cloudflare Worker и workflow
`.github/workflows/video-gcodrevit-post.yml`.

Порядок работы:

1. Нажми `🎬 Видео GCodRevit`.
2. Отправь боту видео размером до 20 МБ. В подписи можно указать название функции и важные детали.
3. Бот сразу подтвердит получение файла.
4. GitHub Actions скачает видео, извлечёт четыре ключевых кадра и звуковую дорожку.
5. Локальная модель Whisper расшифрует речь без внешнего API-ключа.
6. `openai/gpt-4.1-mini` через GitHub Models подготовит текст по инструкции.
7. Бот опубликует исходное видео с готовой подписью в канал и сообщит о результате в личном чате.

Инструкция, стиль и шаблон находятся в `prompts/video-gcodrevit.md`. Этот файл
можно менять без изменения Python-скрипта или workflow.

Ограничение 20 МБ связано с методом `getFile` стандартного Telegram Bot API.
Видео публикуется повторным использованием Telegram `file_id`, поэтому GitHub
не загружает исходный файл обратно в Telegram.

## Кнопка отчёта Gmail

Для SpaceWeb используется PHP webhook `hosting/spaceweb/telegram-webhook.php`.
Он запускает Telegram-бота с одной кнопкой:

```text
📬 Отчёт по Gmail
```

По нажатию кнопки бот запускает workflow `.github/workflows/hourly-gmail-telegram.yml`.
Workflow анализирует Gmail, создаёт картинку по шаблону и публикует в канал один пост: фото + подпись.

### Настройка на SpaceWeb

1. Загрузи в `public_html` файл `hosting/spaceweb/telegram-webhook.php`.
2. Загрузи рядом файл `hosting/spaceweb/telegram-webhook-config.sample.php`.
3. Переименуй его на хостинге в `telegram-webhook-config.php`.
4. Заполни в `telegram-webhook-config.php` реальные значения:

- `telegram_bot_token` — токен Telegram-бота.
- `telegram_admin_ids` — `1839693017`.
- `telegram_webhook_secret` — длинная случайная строка для защиты webhook.
- `github_token` — GitHub token с правом запускать Actions workflow. Для fine-grained token дай доступ к этому репозиторию и permission `Actions: Read and write`.
- `github_repository` — `demideilan531-star/GCodRevit-TG-Bot`.
- `github_workflow_id` — `hourly-gmail-telegram.yml`.
- `github_ref` — `main`.

5. Проверь, что файл открывается:

```text
https://demideilan.temp.swtest.ru/telegram-webhook.php?health=1
```

Ответ должен быть:

```text
OK
```

6. Привяжи webhook в Telegram:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://demideilan.temp.swtest.ru/telegram-webhook.php" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

После этого открой бота в Telegram и отправь `/start`. Бот покажет кнопку `📬 Отчёт по Gmail`.

### Альтернатива: Python polling

Скрипт `scripts/gmail_button_bot.py` можно использовать на сервере, где разрешены постоянные Python-процессы.
Для запуска нужны переменные окружения:

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
