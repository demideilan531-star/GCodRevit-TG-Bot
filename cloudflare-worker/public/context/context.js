const telegram = window.Telegram?.WebApp;
const demoMode = new URLSearchParams(location.search).get('demo') === '1';
const demoShares = [];
function demoMessages() {
  const now = Date.now();
  return [
    { message_id: 1, chat_id: '90001', chat_title: 'Демо · Рабочий диалог', sender_name: 'Демо-собеседник', direction: 'incoming', content_type: 'text', body: 'Согласуем план на завтра?', sent_at: new Date(now - 600000).toISOString() },
    { message_id: 2, chat_id: '90001', chat_title: 'Демо · Рабочий диалог', sender_name: 'Вы', direction: 'outgoing', content_type: 'text', body: 'Подготовлю список задач к встрече.', sent_at: new Date(now - 300000).toISOString() },
  ];
}
function demoRequest(path, options = {}) {
  const url = new URL(`/api/context${path}`, location.origin);
  if (url.pathname.endsWith('/chats')) return Response.json({ connected: true, retention_days: 30, chats: [{ chat_id: '90001', chat_title: 'Демо · Рабочий диалог', message_count: 2 }] });
  if (url.pathname.endsWith('/messages')) return Response.json({ messages: demoMessages() });
  if (url.pathname.endsWith('/export')) return new Response('# Вымышленный контекст\n\nДанные только для предпросмотра.');
  if (url.pathname.endsWith('/shares') && options.method === 'POST') {
    const input = JSON.parse(options.body);
    let share = demoShares.find(row => row.id === input.id);
    if (!share) {
      share = { id: input.id, chat_id: input.chat_id, message_limit: input.limit, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + input.ttl_hours * 3600000).toISOString(), url: `https://example.invalid/context-share/${input.id}.${'A'.repeat(43)}` };
      demoShares.push(share);
    }
    return Response.json({ share });
  }
  if (url.pathname.endsWith('/shares')) return Response.json({ shares: demoShares });
  if (url.pathname.includes('/shares/') && options.method === 'DELETE') {
    const index = demoShares.findIndex(row => row.id === url.pathname.split('/').at(-1));
    if (index >= 0) demoShares.splice(index, 1);
    return Response.json({ ok: true });
  }
  throw new Error('В демо это действие недоступно.');
}
const state = {
  chats: [],
  messages: [],
  selectedChatId: "",
  markdown: "",
  messageRequest: 0,
  loadedChatId: "",
  shareTarget: null,
  shareBusy: false,
  shareRequestId: "",
};

