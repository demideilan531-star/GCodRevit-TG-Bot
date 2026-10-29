import { buildContextMarkdown } from './markdown.js';

const telegram = window.Telegram?.WebApp;
const demoMode = new URLSearchParams(location.search).get('demo') === '1';
const demoArchive = demoMode && new URLSearchParams(location.search).get('archive') === '1';
const demoAnchor = Date.now();
const demoShares = [];
let demoAccountEnabled = true;
function demoMessages(chatId = '90001', archive = false) {
  if (archive && chatId === '90003') return Array.from({ length: 245 }, (_, index) => ({ message_id: index + 1, chat_id: chatId, chat_title: 'Демо · Учебная группа', sender_name: 'Демо-участник', direction: 'incoming', content_type: 'text', body: `Вымышленная запись ${index + 1}`, sent_at: new Date(Date.UTC(2020, 0, 1) + index * 60000).toISOString() }));
  const now = archive && chatId === '90002' ? Date.UTC(2018, 5, 12, 12) : demoAnchor;
  return [
    { message_id: 1, chat_id: chatId, chat_title: chatId === '90002' ? 'Демо · Старый диалог' : 'Демо · Рабочий диалог', sender_name: 'Демо-собеседник', direction: 'incoming', content_type: 'text', body: 'Согласуем план на завтра?', sent_at: new Date(now - 600000).toISOString() },
    { message_id: 2, chat_id: chatId, chat_title: chatId === '90002' ? 'Демо · Старый диалог' : 'Демо · Рабочий диалог', sender_name: 'Вы', direction: 'outgoing', content_type: 'text', body: 'Подготовлю список задач к встрече.', sent_at: new Date(now - 300000).toISOString() },
  ];
}
function demoRequest(path, options = {}) {
  const url = new URL(`/api/context${path}`, location.origin);
  const archive = url.pathname.includes('/account/');
  if (url.pathname.endsWith('/account/status') || url.pathname.endsWith('/account/pause') || url.pathname.endsWith('/account/enable')) {
    if (url.pathname.endsWith('/pause')) demoAccountEnabled = false;
    if (url.pathname.endsWith('/enable')) demoAccountEnabled = true;
    return Response.json({ available: demoArchive, can_setup: true, account_id: '99999', enabled: demoAccountEnabled, status: demoAccountEnabled ? 'idle' : 'paused', chats: 3, messages: 249, complete_chats: 3, dialogs_complete: true, last_sync_at: new Date(demoAnchor).toISOString() });
  }
  if (url.pathname.endsWith('/chats')) {
    const chats = [{ chat_id: '90001', chat_title: 'Демо · Рабочий диалог', message_count: 2 }, ...(archive ? [{ chat_id: '90002', chat_title: 'Демо · Старый диалог', message_count: 2, archived: 1 }, { chat_id: '90003', chat_title: 'Демо · Учебная группа', message_count: 245 }] : [])];
    const search = (url.searchParams.get('q') || '').toLowerCase();
    return Response.json({ connected: true, retention_days: 30, next_chat_id: null, chats: chats.filter(chat => chat.chat_title.toLowerCase().includes(search)) });
  }
  if (url.pathname.endsWith('/messages')) {
    let rows = demoMessages(url.searchParams.get('chat_id') || '90001', archive);
    const before = url.searchParams.get('before');
    if (before) { const cursor = JSON.parse(atob(before)); rows = rows.filter(row => row.message_id < cursor.message_id); }
    const page = rows.slice(-200), next = rows.length > 200 ? btoa(JSON.stringify({ message_id: page[0].message_id, sent_at: page[0].sent_at })) : null;
    return Response.json({ messages: page, next_cursor: next });
  }
  if (url.pathname.endsWith('/shares') && options.method === 'POST') {
    const input = JSON.parse(options.body);
    let share = demoShares.find(row => row.id === input.id);
    if (!share) {
      share = { id: input.id, chat_id: input.chat_id, source: archive ? 'account' : 'secretary', message_limit: input.limit, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + input.ttl_hours * 3600000).toISOString(), url: `https://example.invalid/${archive ? 'account-context-share' : 'context-share'}/${input.id}.${'A'.repeat(43)}` };
      demoShares.push(share);
    }
    return Response.json({ share });
  }
  if (url.pathname.endsWith('/shares')) return Response.json({ shares: demoShares.filter(share => share.chat_id === url.searchParams.get('chat_id') && share.source === (archive ? 'account' : 'secretary')) });
  if (url.pathname.includes('/shares/') && options.method === 'DELETE') {
    const index = demoShares.findIndex(row => row.id === url.pathname.split('/').at(-1));
    if (index >= 0) demoShares.splice(index, 1);
    return Response.json({ ok: true });
  }
  throw new Error('В демо это действие недоступно.');
}
const state = {
  source: 'secretary',
  sourceChosen: false,
  account: {},
  streamStatus: {},
  streamChats: [],
  chatRequest: 0,
  nextChatId: null,
  nextCursor: null,
  loadedSource: '',
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
  accountPanel: document.querySelector('#accountPanel'),
  accountTitle: document.querySelector('#accountTitle'),
  accountDetail: document.querySelector('#accountDetail'),
  accountToggle: document.querySelector('#accountToggle'),
  sourceSwitch: document.querySelector('#sourceSwitch'),
  streamSource: document.querySelector('#streamSource'),
  archiveSource: document.querySelector('#archiveSource'),
  chatSearch: document.querySelector('#chatSearch'),
  moreChatsButton: document.querySelector('#moreChatsButton'),
  olderButton: document.querySelector('#olderButton'),
  accountShareConsent: document.querySelector('#accountShareConsent'),
  shareConsent: document.querySelector('#shareConsent'),
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

function sourcePath(path, source = state.source) { return source === 'account' ? `/account${path}` : path; }
function renderAccount() {
  const account = state.account;
  elements.accountPanel.hidden = !account.can_setup && !account.available;
  elements.sourceSwitch.hidden = !account.available;
  elements.archiveSource.disabled = !account.available;
  elements.streamSource.setAttribute('aria-pressed', String(state.source === 'secretary'));
  elements.archiveSource.setAttribute('aria-pressed', String(state.source === 'account'));
  elements.accountTitle.textContent = account.available ? (account.enabled ? 'Архив аккаунта подключён' : 'Синхронизация архива остановлена') : 'Архив аккаунта не подключён';
  elements.accountDetail.textContent = account.available
    ? `Чатов: ${account.chats || 0} · сообщений: ${account.messages || 0} · история: ${account.complete_chats || 0}/${account.chats || 0}${account.status === 'flood_wait' ? ' · пауза Telegram' : account.status === 'quota' ? ' · дневной лимит' : account.reconciliation_required ? ' · нужна повторная сверка' : account.status === 'error' ? ' · ошибка синхронизации' : ''}`
    : 'Подключение и первоначальная загрузка ещё не завершены.';
  elements.accountToggle.hidden = !account.available;
  const command = account.enabled ? 'Остановить синхронизацию' : 'Включить синхронизацию';
  elements.accountToggle.title = command; elements.accountToggle.setAttribute('aria-label', command);
  elements.accountToggle.replaceChildren(); const icon = document.createElement('i'); icon.dataset.lucide = account.enabled ? 'pause' : 'play'; elements.accountToggle.append(icon); renderIcons();
  if (state.source === 'account') {
    elements.statusBand.classList.toggle('connected', Boolean(account.enabled));
    elements.statusTitle.textContent = account.dialogs_complete ? 'Список чатов загружен' : 'Загрузка списка чатов';
    elements.statusDetail.textContent = account.last_sync_at ? `Последняя синхронизация: ${formatDate(account.last_sync_at)}` : 'Первая синхронизация ещё не завершена';
  } else {
    const data = state.streamStatus;
    elements.statusBand.classList.toggle('connected', data.connected === true);
    elements.statusTitle.textContent = data.connected ? 'Secretary Mode подключён' : 'Secretary Mode не подключён';
    elements.statusDetail.textContent = data.connected ? `Новые сообщения · хранение: ${data.retention_days} дней` : 'Ожидается подключение бота к Telegram-аккаунту';
  }
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

  const enabled = Boolean(chat && state.messages.length && state.loadedChatId === state.selectedChatId && state.loadedSource === state.source);
  elements.copyButton.disabled = !enabled;
  elements.downloadButton.disabled = !enabled;
  elements.shareButton.disabled = !enabled;
  elements.deleteButton.disabled = !chat;
  elements.olderButton.hidden = state.source !== 'account' || !state.nextCursor;
}

async function loadMessages() {
  const requestId = ++state.messageRequest;
  const chatId = state.selectedChatId;
  const source = state.source;
  state.loadedChatId = "";
  state.loadedSource = '';
  state.nextCursor = null;
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
    limit: '200',
  });
  const response = await api(sourcePath(`/messages?${query}`, source)), data = await response.json();
  if (requestId !== state.messageRequest || state.selectedChatId !== chatId || state.source !== source) return;
  state.messages = data.messages || [];
  state.nextCursor = data.next_cursor || null;
  state.markdown = buildContextMarkdown({ chatTitle: selectedChat()?.chat_title, chatId, messages: state.messages });
  state.loadedChatId = chatId;
  state.loadedSource = source;
  renderMessages();
}

