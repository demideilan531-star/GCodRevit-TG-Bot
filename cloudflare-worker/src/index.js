const BUTTON_GMAIL = "📬 Отчёт Gmail";
const BUTTON_GITHUB = "🧩 GitHub";
const BUTTON_VIDEO = "🎬 Видео GCodRevit";
const BUTTON_WEATHER = "🌤 Погода";

function keyboard() {
  return {
    keyboard: [
      [{ text: BUTTON_GMAIL }, { text: BUTTON_GITHUB }],
      [{ text: BUTTON_VIDEO }, { text: BUTTON_WEATHER }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    is_persistent: true,
  };
}

function adminIds(env) {
  return new Set(
    (env.TELEGRAM_ADMIN_IDS || "1839693017")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number),
  );
}

async function telegramApi(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(result.description || `Telegram ${method} failed`);
  }
  return result;
}

function githubSettings(env) {
  return {
    repository: env.GITHUB_REPOSITORY || "demideilan531-star/GCodRevit-TG-Bot",
    ref: env.GITHUB_REF_NAME || "main",
  };
}

async function dispatchWorkflow(env, workflow, inputs) {
  const { repository, ref } = githubSettings(env);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "GCodRevit-Telegram-Worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref, inputs }),
    },
  );
  if (response.status !== 204) {
    const details = (await response.text()).slice(0, 300);
    throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status} ${details}`);
  }
}

function sendMessage(env, chatId, text, withKeyboard = true) {
  const payload = { chat_id: chatId, text };
  if (withKeyboard) {
    payload.reply_markup = keyboard();
  }
  return telegramApi(env, "sendMessage", payload);
}

async function dispatchGmailWorkflow(env, chatId) {
  const workflow = env.GMAIL_WORKFLOW_ID || "hourly-gmail-telegram.yml";
  return dispatchWorkflow(env, workflow, { notify_chat_id: String(chatId) });
}

function videoAttachment(message) {
  if (message.video?.file_id) {
    return message.video;
  }

  if (
    message.document?.file_id &&
    String(message.document.mime_type || "").startsWith("video/")
  ) {
    return message.document;
  }

  return null;
}

async function dispatchVideoWorkflow(env, chatId, message, video) {
  const workflow = env.VIDEO_WORKFLOW_ID || "video-gcodrevit-post.yml";
  return dispatchWorkflow(env, workflow, {
    telegram_file_id: String(video.file_id),
    notify_chat_id: String(chatId),
    source_caption: String(message.caption || "").slice(0, 1000),
    source_file_name: String(video.file_name || "video.mp4").slice(0, 200),
    source_file_size: String(video.file_size || 0),
  });
}

async function handleUpdate(update, env, ctx) {
  const message = update.message;
  if (!message?.chat?.id || !message?.from?.id) {
    return;
  }

  const chatId = message.chat.id;
  const userId = Number(message.from.id);
  const text = String(message.text || "").trim();
  const video = videoAttachment(message);

  if (!adminIds(env).has(userId)) {
    await sendMessage(env, chatId, "У тебя нет доступа к запуску публикаций.", false);
    return;
  }

  if (text === "/start" || text === "/menu") {
    await sendMessage(env, chatId, "Выбери действие на клавиатуре. Подключены отчёт Gmail и обработка видео.");
    return;
  }

  if (video) {
    const maxDownloadSize = 20 * 1024 * 1024;
    if (Number(video.file_size || 0) > maxDownloadSize) {
      await sendMessage(
        env,
        chatId,
        "Видео больше 20 МБ. Telegram не позволит боту скачать его для анализа. Сожми ролик и отправь ещё раз.",
      );
      return;
    }

    await sendMessage(env, chatId, "Видео получено. Началась обработка и подготовка поста.");
    ctx.waitUntil(
      dispatchVideoWorkflow(env, chatId, message, video).catch((error) =>
        sendMessage(env, chatId, `Не удалось запустить обработку видео: ${error.message}`),
      ),
    );
    return;
  }

  if (text === BUTTON_GMAIL) {
    await sendMessage(env, chatId, "Отправлен запрос на отчёт.");
    ctx.waitUntil(
      dispatchGmailWorkflow(env, chatId).catch((error) =>
        sendMessage(env, chatId, `Не удалось запустить отчёт: ${error.message}`),
      ),
    );
    return;
  }

  if (text === BUTTON_GITHUB) {
    await sendMessage(env, chatId, "Кнопка GitHub пока не активна.");
    return;
  }

  if (text === BUTTON_VIDEO) {
    await sendMessage(
      env,
      chatId,
      "Отправь сырое видео размером до 20 МБ. Можно добавить подпись с названием функции или важными деталями.",
    );
    return;
  }

  if (text === BUTTON_WEATHER) {
    await sendMessage(env, chatId, "Кнопка погоды пока не активна.");
    return;
  }

  await sendMessage(env, chatId, "Выбери действие кнопкой под строкой ввода.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const update = await request.json();
      await handleUpdate(update, env, ctx);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error(error);
      return new Response("Webhook error", { status: 500 });
    }
  },
};