const elements = {
  statusBand: document.querySelector("#statusBand"),
  statusTitle: document.querySelector("#statusTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  chatSelect: document.querySelector("#chatSelect"),
  limitSelect: document.querySelector("#limitSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  deleteButton: document.querySelector("#deleteButton"),
  copyButton: document.querySelector("#copyButton"),
  downloadButton: document.querySelector("#downloadButton"),
  chatHeading: document.querySelector("#chatHeading"),
  messageSummary: document.querySelector("#messageSummary"),
  messageList: document.querySelector("#messageList"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  toast: document.querySelector("#toast"),
  shareButton: document.querySelector("#shareButton"),
  shareDialog: document.querySelector("#shareDialog"),
  closeShare: document.querySelector("#closeShare"),
  shareForm: document.querySelector("#shareForm"),
  shareTtl: document.querySelector("#shareTtl"),
  shareTarget: document.querySelector("#shareTarget"),
  shareWarning: document.querySelector("#shareWarning"),
  shareList: document.querySelector("#shareList"),
  shareError: document.querySelector("#shareError"),
  shareStatus: document.querySelector("#shareStatus"),
  createShareButton: document.querySelector("#createShareButton"),
  shareRetry: document.querySelector("#shareRetry"),
  demoBanner: document.querySelector("#demoBanner"),
};

let toastTimer;
let loadingCount = 0;
function renderIcons() { window.lucide?.createIcons(); }

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setLoading(loading) {
  loadingCount = Math.max(0, loadingCount + (loading ? 1 : -1));
  elements.loadingOverlay.classList.toggle("hidden", !loadingCount);
}

async function api(path, options = {}) {
  if (demoMode) return demoRequest(path, options);
  const response = await fetch(`/api/context${path}`, {
    ...options,
    headers: {
      Authorization: `tma ${telegram?.initData || ""}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Response is not JSON.
    }
    throw new Error(message);
  }
  return response;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function selectedChat() {
  return state.chats.find((chat) => String(chat.chat_id) === state.selectedChatId) || null;
}

function renderChats() {
  elements.chatSelect.replaceChildren();
  if (!state.chats.length) {
    const option = new Option("Нет сохранённых чатов", "");
    elements.chatSelect.add(option);
    elements.chatSelect.disabled = true;
    state.selectedChatId = "";
    return;
  }

  for (const chat of state.chats) {
    const label = `${chat.chat_title} · ${chat.message_count}`;
    elements.chatSelect.add(new Option(label, String(chat.chat_id)));
  }
  elements.chatSelect.disabled = false;
  if (!state.chats.some((chat) => String(chat.chat_id) === state.selectedChatId)) {
    state.selectedChatId = String(state.chats[0].chat_id);
  }
  elements.chatSelect.value = state.selectedChatId;
}

function renderMessages() {
  const chat = selectedChat();
  elements.chatHeading.textContent = chat?.chat_title || "Переписка";
  elements.messageSummary.textContent = state.messages.length
    ? `${state.messages.length} сообщений · до ${formatDate(state.messages.at(-1).sent_at)}`
    : "Сообщений пока нет";
  elements.messageList.replaceChildren();

  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = chat ? "В выбранном диапазоне нет сообщений" : "Подключённые чаты появятся здесь";
    elements.messageList.append(empty);
  } else {
    for (const message of state.messages) {
      const item = document.createElement("article");
      item.className = "message-item";
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const author = document.createElement("span");
      author.className = "message-author";
      author.textContent = message.direction === "outgoing" ? "Вы" : message.sender_name;
      const time = document.createElement("time");
      time.dateTime = message.sent_at;
      time.textContent = `${formatDate(message.sent_at)}${message.edited_at ? " · изм." : ""}`;
      const body = document.createElement("p");
      body.className = "message-body";
      body.textContent = message.body;
      meta.append(author, time);
      item.append(meta, body);
      elements.messageList.append(item);
    }
  }

  const enabled = Boolean(chat && state.messages.length && state.loadedChatId === state.selectedChatId);
  elements.copyButton.disabled = !enabled;
  elements.downloadButton.disabled = !enabled;
  elements.shareButton.disabled = !enabled;
  elements.deleteButton.disabled = !chat;
}

async function loadMessages() {
  const requestId = ++state.messageRequest;
  const chatId = state.selectedChatId;
  state.loadedChatId = "";
  state.messages = [];
  state.markdown = "";
  renderMessages();
  if (!state.selectedChatId) {
    state.messages = [];
    state.markdown = "";
    renderMessages();
    return;
  }
  const query = new URLSearchParams({
    chat_id: chatId,
    limit: elements.limitSelect.value,
  });
  const [messagesResponse, exportResponse] = await Promise.all([
    api(`/messages?${query}`),
    api(`/export?${query}`),
  ]);
  const messages = (await messagesResponse.json()).messages || [];
  const markdown = await exportResponse.text();
  if (requestId !== state.messageRequest || state.selectedChatId !== chatId) return;
  state.messages = messages;
  state.markdown = markdown;
  state.loadedChatId = chatId;
  renderMessages();
}

async function loadAll({ quiet = false } = {}) {
  if (!quiet) setLoading(true);
  try {
    const response = await api("/chats");
    const data = await response.json();
    state.chats = data.chats || [];
    elements.statusBand.classList.toggle("connected", data.connected === true);
    elements.statusTitle.textContent = data.connected ? "Secretary Mode подключён" : "Secretary Mode не подключён";
    elements.statusDetail.textContent = data.connected
      ? `Хранение текста: ${data.retention_days} дней`
      : "Ожидается подключение бота к Telegram-аккаунту";
    renderChats();
    await loadMessages();
  } catch (error) {
    elements.statusTitle.textContent = "Контекст недоступен";
    elements.statusDetail.textContent = error.message;
    showToast(error.message);
  } finally {
    if (!quiet) setLoading(false);
  }
}

async function writeClipboardText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    try {
      if (!document.execCommand("copy")) throw new Error("Не удалось скопировать текст.");
    } finally { input.remove(); }
  }
}

async function copyMarkdown() {
  if (!state.markdown) return;
  await writeClipboardText(state.markdown);
  telegram?.HapticFeedback?.notificationOccurred("success");
  showToast("Контекст скопирован");
}

async function shareApi(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try { return await api(path, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function setShareBusy(busy) {
  state.shareBusy = busy;
  elements.createShareButton.disabled = busy;
  elements.shareTtl.disabled = busy;
  elements.closeShare.disabled = busy;
  elements.shareRetry.disabled = busy;
  for (const button of elements.shareList.querySelectorAll("button")) button.disabled = busy;
}

function checkedShare(share, target) {
  if (!share || typeof share.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(share.id)) throw new Error('Нет подтверждения ссылки от сервера.');
  let url;
  try { url = new URL(share.url); } catch { throw new Error('Нет подтверждения ссылки от сервера.'); }
  const parts = url.pathname.slice('/context-share/'.length).split('.');
  const expectedOrigin = demoMode ? 'https://example.invalid' : location.origin;
  if (url.origin !== expectedOrigin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith('/context-share/') || parts.length !== 2 || parts[0] !== share.id || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
      share.chat_id !== target.chat_id || !Number.isInteger(share.message_limit) || share.message_limit < 1 || share.message_limit > 200 ||
      !Number.isFinite(new Date(share.expires_at).getTime())) throw new Error("Нет подтверждения ссылки от сервера.");
  return share;
}

function renderShareLinks(shares) {
  elements.shareList.replaceChildren();
  if (!shares.length) {
    const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Активных ссылок нет";
    elements.shareList.append(empty); return;
  }
  for (const share of shares) {
    const row = document.createElement("article"); row.className = "share-item";
    const label = document.createElement("p"); label.textContent = `Последние ${share.message_limit} сообщений · до ${formatDate(share.expires_at)}`;
    const controls = document.createElement("div"); controls.className = "share-url-row";
    const input = document.createElement("input"); input.type = "url"; input.readOnly = true; input.value = share.url;
    input.setAttribute("aria-label", "Ссылка на контекст");
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "icon-button";
    copy.title = "Скопировать ссылку"; copy.setAttribute("aria-label", copy.title);
    const copyIcon = document.createElement("i"); copyIcon.dataset.lucide = "copy"; copy.append(copyIcon);
    copy.addEventListener("click", async () => {
      try { await writeClipboardText(share.url); showToast("Ссылка скопирована"); }
      catch { showToast("Не удалось скопировать ссылку"); }
    });
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "icon-button danger";
    revoke.title = "Отключить ссылку"; revoke.setAttribute("aria-label", revoke.title);
    const revokeIcon = document.createElement("i"); revokeIcon.dataset.lucide = "unlink"; revoke.append(revokeIcon);
    revoke.addEventListener("click", () => revokeShareLink(share.id));
    controls.append(input, copy, revoke); row.append(label, controls); elements.shareList.append(row);
  }
  renderIcons();
}

async function reloadShareLinks() {
  const response = await shareApi(`/shares?${new URLSearchParams({ chat_id: state.shareTarget.chat_id })}`);
  const data = await response.json();
  if (!Array.isArray(data.shares)) throw new Error("Не удалось получить ссылки.");
  renderShareLinks(data.shares.map(share => checkedShare(share, state.shareTarget)));
}

async function openShareDialog() {
  const chat = selectedChat();
  if (!chat || !state.messages.length || state.loadedChatId !== state.selectedChatId) return;
  state.shareTarget = { chat_id: state.selectedChatId, limit: Number(elements.limitSelect.value), title: chat.chat_title };
  state.shareRequestId = crypto.randomUUID();
  elements.shareTarget.textContent = state.shareTarget.title;
  elements.shareWarning.textContent = `Любой, у кого есть ссылка, сможет читать последние ${state.shareTarget.limit} сообщений этого чата, включая новые, до конца срока. Отзыв ссылки не удаляет уже скачанные копии.`;
  elements.shareError.hidden = true;
  elements.shareStatus.textContent = "";
  elements.shareTtl.value = "24";
  elements.shareList.replaceChildren();
  elements.shareDialog.showModal(); setShareBusy(true);
  try { await reloadShareLinks(); }
  catch (error) { elements.shareError.textContent = error.message; elements.shareError.hidden = false; }
  finally { setShareBusy(false); }
}

async function createShareLink(event) {
  event.preventDefault();
  if (state.shareBusy || !state.shareTarget) return;
  setShareBusy(true); elements.shareError.hidden = true; elements.shareStatus.textContent = "Создание…";
  let created = false;
  try {
    const response = await shareApi("/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      id: state.shareRequestId, chat_id: state.shareTarget.chat_id, limit: state.shareTarget.limit, ttl_hours: Number(elements.shareTtl.value),
    }) });
    const data = await response.json();
    const share = checkedShare(data.share, state.shareTarget);
    if (share.message_limit !== state.shareTarget.limit) throw new Error("Сервер вернул другой объём доступа.");
    renderShareLinks([share]); elements.shareStatus.textContent = "Ссылка создана";
    created = true;
    await reloadShareLinks();
  } catch (error) {
    elements.shareError.textContent = error.message; elements.shareError.hidden = false;
    if (!created) elements.shareStatus.textContent = "";
  } finally { setShareBusy(false); }
}

async function revokeShareLink(id) {
  if (state.shareBusy) return;
  setShareBusy(true); elements.shareError.hidden = true;
  try {
    await shareApi(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.shareStatus.textContent = "Ссылка отключена"; state.shareRequestId = crypto.randomUUID();
    await reloadShareLinks();
  } catch (error) { elements.shareError.textContent = error.message; elements.shareError.hidden = false; }
  finally { setShareBusy(false); }
}

function downloadMarkdown() {
  if (!state.markdown || !state.selectedChatId) return;
  const blob = new Blob([state.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `telegram-context-${state.selectedChatId}-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  telegram?.HapticFeedback?.notificationOccurred("success");
  showToast("Файл подготовлен");
}

async function deleteChatContext() {
  const chat = selectedChat();
  if (!chat) return;
  const confirmed = window.confirm(`Удалить сохранённый контекст чата «${chat.chat_title}»?`);
  if (!confirmed) return;
  setLoading(true);
  try {
    await api(`/chats/${encodeURIComponent(state.selectedChatId)}`, { method: "DELETE" });
    state.selectedChatId = "";
    await loadAll({ quiet: true });
    telegram?.HapticFeedback?.notificationOccurred("success");
    showToast("Контекст удалён");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

telegram?.ready();
telegram?.expand();
telegram?.setHeaderColor?.("secondary_bg_color");
elements.demoBanner.hidden = !demoMode;

elements.chatSelect.addEventListener("change", async () => {
  state.selectedChatId = elements.chatSelect.value;
  setLoading(true);
  try {
    await loadMessages();
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});
elements.limitSelect.addEventListener("change", async () => {
  setLoading(true);
  try {
    await loadMessages();
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});
elements.refreshButton.addEventListener("click", () => loadAll());
elements.copyButton.addEventListener("click", copyMarkdown);
elements.downloadButton.addEventListener("click", downloadMarkdown);
elements.deleteButton.addEventListener("click", deleteChatContext);
elements.shareButton.addEventListener("click", openShareDialog);
elements.shareForm.addEventListener("submit", createShareLink);
elements.shareTtl.addEventListener("change", () => { state.shareRequestId = crypto.randomUUID(); });
elements.closeShare.addEventListener("click", () => { if (!state.shareBusy) elements.shareDialog.close(); });
elements.shareDialog.addEventListener("cancel", event => { if (state.shareBusy) event.preventDefault(); });
elements.shareRetry.addEventListener("click", async () => {
  if (state.shareBusy) return;
  setShareBusy(true); elements.shareError.hidden = true;
  try { await reloadShareLinks(); }
  catch (error) { elements.shareError.textContent = error.message; elements.shareError.hidden = false; }
  finally { setShareBusy(false); }
});
renderIcons();
window.addEventListener("load", renderIcons, { once: true });

loadAll();
