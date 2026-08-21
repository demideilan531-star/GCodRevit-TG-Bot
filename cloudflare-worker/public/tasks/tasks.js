const telegram = window.Telegram?.WebApp;
const demoMode = new URLSearchParams(location.search).get("demo") === "1";
const moscowDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
});
const dateTimeLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const monthLabel = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

const flagColors = {
  work: "blue",
  study: "purple",
  gcod: "green",
  personal: "amber",
  urgent: "coral",
};

const state = {
  tasks: [],
  flags: [],
  view: "list",
  flagFilter: "all",
  statusFilter: "active",
  month: new Date(),
  selectedDay: moscowDate.format(new Date()),
};

const elements = Object.fromEntries(
  [
    "todayLabel", "addTaskButton", "listView", "calendarView", "summaryBand",
    "flagFilter", "statusFilter", "taskGroups", "calendarHeading", "previousMonth",
    "nextMonth", "currentMonth", "calendarGrid", "selectedDayHeading", "selectedDayTasks",
    "taskDialog", "taskForm", "dialogTitle", "closeDialog", "cancelTaskButton",
    "deleteTaskButton", "taskId", "taskTitle", "taskDescription", "taskDueAt",
    "taskStatus", "statusField", "flagOptions", "loadingOverlay", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

function setupTelegram() {
  telegram?.ready();
  telegram?.expand();
  telegram?.setHeaderColor?.("secondary_bg_color");
  telegram?.setBackgroundColor?.("bg_color");
}

function demoTasks() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const nextWeek = new Date(today.getTime() + 5 * 86400000);
  const isoAt = (date, hour) => {
    const value = new Date(date);
    value.setHours(hour, 0, 0, 0);
    return value.toISOString();
  };
  return {
    flags: [
      { id: "work", label: "Работа" }, { id: "study", label: "Учёба" },
      { id: "gcod", label: "GCodRevit" }, { id: "personal", label: "Личное" },
      { id: "urgent", label: "Срочно" },
    ],
    tasks: [
      { id: "demo-1", title: "Проверить новый релиз GCod", description: "Проверить установщик и описание версии.", due_at: isoAt(today, 18), status: "todo", flags: ["gcod", "urgent"] },
      { id: "demo-2", title: "Отправить модель заказчику", description: "Выгрузить NWC после координации.", due_at: isoAt(tomorrow, 12), status: "in_progress", flags: ["work"] },
      { id: "demo-3", title: "Посмотреть лекцию", description: "Закрыть второй модуль курса.", due_at: isoAt(nextWeek, 19), status: "todo", flags: ["study"] },
      { id: "demo-4", title: "Купить продукты", description: "", due_at: null, status: "done", flags: ["personal"] },
    ],
  };
}

async function api(path = "", options = {}) {
  if (demoMode) {
    if (!options.method || options.method === "GET") {
      const data = demoTasks();
      const id = path.replace(/^\//, "");
      return id ? { task: data.tasks.find((task) => task.id === id) || null } : data;
    }
    throw new Error("В демонстрационном режиме изменения отключены.");
  }
  const initData = telegram?.initData || "";
  if (!initData) throw new Error("Открой календарь кнопкой внутри Telegram-бота.");
  const response = await fetch(`/api/tasks${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
      ...(options.headers || {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Ошибка HTTP ${response.status}`);
  return result;
}

function dayKey(value) {
  return value ? moscowDate.format(new Date(value)) : "";
}

function startOfToday() {
  return `${moscowDate.format(new Date())}T00:00:00+03:00`;
}

function isOverdue(task) {
  return task.status !== "done" && task.due_at && Date.parse(task.due_at) < Date.parse(startOfToday());
}

function visibleTasks() {
  return state.tasks.filter((task) => {
    if (task.status === "draft" || task.status === "archived") return false;
    const flagMatches = state.flagFilter === "all" || task.flags.includes(state.flagFilter);
    const statusMatches =
      state.statusFilter === "all" ||
      (state.statusFilter === "done" ? task.status === "done" : task.status !== "done");
    return flagMatches && statusMatches;
  });
}

function flagDefinition(id) {
  return state.flags.find((flag) => flag.id === id) || { id, label: id };
}

function flagChip(id) {
  const flag = flagDefinition(id);
  const span = document.createElement("span");
  span.className = `flag-chip flag-${id}`;
  span.textContent = flag.label;
  return span;
}

function taskRow(task) {
  const row = document.createElement("div");
  row.className = `task-row${task.status === "done" ? " done" : ""}`;

  const complete = document.createElement("button");
  complete.type = "button";
  complete.className = "complete-button";
  complete.textContent = task.status === "done" ? "✓" : "";
  complete.setAttribute("aria-label", task.status === "done" ? "Вернуть задачу" : "Выполнить задачу");
  complete.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleDone(task);
  });

  const main = document.createElement("button");
  main.type = "button";
  main.className = "task-main";
  main.style.border = "0";
  main.style.background = "transparent";
  main.style.color = "inherit";
  main.style.padding = "0";
  main.style.textAlign = "left";
  main.addEventListener("click", () => openTaskDialog(task));

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  main.append(title);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const due = document.createElement("span");
  due.className = `due-label${isOverdue(task) ? " overdue" : ""}`;
  due.textContent = task.due_at ? dateTimeLabel.format(new Date(task.due_at)) : "Без срока";
  meta.append(due);
  main.append(meta);

  const flags = document.createElement("div");
  flags.className = "flag-line";
  task.flags.forEach((id) => flags.append(flagChip(id)));
  main.append(flags);

  row.append(complete, main);
  return row;
}

