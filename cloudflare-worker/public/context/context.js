const telegram = window.Telegram?.WebApp;
const state = {
  chats: [],
  messages: [],
  selectedChatId: "",
  markdown: "",
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
};

let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setLoading(loading) {
  elements.loadingOverlay.classList.toggle("hidden", !loading);
}

async function api(path, options = {}) {
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

  const enabled = Boolean(chat && state.messages.length);
  elements.copyButton.disabled = !enabled;
  elements.downloadButton.disabled = !enabled;
  elements.deleteButton.disabled = !chat;
}

async function loadMessages() {
  if (!state.selectedChatId) {
    state.messages = [];
    state.markdown = "";
    renderMessages();
    return;
  }
  const query = new URLSearchParams({
    chat_id: state.selectedChatId,
    limit: elements.limitSelect.value,
  });
  const [messagesResponse, exportResponse] = await Promise.all([
    api(`/messages?${query}`),
    api(`/export?${query}`),
  ]);
  state.messages = (await messagesResponse.json()).messages || [];
  state.markdown = await exportResponse.text();
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
    setLoading(false);
  }
}

async function copyMarkdown() {
  if (!state.markdown) return;
  try {
    await navigator.clipboard.writeText(state.markdown);
  } catch {
    const input = document.createElement("textarea");
    input.value = state.markdown;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  telegram?.HapticFeedback?.notificationOccurred("success");
  showToast("Контекст скопирован");
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

loadAll();
