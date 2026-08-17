const BUTTON_GMAIL = "📬 Отчёт Gmail";
const BUTTON_GITHUB = "🧩 GitHub";
const BUTTON_VIDEO = "🎬 Видео GCodRevit";
const BUTTON_WEATHER = "🌤 Погода";

const GITHUB_FEATURES = [
  {
    id: "ai-chat",
    priority: 100,
    paths: [/^GCod\/GCod\/AiChat\//i],
    title: "Чат ИИ прямо в Revit",
    what: "Вкладка GCod получила чат с локальной моделью через GCod Desktop.",
    how: "Открой Revit → GCod → ИИ → «Чат ИИ» и задай вопрос по текущей работе.",
    why: "Можно получить подсказку по GCod и Revit, не переключаясь между приложениями.",
  },
  {
    id: "bim-tasks",
    priority: 90,
    paths: [/^GCod\/GCod\/BimTasks\//i, /^GCod Chat Server\//i],
    title: "BIM-задачи и переписка",
    what: "В GCod доступны создание задачи, чат по ней и доска текущих работ.",
    how: "В Revit открой GCod → BIM отдел и выбери «Задание», «Чат» или «Текущие».",
    why: "Задачи, статусы и уточнения остаются в одном месте и не теряются в личных сообщениях.",
  },
  {
    id: "family-tools",
    priority: 80,
    paths: [
      /^GCod\/GCod\/FamilyAssembly\//i,
      /^GCod\/GCod\/Functions\/Settings\//i,
      /LookupTableFamily/i,
    ],
    title: "Подготовка семейств без рутины",
    what: "Добавлены команды для HT/ЦК-параметров, таблиц выбора, сборки и чистки семейства.",
    how: "Открой RFA, затем в GCod выбери нужную команду параметров, таблицы выбора или сборки.",
    why: "Типовые семейства готовятся одинаково, быстрее и с меньшим риском пропустить параметр.",
  },
  {
    id: "coordination",
    priority: 70,
    paths: [
      /^GCod\/GCod\/GCOD_Coordination\//i,
      /^GCod\/GCod\/NwcExport\//i,
      /^GCod\/GCod\/ProjectCleanup\//i,
    ],
    title: "Координация и выдача модели",
    what: "Появились проверка координации, перенос ADSK → SP, выгрузка и чистка проекта.",
    how: "Открой RVT и используй панели «Координация» и «Выгрузка» на вкладке GCod.",
    why: "Перед выдачей модель можно проверить, привести параметры в порядок и выгрузить по одному сценарию.",
  },
  {
    id: "desktop",
    priority: 60,
    paths: [/^GCod exe\//i],
    title: "GCod Desktop и обновления",
    what: "Desktop объединяет лицензию, обновления, локальные сервисы и запуск AI-пакетов.",
    how: "Запусти GCod Desktop перед Revit и проверь статус подключения и доступную версию.",
    why: "Плагин обновляется и подключается к локальным сервисам без ручной замены файлов.",
  },
];

const RELEASE_FEATURES = [
  {
    id: "navisworks-offline-license",
    priority: 100,
    pattern: /офлайн[- ]лиценз.*navisworks|navisworks.*офлайн[- ]лиценз/i,
    status: "new",
    title: "Офлайн-лицензия Navisworks",
    how: "Установи пакет GCod Navisworks 2023 и активируй его на рабочем компьютере.",
    why: "Плагин сможет подтверждать лицензию без постоянного подключения к серверу.",
  },
  {
    id: "protected-builds",
    priority: 90,
    pattern: /обфускац|защит.*(?:dll|сбор)|целостност.*пакет|sha-?256/i,
    status: "updated",
    title: "Защищённые и проверяемые сборки",
    how: "Устанавливай компоненты из приложенных пакетов: проверка целостности выполняется при выпуске.",
    why: "Повреждённые или подменённые файлы обнаруживаются до того, как попадут в рабочую среду.",
  },
  {
    id: "nwc-errors",
    priority: 85,
    pattern: /ошибк.*(?:nwc|экспорт)|экспорт[её]р.*nwc/i,
    status: "fixed",
    title: "Понятные ошибки экспорта NWC",
    how: "Запусти экспорт NWC как обычно: результат теперь вернёт структурированную причину сбоя.",
    why: "Неудачную выгрузку можно диагностировать без поиска причины по разрозненным логам.",
  },
  {
    id: "rnc-pipeline",
    priority: 80,
    pattern: /конвейер.*rnc|очистк.*rvt.*экспорт.*nwc|повторн.*открыт.*nwc/i,
    status: "fixed",
    title: "Надёжный конвейер RVT → NWC",
    how: "Запусти RNC-сценарий: GCod сам очистит, сохранит, переоткроет модель и выполнит экспорт.",
    why: "NWC создаётся из уже сохранённого состояния модели, поэтому результат предсказуемее.",
  },
  {
    id: "component-update",
    priority: 60,
    pattern: /обновлен.*(?:desktop|revit|navisworks|chat server)|состав релиза/i,
    status: "updated",
    title: "Компоненты GCod одной версии",
    how: "Обнови Desktop, нужный плагин Revit или Navisworks и Chat Server из одного релиза.",
    why: "Компоненты одной версии проверены вместе и меньше рискуют разойтись по совместимости.",
  },
];

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

function commitTitle(commit) {
  const message = String(commit?.commit?.message || "Обновление проекта")
    .split("\n")[0]
    .trim();
  if (message.toLowerCase() === "initial project import") {
    return "Проект собран в единую структуру: Revit, сервер, desktop и AI.";
  }
  return message.slice(0, 90);
}

function featureStatus(fileStatus, commitMessage, snapshot) {
  if (snapshot) return "available";
  if (fileStatus === "removed") return "removed";
  if (/\b(fix|fixed|repair|исправ|почин)/i.test(commitMessage)) return "fixed";
  if (fileStatus === "added") return "new";
  return "updated";
}

function recordGithubFeatures(file, commitMessage, snapshot, features) {
  const path = String(file?.filename || "").replaceAll("\\", "/");
  for (const definition of GITHUB_FEATURES) {
    if (!definition.paths.some((pattern) => pattern.test(path))) continue;
    const status = featureStatus(file.status, commitMessage, snapshot);
    const current = features.get(definition.id);
    const rank = { removed: 4, new: 3, fixed: 2, updated: 1, available: 0 };
    if (!current || rank[status] > rank[current.status]) {
      features.set(definition.id, { ...definition, status });
    }
  }
}

async function collectCommitDetails(env, repository, commit, snapshot, features) {
  const encoded = encodedRepository(repository);
  const sha = commit.sha;
  const commitMessage = String(commit?.commit?.message || "");
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
      recordGithubFeatures(file, commitMessage, snapshot, features);
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

function versionParts(value) {
  const match = String(value || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? match.slice(1).filter((part) => part !== undefined).map(Number) : [];
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function releaseTimestamp(release) {
  const timestamps = [release?.published_at, release?.created_at, release?.updated_at];
  for (const asset of release?.assets || []) timestamps.push(asset?.updated_at);
  const parsed = timestamps.map(Date.parse).filter(Number.isFinite);
  return parsed.length ? Math.max(...parsed) : 0;
}

function cleanReleaseLine(value, maxLength = 190) {
  const text = String(value || "")
    .replace(/[`*_]/g, "")
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function releaseBullets(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map((line) => cleanReleaseLine(line));
}

function groupGithubReleases(releases) {
  const groups = new Map();
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = cleanReleaseLine(release?.tag_name || release?.name, 40);
    if (!versionParts(version).length) continue;
    const key = version.toLowerCase().replace(/^v/, "");
    if (!groups.has(key)) {
      groups.set(key, {
        version,
        releases: [],
        bullets: new Set(),
        assets: new Map(),
        timestamp: 0,
      });
    }
    const group = groups.get(key);
    group.releases.push(release);
    group.timestamp = Math.max(group.timestamp, releaseTimestamp(release));
    for (const bullet of releaseBullets(release?.body)) group.bullets.add(bullet);
    for (const asset of release?.assets || []) {
      if (asset?.name) group.assets.set(asset.name, asset);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      bullets: [...group.bullets],
      assets: [...group.assets.values()],
      representative: [...group.releases].sort(
        (left, right) => releaseTimestamp(right) - releaseTimestamp(left),
      )[0],
    }))
    .sort(
      (left, right) =>
        compareVersions(right.version, left.version) || right.timestamp - left.timestamp,
    );
}

function genericReleaseStatus(text) {
  if (/исправ|почин|устран/i.test(text)) return "fixed";
  if (/добав|появ|нов/i.test(text)) return "new";
  return "updated";
}

function genericReleaseTitle(text) {
  return cleanReleaseLine(text, 62)
    .replace(/[.:;]+$/, "")
    .replace(/^(добавлен[аоы]?|обновлен[аоы]?|исправлен[аоы]?)\s+/i, "");
}

function buildReleaseChanges(group) {
  const usedBullets = new Set();
  const changes = [];

  for (const definition of [...RELEASE_FEATURES].sort(
    (left, right) => right.priority - left.priority,
  )) {
    const matching = group.bullets.filter((bullet) => definition.pattern.test(bullet));
    if (!matching.length) continue;
    matching.forEach((bullet) => usedBullets.add(bullet));
    const { priority, pattern, ...feature } = definition;
    changes.push({
      ...feature,
      what: cleanReleaseLine(matching.join(" ")),
    });
    if (changes.length === 3) return changes;
  }

  for (const bullet of group.bullets) {
    if (usedBullets.has(bullet)) continue;
    changes.push({
      id: `release-${changes.length + 1}`,
      status: genericReleaseStatus(bullet),
      title: genericReleaseTitle(bullet),
      what: cleanReleaseLine(bullet),
      how: `Обнови GCod до версии ${group.version} и используй функцию как обычно.`,
      why: "Изменение вошло в готовый пакет релиза и доступно после обновления.",
    });
    if (changes.length === 3) break;
  }

  return changes;
}

function buildGithubReleaseReport(releases, repository, branch, cutoff) {
  const groups = groupGithubReleases(releases);
  const latest = groups[0];
  if (!latest) return null;

  const isDraft = latest.releases.every((release) => release?.draft === true);
  if (!isDraft && latest.timestamp < cutoff) return null;

  const previous = groups.find(
    (group) =>
      compareVersions(group.version, latest.version) < 0 &&
      group.releases.some((release) => release?.draft !== true),
  );
  const changes = buildReleaseChanges(latest);
  if (!changes.length) return null;

  return {
    mode: "changes",
    variant: "release",
    repository,
    branch,
    generated_at: new Date().toISOString(),
    period_start: previous?.representative?.published_at || "",
    period_end: latest.timestamp ? new Date(latest.timestamp).toISOString() : "",
    head_sha: latest.version,
    commits_count: 0,
    release_version: latest.version,
    release_url: latest.representative?.html_url || "",
    report_title: `GCod ${latest.version.replace(/^v/i, "")}: что изменилось`,
    summary: isDraft
      ? `Версия ${latest.version.replace(/^v/i, "")} уже собрана и загружена в GitHub как черновик релиза.`
      : `Версия ${latest.version.replace(/^v/i, "")} опубликована в GitHub и готова к установке.`,
    baseline_note: previous
      ? `Сравнение: ${previous.version.replace(/^v/i, "")} → ${latest.version.replace(/^v/i, "")}.`
      : "Показываем содержимое последнего релиза без сравнения с предыдущей версией.",
    changes,
    technical: {
      assets: latest.assets.length,
      draft: isDraft,
      duplicate_releases: latest.releases.length,
    },
    truncated: false,
  };
}

async function collectGithubReport(env) {
  const repository = env.GCOD_REPOSITORY || "demideilan531-star/GCod-";
  const branch = env.GCOD_REF_NAME || "main";
  const encoded = encodedRepository(repository);
  const lookbackDays = Math.max(1, Number(env.GITHUB_LOOKBACK_DAYS || 30));
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const [repo, commits, releases] = await Promise.all([
    githubApi(env, `/repos/${encoded}`),
    githubApi(env, `/repos/${encoded}/commits?sha=${encodeURIComponent(branch)}&per_page=10`),
    githubApi(env, `/repos/${encoded}/releases?per_page=30`),
  ]);
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error("В GCod- не найдено ни одного коммита.");
  }

  const releaseReport = buildGithubReleaseReport(
    releases,
    repository,
    repo.default_branch || branch,
    cutoff,
  );
  if (releaseReport) return releaseReport;

  const recent = commits.filter((commit) => {
    const date = Date.parse(commit?.commit?.committer?.date || commit?.commit?.author?.date || "");
    return Number.isFinite(date) && date >= cutoff;
  });
  const selected = (recent.length ? recent : commits.slice(0, 1)).slice(0, 3);
  const snapshot = !Array.isArray(commits[0]?.parents) || commits[0].parents.length === 0;
  const features = new Map();
  let filesChanged = 0;
  let truncated = false;

  for (const commit of selected) {
    const details = await collectCommitDetails(env, repository, commit, snapshot, features);
    filesChanged += details.filesChanged;
    truncated ||= details.truncated;
  }

  let changes = [...features.values()]
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 3)
    .map(({ priority, paths, ...feature }) => feature);
  if (!changes.length) {
    changes = [
      {
        id: "technical-update",
        status: /\b(fix|fixed|repair|исправ|почин)/i.test(
          String(selected[0]?.commit?.message || ""),
        )
          ? "fixed"
          : "updated",
        title: "Техническое обновление",
        what: commitTitle(selected[0]),
        how: "Ничего переучивать не нужно: обнови GCod и работай как обычно.",
        why: "Изменение поддерживает стабильность проекта, но не добавляет новую кнопку.",
      },
    ];
  }

  const dates = selected
    .map((commit) => commit?.commit?.committer?.date || commit?.commit?.author?.date)
    .filter(Boolean)
    .sort();

  return {
    mode: snapshot || !recent.length ? "snapshot" : "changes",
    variant: "default",
    repository,
    branch: repo.default_branch || branch,
    generated_at: new Date().toISOString(),
    period_start: dates[0] || "",
    period_end: dates[dates.length - 1] || "",
    head_sha: commits[0].sha,
    commits_count: recent.length || 1,
    report_title: snapshot
      ? "GCodRevit: что уже доступно"
      : "GCodRevit: что изменилось",
    summary: snapshot
      ? "Это первый снимок проекта: показываем не объём кода, а полезные возможности для работы."
      : `Нашли ${changes.length} заметных для пользователя изменений в GCodRevit.`,
    baseline_note: snapshot
      ? "Предыдущей версии в GitHub пока нет, поэтому честного сравнения «было → стало» ещё не получится."
      : "",
    changes,
    technical: {
      commits: recent.length || 1,
      files: truncated ? `${filesChanged}+` : filesChanged,
    },
    truncated,
  };
}

export { buildGithubReleaseReport, compareVersions, groupGithubReleases, versionParts };

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