function renderSummary() {
  const active = state.tasks.filter(
    (task) => !["draft", "done", "archived"].includes(task.status),
  );
  const today = moscowDate.format(new Date());
  const values = [
    [active.filter((task) => dayKey(task.due_at) === today).length, "Сегодня"],
    [active.filter(isOverdue).length, "Просрочено"],
    [active.length, "В работе"],
  ];
  elements.summaryBand.replaceChildren(
    ...values.map(([value, label]) => {
      const item = document.createElement("div");
      item.className = "summary-item";
      const strong = document.createElement("strong");
      strong.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      return item;
    }),
  );
}

function renderList() {
  renderSummary();
  const today = moscowDate.format(new Date());
  const tomorrowDate = new Date(Date.now() + 86400000);
  const tomorrow = moscowDate.format(tomorrowDate);
  const groups = [
    ["Просроченные", (task) => isOverdue(task)],
    ["Сегодня", (task) => dayKey(task.due_at) === today && !isOverdue(task)],
    ["Завтра", (task) => dayKey(task.due_at) === tomorrow],
    ["Предстоящие", (task) => task.due_at && dayKey(task.due_at) > tomorrow],
    ["Без срока", (task) => !task.due_at],
  ];
  const tasks = visibleTasks();
  const sections = [];
  for (const [label, predicate] of groups) {
    const items = tasks.filter(predicate);
    if (!items.length) continue;
    const section = document.createElement("section");
    section.className = "task-group";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const list = document.createElement("div");
    list.className = "task-list";
    items.forEach((task) => list.append(taskRow(task)));
    section.append(heading, list);
    sections.push(section);
  }
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Задач здесь пока нет";
    sections.push(empty);
  }
  elements.taskGroups.replaceChildren(...sections);
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function primaryFlag(task) {
  return task.flags.find((flag) => flag !== "urgent") || task.flags[0] || "work";
}