async function loadOlder() {
  if (!state.nextCursor || state.source !== 'account' || elements.olderButton.disabled) return;
  const requestId = state.messageRequest, chatId = state.selectedChatId, cursor = state.nextCursor;
  elements.olderButton.disabled = true;
  try {
    const response = await api(`/account/messages?${new URLSearchParams({ chat_id: chatId, limit: '200', before: cursor })}`), data = await response.json();
    if (state.source !== 'account' || state.selectedChatId !== chatId || state.messageRequest !== requestId) return;
    const combined = [...(data.messages || []), ...state.messages];
    state.messages = [...new Map(combined.map(row => [row.message_id, row])).values()];
    state.nextCursor = data.next_cursor || null;
    state.markdown = buildContextMarkdown({ chatTitle: selectedChat()?.chat_title, chatId, messages: state.messages });
    renderMessages();
  } catch (error) { showToast(error.message); }
  finally { elements.olderButton.disabled = false; }
}

async function loadSourceChats({ append = false } = {}) {
  const requestId = ++state.chatRequest, source = state.source;
  const query = new URLSearchParams({ q: elements.chatSearch.value.trim() });
  if (append && state.nextChatId) query.set('after', state.nextChatId);
  let chats, next = null;
  if (source === 'account') {
    const response = await api(`/account/chats?${query}`), data = await response.json(); chats = data.chats || []; next = data.next_chat_id || null;
  } else {
    const search = elements.chatSearch.value.trim().toLowerCase();
    chats = state.streamChats.filter(chat => chat.chat_title.toLowerCase().includes(search));
  }
  if (state.chatRequest !== requestId || source !== state.source) return;
  state.chats = append ? [...new Map([...state.chats, ...chats].map(chat => [String(chat.chat_id), chat])).values()] : chats;
  state.nextChatId = next; elements.moreChatsButton.hidden = !next;
  const previous = state.selectedChatId; renderChats();
  if (!append || previous !== state.selectedChatId) await loadMessages();
}

