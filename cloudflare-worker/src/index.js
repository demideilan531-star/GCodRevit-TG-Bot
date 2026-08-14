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

function encodedRepository(repository) {
  return repository.split("/").map(encodeURIComponent).join("/");
}

async function githubApi(env, path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "GCodRevit-Telegram-Worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "GitHub не дал доступ к GCod-. Добавь этот репозиторий в доступ fine-grained token.",
      );
    }
    throw new Error(`GitHub API вернул HTTP ${response.status}`);
  }
  return response.json();
}

function githubArea(path) {
  const value = String(path || "").replaceAll("\\", "/");
  if (value.startsWith("AI/")) return "Локальный AI";
  if (value.startsWith("GCod Chat Server/")) return "Чат-сервер";
  if (value.startsWith("GCod exe/")) return "Desktop и обновления";
  if (value.startsWith("GCodSharedHosting/")) return "Сайт и хостинг";
  if (value.startsWith("GCod/")) return "Revit-плагин";
  if (value.startsWith("docs/")) return "Документация";
  return "Инфраструктура";
}

function commitTitle(commit) {
  const message = String(commit?.commit?.message || "Обновление проекта")
    .split("\n")[0]
    .trim();
  if (message.toLowerCase() === "initial project import") {
    return "Проект собран в единую структуру: Revit, сервер, desktop и AI.";
  }
  return message.slice(0, 90);
}

async function collectCommitDetails(env, repository, sha, areas) {
  const encoded = encodedRepository(repository);
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  let truncated = false;

  for (let page = 1; page <= 8; page += 1) {
    const detail = await githubApi(
      env,
      `/repos/${encoded}/commits/${encodeURIComponent(sha)}?per_page=100&page=${page}`,
    );
    if (page === 1) {
      additions = Number(detail.stats?.additions || 0);
      deletions = Number(detail.stats?.deletions || 0);
    }
    const files = Array.isArray(detail.files) ? detail.files : [];
    for (const file of files) {
      const area = githubArea(file.filename);
      areas.set(area, (areas.get(area) || 0) + 1);
    }
    filesChanged += files.length;
    if (files.length < 100) {
      return { additions, deletions, filesChanged, truncated };
    }
    if (page === 8) {
      truncated = true;
    }
  }

  return { additions, deletions, filesChanged, truncated };
}

async function collectGithubReport(env) {
  const repository = env.GCOD_REPOSITORY || "demideilan531-star/GCod-";
  const branch = env.GCOD_REF_NAME || "main";
  const encoded = encodedRepository(repository);
  const lookbackDays = Math.max(1, Number(env.GITHUB_LOOKBACK_DAYS || 30));
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const [repo, commits] = await Promise.all([
    githubApi(env, `/repos/${encoded}`),
    githubApi(env, `/repos/${encoded}/commits?sha=${encodeURIComponent(branch)}&per_page=10`),
  ]);
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error("В GCod- не найдено ни одного коммита.");
  }

  const recent = commits.filter((commit) => {
    const date = Date.parse(commit?.commit?.committer?.date || commit?.commit?.author?.date || "");
    return Number.isFinite(date) && date >= cutoff;
  });
  const selected = (recent.length ? recent : commits.slice(0, 1)).slice(0, 3);
  const areas = new Map();
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  let truncated = false;

  for (const commit of selected) {
    const details = await collectCommitDetails(env, repository, commit.sha, areas);
    additions += details.additions;
    deletions += details.deletions;
    filesChanged += details.filesChanged;
    truncated ||= details.truncated;
  }

  let highlights = selected.map(commitTitle).filter(Boolean).slice(0, 4);
  if (selected.some((commit) => String(commit?.commit?.message || "").toLowerCase().includes("initial project import"))) {
    highlights = [
      "Проект собран в единую структуру: Revit, сервер, desktop и AI.",
      "Локальные AI-модули отделены от исполняемой Revit-логики.",
      "Хостинг и обновление включены в общий контур поставки.",
    ];
  } else if (!recent.length) {
    highlights.unshift("После последнего коммита новых изменений не найдено.");
  }

  const areaList = [...areas.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
  const dates = selected
    .map((commit) => commit?.commit?.committer?.date || commit?.commit?.author?.date)
    .filter(Boolean)
    .sort();

  return {
    mode: recent.length ? "changes" : "snapshot",
    variant: "default",
    repository,
    branch: repo.default_branch || branch,
    generated_at: new Date().toISOString(),
    period_start: dates[0] || "",
    period_end: dates[dates.length - 1] || "",
    head_sha: commits[0].sha,
    commits_count: recent.length || 1,
    files_changed: truncated ? `${filesChanged}+` : filesChanged,
    additions,
    deletions,
    areas: areaList,
    highlights,
    truncated,
  };
}

async function dispatchGithubWorkflow(env, chatId) {
  const report = await collectGithubReport(env);
  const workflow = env.GITHUB_WORKFLOW_ID || "github-report.yml";
  return dispatchWorkflow(env, workflow, {
    notify_chat_id: String(chatId),
    report_json: JSON.stringify(report),
  });
}

async function claimGithubCooldown(userId) {
  const cache = caches.default;
  const key = new Request(`https://gcodrevit.internal/github-report/${userId}`);
  if (await cache.match(key)) {
    return null;
  }
  await cache.put(
    key,
    new Response("active", { headers: { "Cache-Control": "public, max-age=60" } }),
  );
  return { cache, key };
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

async function dispatchWeatherWorkflow(env, chatId) {
  const workflow = env.WEATHER_WORKFLOW_ID || "weather-report.yml";
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
    await sendMessage(env, chatId, "Выбери действие на клавиатуре. Подключены Gmail, погода и обработка видео.");
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
    const cooldown = await claimGithubCooldown(userId);
    if (!cooldown) {
      await sendMessage(env, chatId, "Отчёт по GitHub уже готовится. Второй раз кнопку мучить не надо.");
      return;
    }
    await sendMessage(
      env,
      chatId,
      "Принял. Проверяю GitHub и собираю пост в канал. Руками такие вещи не делают.",
    );
    ctx.waitUntil(
      dispatchGithubWorkflow(env, chatId).catch(async (error) => {
        await cooldown.cache.delete(cooldown.key);
        await sendMessage(env, chatId, `Не удалось запустить отчёт по GitHub: ${error.message}`);
      }),
    );
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
    await sendMessage(env, chatId, "Отправлен запрос на прогноз погоды.");
    ctx.waitUntil(
      dispatchWeatherWorkflow(env, chatId).catch((error) =>
        sendMessage(env, chatId, `Не удалось запустить прогноз погоды: ${error.message}`),
      ),
    );
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

    if (request.method === "GET" && url.pathname === "/health/github") {
      try {
        const repository = env.GCOD_REPOSITORY || "demideilan531-star/GCod-";
        await githubApi(env, `/repos/${encodedRepository(repository)}`);
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("GitHub health check failed", error);
        return new Response("GitHub unavailable", { status: 503 });
      }
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