function renderCalendar() {
  const first = monthStart(state.month);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const today = moscowDate.format(new Date());
  elements.calendarHeading.textContent = monthLabel.format(first);

  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(gridStart, index);
    const key = moscowDate.format(date);
    const tasks = state.tasks.filter(
      (task) => !["draft", "archived"].includes(task.status) && dayKey(task.due_at) === key,
    );
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = [
      "calendar-day",
      date.getMonth() === first.getMonth() ? "" : "outside",
      key === today ? "today" : "",
      key === state.selectedDay ? "selected" : "",
    ].filter(Boolean).join(" ");
    cell.addEventListener("click", () => {
      state.selectedDay = key;
      state.month = monthStart(date);
      renderCalendar();
    });
    const number = document.createElement("span");
    number.className = "day-number";
    number.textContent = date.getDate();
    const markers = document.createElement("div");
    markers.className = "day-markers";
    tasks.slice(0, 3).forEach((task) => {
      const marker = document.createElement("span");
      const flag = primaryFlag(task);
      marker.className = `day-marker flag-${flag}`;
      marker.style.setProperty("--flag-color", `var(--${flagColors[flag] || "blue"})`);
      marker.textContent = task.title;
      markers.append(marker);
    });
    if (tasks.length > 3) {
      const more = document.createElement("span");
      more.className = "day-more";
      more.textContent = `ещё ${tasks.length - 3}`;
      markers.append(more);
    }
    cell.append(number, markers);
    cells.push(cell);
  }
  elements.calendarGrid.replaceChildren(...cells);
  renderDayAgenda();
}