async function loadAll({ quiet = false } = {}) {
  if (!quiet) setLoading(true);
  try {
    const requestId = ++state.chatRequest;
    const [streamResponse, accountResponse] = await Promise.all([api('/chats'), api('/account/status').catch(() => null)]);
    const data = await streamResponse.json(), account = accountResponse ? await accountResponse.json() : { available: false };
    if (requestId !== state.chatRequest) return;
    state.streamStatus = data; state.streamChats = data.chats || []; state.account = account;
    if (!account.available) state.source = 'secretary';
    else if (!state.sourceChosen) state.source = 'account';
    renderAccount();
    await loadSourceChats();
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
  elements.limitSelect.disabled = busy;
  elements.shareConsent.disabled = busy;
  for (const button of elements.shareList.querySelectorAll("button")) button.disabled = busy;
}

function checkedShare(share, target) {
  if (!share || typeof share.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(share.id)) throw new Error('Нет подтверждения ссылки от сервера.');
  let url;
  try { url = new URL(share.url); } catch { throw new Error('Нет подтверждения ссылки от сервера.'); }
  const prefix = target.source === 'account' ? '/account-context-share/' : '/context-share/';
  const parts = url.pathname.slice(prefix.length).split('.');
  const expectedOrigin = demoMode ? 'https://example.invalid' : location.origin;
  if (url.origin !== expectedOrigin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(prefix) || parts.length !== 2 || parts[0] !== share.id || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
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
  const response = await shareApi(sourcePath(`/shares?${new URLSearchParams({ chat_id: state.shareTarget.chat_id })}`, state.shareTarget.source));
  const data = await response.json();
  if (!Array.isArray(data.shares)) throw new Error("Не удалось получить ссылки.");
  renderShareLinks(data.shares.map(share => checkedShare(share, state.shareTarget)));
}

async function openShareDialog() {
  const chat = selectedChat();
  if (!chat || !state.messages.length || state.loadedChatId !== state.selectedChatId || state.loadedSource !== state.source) return;
  state.shareTarget = { chat_id: state.selectedChatId, limit: 200, title: chat.chat_title, source: state.source };
  state.shareRequestId = crypto.randomUUID();
  elements.shareTarget.textContent = state.shareTarget.title;
  elements.limitSelect.value = '200';
  elements.shareConsent.checked = false;
  elements.accountShareConsent.hidden = state.source !== 'account';
  updateShareWarning();
  elements.shareError.hidden = true;
  elements.shareStatus.textContent = "";
  elements.shareTtl.value = "24";
  elements.shareList.replaceChildren();
  elements.shareDialog.showModal(); setShareBusy(true);
  try { await reloadShareLinks(); }
  catch (error) { elements.shareError.textContent = error.message; elements.shareError.hidden = false; }
  finally { setShareBusy(false); }
}

function updateShareWarning() {
  elements.shareWarning.textContent = `Любой, у кого есть ссылка, сможет читать последние ${state.shareTarget.limit} сообщений ${state.shareTarget.source === 'account' ? 'архива этого чата' : 'этого чата'}, включая новые, до конца срока. Отзыв ссылки не удаляет уже скачанные копии.`;
}

async function createShareLink(event) {
  event.preventDefault();
  if (state.shareBusy || !state.shareTarget) return;
  if (state.shareTarget.source === 'account' && !elements.shareConsent.checked) {
    elements.shareError.textContent = 'Нужно согласие участников на передачу выбранного контекста.'; elements.shareError.hidden = false; return;
  }
  setShareBusy(true); elements.shareError.hidden = true; elements.shareStatus.textContent = "Создание…";
  let created = false;
  try {
    const response = await shareApi(sourcePath('/shares', state.shareTarget.source), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      id: state.shareRequestId, chat_id: state.shareTarget.chat_id, limit: state.shareTarget.limit, ttl_hours: Number(elements.shareTtl.value),
      ...(state.shareTarget.source === 'account' ? { consent_confirmed: elements.shareConsent.checked } : {}),
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
    await shareApi(sourcePath(`/shares/${encodeURIComponent(id)}`, state.shareTarget.source), { method: "DELETE" });
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
  const confirmed = window.confirm(`Удалить ${state.source === 'account' ? 'сохранённый архив' : 'сохранённый поток новых сообщений'} чата «${chat.chat_title}»? Саму переписку в Telegram это не удалит.`);
  if (!confirmed) return;
  setLoading(true);
  try {
    await api(sourcePath(`/chats/${encodeURIComponent(state.selectedChatId)}`), { method: "DELETE" });
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
elements.limitSelect.addEventListener('change', () => {
  if (!state.shareTarget) return;
  state.shareTarget.limit = Number(elements.limitSelect.value); state.shareRequestId = crypto.randomUUID(); updateShareWarning();
});
elements.olderButton.addEventListener('click', loadOlder);
elements.moreChatsButton.addEventListener('click', async () => {
  elements.moreChatsButton.disabled = true;
  try { await loadSourceChats({ append: true }); } catch (error) { showToast(error.message); }
  finally { elements.moreChatsButton.disabled = false; }
});
function switchSource(source) {
  if (source === state.source || (source === 'account' && !state.account.available)) return;
  state.source = source; state.sourceChosen = true; state.selectedChatId = ''; elements.chatSearch.value = ''; ++state.messageRequest; ++state.chatRequest;
  loadAll();
}
elements.streamSource.addEventListener('click', () => switchSource('secretary'));
elements.archiveSource.addEventListener('click', () => switchSource('account'));
let searchTimer;
elements.chatSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  ++state.chatRequest;
  searchTimer = setTimeout(() => loadSourceChats().catch(error => showToast(error.message)), 250);
});
elements.accountToggle.addEventListener('click', async () => {
  const enable = !state.account.enabled;
  if (enable && !window.confirm('Включить синхронизацию облачных чатов и истории подключённого аккаунта?')) return;
  elements.accountToggle.disabled = true;
  try {
    const response = await api(`/account/${enable ? 'enable' : 'pause'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(enable ? { confirmed: true, account_id: state.account.account_id } : {}) });
    state.account = await response.json(); renderAccount();
    showToast(enable ? 'Синхронизация включена' : 'Синхронизация остановлена');
  } catch (error) { showToast(error.message); }
  finally { elements.accountToggle.disabled = false; }
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