function renderDayAgenda() {
  const date = new Date(`${state.selectedDay}T12:00:00+03:00`);
  elements.selectedDayHeading.textContent = dateLabel.format(date);
  const tasks = state.tasks.filter(
    (task) =>
      !["draft", "archived"].includes(task.status) &&
      dayKey(task.due_at) === state.selectedDay,
  );
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "На этот день задач нет";
    elements.selectedDayTasks.replaceChildren(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "task-list";
  tasks.forEach((task) => list.append(taskRow(task)));
  elements.selectedDayTasks.replaceChildren(list);
}

function render() {
  renderList();
  renderCalendar();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  elements.listView.classList.toggle("active", view === "list");
  elements.calendarView.classList.toggle("active", view === "calendar");
}

function renderFlagControls() {
  const filterOptions = [new Option("Все флажки", "all")];
  state.flags.forEach((flag) => filterOptions.push(new Option(flag.label, flag.id)));
  elements.flagFilter.replaceChildren(...filterOptions);

  elements.flagOptions.replaceChildren(
    ...state.flags.map((flag) => {
      const label = document.createElement("label");
      label.className = `flag-option flag-${flag.id}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "flags";
      input.value = flag.id;
      const span = document.createElement("span");
      span.textContent = flag.label;
      label.append(input, span);
      return label;
    }),
  );
}

function localInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
  return parts.replace(" ", "T");
}

function openTaskDialog(task = null) {
  elements.taskForm.reset();
  elements.taskId.value = task?.id || "";
  elements.taskTitle.value = task?.title || "";
  elements.taskDescription.value = task?.description || "";
  elements.taskDueAt.value = localInputValue(task?.due_at);
  elements.taskStatus.value = task?.status === "draft" ? "todo" : task?.status || "todo";
  elements.dialogTitle.textContent = task ? "Изменить задачу" : "Новая задача";
  elements.statusField.hidden = !task || task.status === "draft";
  elements.deleteTaskButton.hidden = !task || task.status === "draft";
  document.querySelectorAll('input[name="flags"]').forEach((input) => {
    input.checked = task?.flags?.includes(input.value) || false;
  });
  elements.taskDialog.showModal();
  elements.taskTitle.focus();
}

function closeTaskDialog() {
  elements.taskDialog.close();
}

function formPayload() {
  const due = elements.taskDueAt.value;
  const task = state.tasks.find((item) => item.id === elements.taskId.value);
  return {
    title: elements.taskTitle.value,
    description: elements.taskDescription.value,
    due_at: due ? new Date(`${due}:00+03:00`).toISOString() : null,
    flags: [...document.querySelectorAll('input[name="flags"]:checked')].map((input) => input.value),
    ...(elements.taskId.value && task?.status !== "draft"
      ? { status: elements.taskStatus.value }
      : {}),
  };
}

async function saveTask(event) {
  event.preventDefault();
  const id = elements.taskId.value;
  const wasDraft = state.tasks.find((task) => task.id === id)?.status === "draft";
  try {
    setBusy(true, "Сохранение");
    const result = await api(id ? `/${id}` : "", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(formPayload()),
    });
    const index = state.tasks.findIndex((task) => task.id === result.task.id);
    if (index >= 0) state.tasks[index] = result.task;
    else state.tasks.push(result.task);
    closeTaskDialog();
    render();
    showToast(wasDraft ? "Черновик обновлён. Подтверди его в чате." : "Задача сохранена");
    telegram?.HapticFeedback?.notificationOccurred("success");
  } catch (error) {
    showToast(error.message);
    telegram?.HapticFeedback?.notificationOccurred("error");
  } finally {
    setBusy(false);
  }
}

async function toggleDone(task) {
  try {
    const status = task.status === "done" ? "todo" : "done";
    const result = await api(`/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    state.tasks[state.tasks.findIndex((item) => item.id === task.id)] = result.task;
    render();
    telegram?.HapticFeedback?.impactOccurred("light");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteTask() {
  const id = elements.taskId.value;
  if (!id) return;
  if (!confirm("Удалить задачу?")) return;
  try {
    await api(`/${id}`, { method: "DELETE" });
    state.tasks = state.tasks.filter((task) => task.id !== id);
    closeTaskDialog();
    render();
    showToast("Задача удалена");
  } catch (error) {
    showToast(error.message);
  }
}

function setBusy(busy, label = "Загрузка задач") {
  elements.loadingOverlay.lastElementChild.textContent = label;
  elements.loadingOverlay.classList.toggle("hidden", !busy);
}

let toastTimeout;
function showToast(message) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimeout = setTimeout(() => elements.toast.classList.remove("visible"), 2800);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  elements.addTaskButton.addEventListener("click", () => openTaskDialog());
  elements.closeDialog.addEventListener("click", closeTaskDialog);
  elements.cancelTaskButton.addEventListener("click", closeTaskDialog);
  elements.deleteTaskButton.addEventListener("click", deleteTask);
  elements.taskForm.addEventListener("submit", saveTask);
  elements.flagFilter.addEventListener("change", () => {
    state.flagFilter = elements.flagFilter.value;
    renderList();
  });
  elements.statusFilter.addEventListener("change", () => {
    state.statusFilter = elements.statusFilter.value;
    renderList();
  });
  elements.previousMonth.addEventListener("click", () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1, 12);
    renderCalendar();
  });
  elements.nextMonth.addEventListener("click", () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1, 12);
    renderCalendar();
  });
  elements.currentMonth.addEventListener("click", () => {
    state.month = new Date();
    state.selectedDay = moscowDate.format(new Date());
    renderCalendar();
  });
}

async function start() {
  setupTelegram();
  elements.todayLabel.textContent = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  bindEvents();
  try {
    const result = await api();
    state.tasks = result.tasks || [];
    state.flags = result.flags || [];
    renderFlagControls();
    render();
    const requestedTask = new URLSearchParams(location.search).get("task");
    if (requestedTask) {
      let task = state.tasks.find((item) => item.id === requestedTask);
      if (!task) {
        const result = await api(`/${encodeURIComponent(requestedTask)}`);
        task = result.task;
        if (task) state.tasks.push(task);
      }
      if (task) openTaskDialog(task);
    }
  } catch (error) {
    showToast(error.message);
    elements.taskGroups.innerHTML = '<div class="empty-state">Не удалось загрузить задачи</div>';
  } finally {
    setBusy(false);
  }
}

start();
