"use strict";

const screen = document.querySelector("#screen");
const dialog = document.querySelector("#review");
const taskDialog = document.querySelector("#task-composer");
const category = document.querySelector("#category");
const storageKey = "opora-accounting:bank:v1";
const taskStorageKey = "opora-accounting:tasks:v1";
const amounts = new Intl.NumberFormat("ru-RU", {style: "currency", currency: "RUB"});
const dates = new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC"});
let operations = [];
let filter = "all";
let query = "";
let selectedRows = new Set();
let selected = null;
let feedback = "";
let connectionFeedback = "";
let signedInUser = null;
let authError = "";
let connectionState = {saved: false, status: "not_checked"};
let tasks = [];
let taskRecipient = "";
let voiceRecorder = null;
let voiceChunks = [];
let voiceUrl = "";
let agentActivity = {Нейла: "idle"};

const employees = [
  {name: "Нейла", role: "Банк и касса", status: "Работает", note: "51 и 50: выписки, кассовые ордера, статьи, сверка и черновики.", href: "#neila", avatar: "Н", point: "Обороты 50 / 51 и расхождения"},
  {name: "Марта", role: "Первичные документы", status: "В разработке", note: "Поступления, реализации, УПД, счета и акты.", href: "#marta", avatar: "М", point: "Документы без основания и закрывающих"},
  {name: "Лев", role: "Взаиморасчёты", status: "В разработке", note: "Контрагенты, договоры, авансы и акты сверки.", href: "#lev", avatar: "Л", point: "Просроченная дебиторка и кредиторка"},
  {name: "Рита", role: "Отчётность", status: "В разработке", note: "Периоды, контрольные соотношения и готовность отчётов.", href: "#rita", avatar: "Р", point: "Сроки и ошибки перед сдачей"},
];

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(stored)) operations = stored;
} catch {
  feedback = "Не удалось прочитать сохранённые операции.";
}
try {
  const storedTasks = JSON.parse(localStorage.getItem(taskStorageKey) || "[]");
  if (Array.isArray(storedTasks)) tasks = storedTasks;
} catch {
  // Задачи не влияют на доступность рабочего места.
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function save(next) {
  localStorage.setItem(storageKey, JSON.stringify(next));
  operations = next;
}

function saveTasks(next) {
  localStorage.setItem(taskStorageKey, JSON.stringify(next));
  tasks = next;
}

function taskButton(name) {
  const count = tasks.filter(task => task.recipient === name && task.status === "new").length;
  return `<button class="task-fab" data-task-for="${escapeHtml(name)}" title="Дать задачу ${escapeHtml(name)}" aria-label="Дать задачу ${escapeHtml(name)}">＋${count ? `<span>${count}</span>` : ""}</button>`;
}

function employeeStatus(employee) {
  const openTasks = tasks.filter(task => task.recipient === employee.name && task.status === "new").length;
  if (employee.name !== "Нейла") {
    if (openTasks) return {label: `Новая задача · ${openTasks}`, tone: "attention", note: "Ожидает запуска функционального модуля."};
    return {label: "В разработке", tone: "building", note: "Функциональный модуль ещё не включён."};
  }
  if (agentActivity.Нейла === "working") return {label: "Работает в 1С", tone: "working", note: "Читает или сверяет документы. Изменения в 1С не выполняются."};
  if (connectionState.status === "error") return {label: "Ошибка подключения", tone: "error", note: "Нужно проверить подключение к 1С."};
  const review = operations.filter(row => ["review", "unknown"].includes(row.status) || row.syncState === "missing").length;
  if (review) return {label: `Ждёт решения · ${review}`, tone: "attention", note: "Есть операции, требующие решения бухгалтера."};
  if (openTasks) return {label: `Новая задача · ${openTasks}`, tone: "attention", note: "Готова взять задачу в работу."};
  return {label: connectionState.status === "connected" ? "Свободна · 1С подключена" : "Свободна", tone: "ready", note: "Очередь пуста; Нейла готова к следующей задаче."};
}

function statusPill(employee) {
  const status = employeeStatus(employee);
  return `<span class="employee-status ${status.tone}">${status.label}</span>`;
}

function identity(row) {
  return JSON.stringify([row.date, row.direction, row.kopecks, row.counterparty, row.purpose, row.reference]);
}

function amount(row) {
  return (row.direction === "in" ? "+" : "−") + amounts.format(row.kopecks / 100);
}

function formatDate(date) {
  return dates.format(new Date(date));
}

function stats() {
  return Object.fromEntries(Object.keys(Bank.status).map(status => [status, operations.filter(row => row.status === status).length]));
}

function badge(status) {
  return `<span class="badge ${status}">${Bank.status[status]}</span>`;
}

function renderAccount() {
  const account = document.querySelector("#account");
  if (!account) return;
  if (signedInUser) {
    account.innerHTML = `<span class="account-name">${escapeHtml(signedInUser.name)}</span><span class="account-email">${escapeHtml(signedInUser.email)}</span><button class="secondary" id="sign-out">Выйти</button>`;
    return;
  }
  account.innerHTML = `<button id="sign-in">Войти через Google</button>${authError ? `<small class="feedback">${escapeHtml(authError)}</small>` : ""}`;
}

async function refreshConnectionStatus() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return;
  try {
    const response = await fetch("/api/1c/status", {cache: "no-store"});
    if (!response.ok) return;
    connectionState = await response.json();
    if (location.hash === "#connections") render();
  } catch {
    // Статус останется локальным, если защищённый сервис ещё не запущен.
  }
}

function nonBank(page) {
  const counts = stats();
  if (page === "team") return `
    <div class="breadcrumb">Рабочее пространство <span aria-hidden="true">/</span> ИИ-сотрудники</div>
    <header class="hero"><div><h1>ИИ-сотрудники</h1><p>Единый формат работы: контрольная точка → очередь → решение → журнал.</p></div></header>
    <section class="employee-grid" aria-label="Сотрудники ОПОРЫ">
      ${employees.map(employee => `<article class="card employee employee-card">
        <span class="avatar" aria-hidden="true">${employee.avatar}</span>
        <div class="employee-body"><div class="employee-title"><div><h2>${employee.name}</h2><p>${employee.role}</p></div>${statusPill(employee)}</div>
        <p class="muted">${employeeStatus(employee).note}</p></div>
        <small class="checkpoint">Контроль: ${employee.point}</small><div class="employee-actions">${taskButton(employee.name)}<a class="button" href="${employee.href}">Открыть</a></div>
      </article>`).join("")}
    </section>`;
  const employee = employees.find(item => item.name.toLowerCase() === page);
  if (employee) return `
    <div class="breadcrumb"><a href="#home">Главная</a><span aria-hidden="true">/</span> ${employee.name}</div>
    <header class="hero"><div class="profile"><span class="avatar" aria-hidden="true">${employee.avatar}</span><div><h1>${employee.name}</h1><p>ИИ-бухгалтер: ${employee.role}</p></div></div>${statusPill(employee)}</header>
    <section class="card agent-brief"><div class="heading"><h2>Контрольная точка</h2>${taskButton(employee.name)}</div><strong>${employee.point}</strong><p>${employee.note}</p><p class="muted">Интерфейс уже использует тот же цикл, что и у Нейлы: показатели периода, очередь исключений, разбор решения и журнал. Функциональные источники 1С подключим после утверждения правил этого сотрудника.</p></section>`;
  return `
    <div class="breadcrumb">Рабочее пространство</div>
    <header class="hero">
      <div><h1>Главная</h1><p>Рабочее место заместителя главного бухгалтера</p></div>
    </header>
    <section class="metrics" aria-label="Ситуация по периоду"><div class="card metric"><span>Операций в контроле</span><strong>${operations.length}</strong></div><div class="card metric"><span>Требуют решения</span><strong>${counts.review + counts.unknown}</strong></div><div class="card metric"><span>Расхождения с 1С</span><strong>${operations.filter(row => row.syncState === "missing").length}</strong></div><div class="card metric"><span>ИИ-сотрудников</span><strong>${employees.length}</strong></div></section>
    <section class="chief-summary"><div><h2>Сводка заместителя главбуха</h2><p>Сначала разберите исключения по 50 / 51, затем переходите к первичке, взаиморасчётам и отчётности. Общая оборотка станет единым источником контрольных точек для всех сотрудников.</p></div><a class="button" href="#neila">Открыть очередь Нейлы</a></section>
    <section class="employee-grid" aria-label="Статусы ИИ-сотрудников">${employees.map(employee => `<article class="card employee employee-card"><span class="avatar" aria-hidden="true">${employee.avatar}</span><div class="employee-body"><div class="employee-title"><div><h2>${employee.name}</h2><p>${employee.role}</p></div>${statusPill(employee)}</div><p class="checkpoint">${employee.point}</p><p class="muted">${employeeStatus(employee).note}</p></div><div class="employee-actions">${taskButton(employee.name)}<a class="button" href="${employee.href}">Открыть</a></div></article>`).join("")}</section>`;
}

function operationTable(rows) {
  if (!rows.length) return `<div class="empty"><strong>${operations.length ? "В этой очереди пока пусто" : "Выписок пока нет"}</strong><p>${operations.length ? "Все загруженные записи доступны во вкладке «Все операции»." : "Загрузите банковскую выписку или попробуйте демонстрационный файл."}</p></div>`;
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Список банковских операций"><table>
    <thead><tr><th scope="col"><input id="select-visible" type="checkbox" aria-label="Выбрать все показанные операции" ${rows.length && rows.every(({index}) => selectedRows.has(index)) ? "checked" : ""}></th><th scope="col">Дата</th><th scope="col">Контрагент и назначение</th><th scope="col">Сумма</th><th scope="col">Категория</th><th scope="col">Статус</th><th scope="col"><span class="sr-only">Действие</span></th></tr></thead>
    <tbody>${rows.map(({row, index}) => `<tr>
      <td><input class="row-select" type="checkbox" data-select="${index}" aria-label="Выбрать операцию" ${selectedRows.has(index) ? "checked" : ""}></td>
      <td class="nowrap">${formatDate(row.date)}</td>
      <td><strong>${escapeHtml(row.counterparty || "Контрагент не указан")}</strong><small>${escapeHtml(row.purpose || "Назначение не указано")}</small><small>Документ: ${escapeHtml(row.origin || "Загруженная выписка")}</small></td>
      <td class="nowrap amount ${row.direction}">${amount(row)}</td>
      <td>${escapeHtml(row.category || "—")}${row.score === null ? "" : `<small>Уверенность ${row.score}%</small>`}<small>Источник: ${escapeHtml(row.source || "Правило Нейлы")}</small></td>
      <td>${badge(row.status)}${row.syncState === "matched" ? `<small class="sync-found">1С: документ № ${escapeHtml(row.syncDocumentNumber || "найден")}</small>` : row.syncState === "missing" ? '<small class="sync-missing">1С: документ не найден</small>' : '<small>1С: не сверено</small>'}</td>
      <td><button class="secondary" data-review="${index}">${["review", "unknown"].includes(row.status) ? "Разобрать" : "Открыть"}</button></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function money(kopecks) {
  return amounts.format(kopecks / 100);
}

function monthlyRows(account) {
  const months = new Map();
  operations.filter(row => (row.account || "51") === account).forEach(row => {
    const month = row.date.slice(0, 7);
    const summary = months.get(month) || {month, incoming: 0, outgoing: 0, count: 0, review: 0, missing: 0};
    if (row.direction === "in") summary.incoming += row.kopecks;
    else summary.outgoing += row.kopecks;
    summary.count++;
    if (["review", "unknown"].includes(row.status)) summary.review++;
    if (row.syncState === "missing") summary.missing++;
    months.set(month, summary);
  });
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}

function monthLabel(value) {
  const [year, month] = value.split("-");
  return new Intl.DateTimeFormat("ru-RU", {month: "long", year: "numeric", timeZone: "UTC"})
    .format(new Date(`${year}-${month}-01T00:00:00Z`));
}

function analyticsTable(account) {
  const rows = monthlyRows(account);
  if (!rows.length) return `<div class="empty"><strong>За этот счёт пока нет данных</strong><p>Нейла заполнит контроль после импорта выписки или чтения документов 1С.</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th>Поступления</th><th>Расходы</th><th>Операций</th><th>На проверке</th><th>Расхождения с 1С</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(monthLabel(row.month))}</strong></td><td class="amount in">+${money(row.incoming)}</td><td class="amount">−${money(row.outgoing)}</td><td>${row.count}</td><td>${row.review || "—"}</td><td>${row.missing ? `<span class="sync-missing">${row.missing}</span>` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

function neilaTabs(active) {
  const tabs = [["neila-bank", "Банк"], ["neila-cash", "Касса"], ["neila-control", "Контроль счетов"]];
  return `<nav class="subnav" aria-label="Разделы Нейлы">${tabs.map(([href, label]) => `<a href="#${href}" ${active === href ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function neilaHub() {
  const waiting = operations.filter(row => ["review", "unknown"].includes(row.status)).length;
  return `
    <div class="breadcrumb"><a href="#home">Главная</a><span aria-hidden="true">/</span> Нейла</div>
    <header class="hero"><div class="profile"><span class="avatar" aria-hidden="true">Н</span><div><h1>Нейла</h1><p>ИИ-бухгалтер по банку и кассе</p><div class="hero-status">${statusPill(employees[0])}</div></div></div><div class="hero-actions">${taskButton("Нейла")}<a class="button hero-link" href="#neila-control">Контроль счетов</a></div></header>
    ${neilaTabs("hub")}
    <section class="metrics"><div class="card metric"><span>Операций в контроле</span><strong>${operations.length}</strong></div><div class="card metric"><span>На проверке</span><strong>${waiting}</strong></div><div class="card metric"><span>Счёт 51</span><strong>${operations.filter(row => (row.account || "51") === "51").length}</strong></div><div class="card metric"><span>Счёт 50</span><strong>${operations.filter(row => row.account === "50").length}</strong></div></section>
    <section class="card agent-brief"><h2>Зона ответственности Нейлы</h2><p>Корректность движения по 51 и 50: наличие документа, статья движения, контрагент, назначение, совпадение с выпиской и кассовыми ордерами.</p><div class="action-links"><a href="#neila-bank">Банк · 51</a><a href="#neila-cash">Касса · 50</a><a href="#neila-control">Контроль счетов</a></div></section>`;
}

function analyticsPage() {
  const bank = monthlyRows("51").reduce((sum, row) => sum + row.incoming - row.outgoing, 0);
  const cash = monthlyRows("50").reduce((sum, row) => sum + row.incoming - row.outgoing, 0);
  const flagged = operations.filter(row => ["review", "unknown"].includes(row.status) || row.syncState === "missing").length;
  const isSecureWorkspace = ["localhost", "127.0.0.1"].includes(location.hostname);
  return `
    <div class="breadcrumb"><a href="#neila">Нейла</a><span aria-hidden="true">/</span> Контроль 50 / 51</div>
    <header class="hero"><div><h1>Нейла · Банк и касса</h1><p>Ежемесячный контроль операций по счетам 50 и 51</p></div><div class="hero-actions">${taskButton("Нейла")}${isSecureWorkspace ? '<button id="load-1c-months">Обновить из 1С</button>' : ""}</div></header>
    ${neilaTabs("neila-control")}
    <section class="metrics" aria-label="Итоги контроля"><div class="card metric"><span>Чистый поток · 51</span><strong>${money(bank)}</strong></div><div class="card metric"><span>Чистый поток · 50</span><strong>${money(cash)}</strong></div><div class="card metric"><span>Операций в контроле</span><strong>${operations.length}</strong></div><div class="card metric"><span>Требуют внимания</span><strong>${flagged}</strong></div></section>
    <section class="control-note"><strong>Что делает Нейла</strong><span>Собирает банковские документы и кассовые ордера из 1С, классифицирует статьи, показывает обороты по месяцам и выделяет операции без документа или решения.</span></section>
    <section class="card analytics-card"><div class="ledger-heading"><div><h2>Счёт 51 · Расчётные счета</h2><p class="muted">Источник: поступления и списания с расчётного счёта в 1С, либо загруженная банковская выписка.</p></div></div>${analyticsTable("51")}</section>
    <section class="card analytics-card"><div class="ledger-heading"><div><h2>Счёт 50 · Касса</h2><p class="muted">Источник: приходные и расходные кассовые ордера 1С. Данные ОФД — вспомогательный источник для сверки, не замена кассовых документов.</p></div></div>${analyticsTable("50")}</section>
    <section class="card data-map"><h2>Контур данных Нейлы</h2><div><strong>51 · Банк:</strong> API банка / файл выписки → документы 1С → Нейла → сверка, статьи, черновики.</div><div><strong>50 · Касса:</strong> ПКО и РКО 1С → Нейла → контроль статей и расхождений. В будущем: Мой ОФД → сверка фискальных чеков с кассой.</div><p class="muted">Нейла не проводит документы автоматически. Создание или изменение черновика всегда будет отдельным подтверждаемым действием бухгалтера.</p></section>`;
}

function bankPage(account = "51") {
  const isCash = account === "50";
  const scope = operations.filter(row => (row.account || "51") === account);
  const counts = Object.fromEntries(Object.keys(Bank.status).map(status => [status, scope.filter(row => row.status === status).length]));
  const queueSize = counts.review + counts.unknown;
  const rate = operations.length ? `${new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1}).format(counts.auto / operations.length * 100)}%` : "—";
  const pending = row => ["review", "unknown"].includes(row.status);
  const needle = query.trim().toLowerCase().replace(/\s/g, "");
  const found = row => !needle || [row.counterparty, row.purpose, row.category, String(row.kopecks / 100).replace(".", ",")]
    .some(value => String(value || "").toLowerCase().replace(/\s/g, "").includes(needle));
  const rows = operations.map((row, index) => ({row, index}))
    .filter(({row}) => (row.account || "51") === account && (filter === "all" || pending(row)) && found(row))
    .sort((a, b) => b.row.date.localeCompare(a.row.date));
  const metrics = [["Всего операций", scope.length], ["Распознано автоматически", counts.auto], ["В очереди на проверку", queueSize], ["Доля автораспознавания", rate]];
  const sync = scope.reduce((result, row) => {
    result[row.syncState || "unchecked"]++;
    return result;
  }, {matched: 0, missing: 0, unchecked: 0});
  const isSecureWorkspace = ["localhost", "127.0.0.1"].includes(location.hostname);
  return `
    <div class="breadcrumb"><a href="#neila">Нейла</a><span aria-hidden="true">/</span> ${isCash ? "Касса" : "Банк"}</div>
    <header class="hero">
      <div class="profile"><span class="avatar" aria-hidden="true">Н</span><div><h1>${isCash ? "Касса · 50" : "Банк · 51"}</h1><p>Нейла · ИИ-бухгалтер по банку и кассе</p><div class="hero-status">${statusPill(employees[0])}</div></div></div>
      <div class="hero-actions">${taskButton("Нейла")}${isCash ? "" : '<button id="upload">+ Загрузить выписку</button>'}</div>
      <input type="file" id="file" accept=".txt,.csv" hidden aria-label="Файл банковской выписки">
    </header>
    ${neilaTabs(isCash ? "neila-cash" : "neila-bank")}
    <div class="import-info"><span>${isCash ? "Источник: ПКО и РКО в 1С; Мой ОФД будет добавлен как сверочный источник." : "CSV по образцу или TXT в формате 1С"}</span>${isCash ? "" : '<a href="examples/vypiska.csv" download>Скачать образец CSV</a><button class="text-button" id="demo">Открыть демо</button>'}</div>
    <p class="feedback" role="status">${escapeHtml(feedback)}</p>
    <section class="metrics" aria-label="Итоги обработки">${metrics.map(([label, value]) => `<div class="card metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}</section>
    <section class="card ledger" aria-labelledby="ledger-title">
      <div class="ledger-heading"><div><h2 id="ledger-title">${isCash ? "Кассовые операции" : "Банковские операции"}</h2><p class="muted">${isCash ? "Нейла контролирует ПКО, РКО и статьи движения по кассе." : "Нейла классифицирует выписку, сверяет её с 1С и готовит черновики."} Проведённые документы не изменяются.</p></div>
        <div class="filters" aria-label="Фильтр операций">
          <button class="secondary" aria-pressed="${filter === "all"}" data-filter="all">Все операции</button>
          <button class="secondary" aria-pressed="${filter === "queue"}" data-filter="queue">На проверку · ${queueSize}</button>
        </div>
      </div>
      <div class="reconciliation" aria-label="Статус сверки с 1С">
        <strong>Сверка с 1С</strong><span class="sync-found">Совпало: ${sync.matched}</span><span class="sync-missing">Нет документа: ${sync.missing}</span><span class="sync-unchecked">Не сверено: ${sync.unchecked}</span>
        <p>${isSecureWorkspace ? "Сравнение идёт по дате, направлению и сумме. Нейла не меняет документы при сверке." : "Сверка и создание черновиков доступны в защищённом рабочем контуре, где подключена 1С. Здесь можно просматривать и разбирать выписки."}</p>
      </div>
      <div class="ledger-tools"><input id="operation-search" type="search" placeholder="Поиск по назначению, контрагенту или сумме" value="${escapeHtml(query)}" aria-label="Поиск операций">${isSecureWorkspace ? `<button class="secondary" id="reconcile">${selectedRows.size ? `Сверить выбранные · ${selectedRows.size}` : "Сверить с 1С"}</button>` : ""}<span>${selectedRows.size ? `Выбрано: ${selectedRows.size}` : ""}</span>${selectedRows.size ? '<button class="secondary" id="clear-selection">Снять выделение</button>' : ""}</div>
      ${operationTable(rows)}
    </section>`;
}

function connectionsPage() {
  const state = connectionState;
  const label = state.status === "connected" ? "Подключено" : state.status === "error" ? "Ошибка подключения" : state.saved ? "Сохранено, ещё не проверено" : "Не подключено";
  const detail = state.status === "error" ? state.error : state.checkedAt ? `Последняя проверка: ${new Date(state.checkedAt).toLocaleString("ru-RU")}` : "";
  return `
    <div class="breadcrumb">Настройки <span aria-hidden="true">/</span> Подключения</div>
    <header class="hero compact-hero">
      <div><h1>Подключение 1С</h1><p>Один канал обмена для 1С:Фреш и локальной базы</p></div>
    </header>
    <section class="connection-grid">
      <form id="connection-form" class="card connection-form">
        <fieldset>
          <legend>Где находится база</legend>
          <label class="radio"><input type="radio" name="kind" value="fresh" ${state.kind !== "local" ? "checked" : ""}> 1С:Фреш</label>
          <label class="radio"><input type="radio" name="kind" value="local" ${state.kind === "local" ? "checked" : ""}> Локальная база</label>
        </fieldset>
        <label>Адрес приложения 1С
          <input name="url" type="url" value="${escapeHtml(state.url || "")}" placeholder="https://1cfresh.com/a/bs/12345" autocomplete="url" required>
        </label>
        <label>Служебный пользователь
          <input name="username" value="${escapeHtml(state.username || "")}" autocomplete="username" required>
        </label>
        <label>Пароль
          <input name="password" type="password" placeholder="${state.passwordSaved ? "Сохранён в Связке ключей macOS" : "Введите пароль"}" autocomplete="current-password" ${state.passwordSaved ? "" : "required"}>
        </label>
        <label class="remember"><input type="checkbox" name="remember" ${state.passwordSaved ? "checked" : ""}> Сохранить пароль в Связке ключей этого Mac</label>
        <div class="connection-status ${state.status}"><strong>${label}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div>
        <button type="submit" name="action" value="verify">${state.passwordSaved ? "Проверить сохранённое подключение" : "Проверить подключение"}</button>
        <button class="secondary" type="submit" name="action" value="preview">Проверить Нейлу на 10 операциях</button>
        <p class="feedback connection-feedback" role="status">${escapeHtml(connectionFeedback)}</p>
      </form>
      <aside class="card setup-guide">
        <h2>Что настроить в 1С</h2>
        <ol>
          <li>Откройте «Настройки стандартного интерфейса OData».</li>
          <li>Создайте отдельного служебного пользователя.</li>
          <li>Разрешите только банковские документы и нужные справочники.</li>
          <li>Скопируйте адрес приложения и проверьте соединение.</li>
        </ol>
        <p class="muted">Адрес, логин и статус сохраняются локально. Пароль хранится только в Связке ключей macOS — не в браузере, не в 1С и не в файлах проекта.</p>
      </aside>
    </section>`;
}

function render() {
  const page = ["team", "bank", "analytics", "connections", "neila", "neila-bank", "neila-cash", "neila-control", "marta", "lev", "rita"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  document.querySelectorAll("nav a").forEach(link => {
    if (link.hash === `#${page}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  screen.innerHTML = page === "bank" || page === "neila-bank" ? bankPage("51") : page === "neila-cash" ? bankPage("50") : page === "analytics" || page === "neila-control" ? analyticsPage() : page === "neila" ? neilaHub() : page === "connections" ? connectionsPage() : nonBank(page);
  renderAccount();
}

screen.addEventListener("submit", async event => {
  if (event.target.id !== "connection-form") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  connectionFeedback = "Проверяем доступ к OData…";
  form.querySelector(".connection-feedback").textContent = connectionFeedback;
  const data = Object.fromEntries(new FormData(form));
  const preview = event.submitter?.value === "preview";
  try {
    const response = await fetch(preview ? "/api/1c/bank-preview" : "/api/1c/test", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось проверить подключение.");
    if (preview) {
      const additions = (result.operations || []).map(operationFrom1C).filter(Boolean).map(Bank.classify);
      if (!additions.length) throw new Error("1С не вернула подходящих банковских операций для теста.");
      save([...operations, ...additions]);
      feedback = `Нейла прочитала ${additions.length} операций из 1С. Ничего в базе не изменено.`;
      connectionFeedback = "Тест Нейлы завершён. Откройте рабочее место банка, чтобы посмотреть решения.";
      await refreshConnectionStatus();
      location.hash = "bank";
      return;
    }
    const resources = [...(result.bankDocuments || []), ...(result.cashDocuments || [])];
    const documents = resources.length
      ? ` Найдены ресурсы банка и кассы: ${resources.join(", ")}.`
      : " Соединение работает, ресурсы банка и кассы пока не открыты в составе OData.";
    connectionFeedback = `Подключение работает. Доступно объектов: ${result.entityCount}.${documents}`;
    await refreshConnectionStatus();
  } catch (error) {
    connectionFeedback = error.message;
    connectionState = {...connectionState, status: "error", error: connectionFeedback};
  }
  if (location.hash === "connections") {
    form.querySelector('input[name="password"]').value = "";
    form.querySelector(".connection-feedback").textContent = connectionFeedback;
  }
  button.disabled = false;
});

function operationFrom1C(operation) {
  const rawDate = String(operation.date || "");
  const timestamp = rawDate.match(/\/Date\((-?\d+)/);
  const date = timestamp
    ? new Date(Number(timestamp[1])).toISOString().slice(0, 10)
    : rawDate.slice(0, 10);
  const rawAmount = String(operation.amount || "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(rawAmount) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    kopecks: Math.round(Number(rawAmount) * 100),
    direction: operation.direction,
    counterparty: operation.counterparty || "Контрагент не указан",
    purpose: operation.purpose || `Документ 1С № ${operation.number || "без номера"}`,
    reference: `1С:${operation.number || ""}:${date}`,
    origin: `1С: ${operation.title || (operation.direction === "in" ? "Поступление на расчётный счёт" : "Списание с расчётного счёта")}`,
    account: operation.account === "50" ? "50" : "51",
  };
}

async function importStatement(read, origin = "Загруженная выписка") {
  const initialPage = location.hash;
  const upload = screen.querySelector("#upload");
  const demo = screen.querySelector("#demo");
  upload.disabled = demo.disabled = true;
  try {
    const rows = Bank.parse(await read());
    const known = new Map();
    const seen = new Map();
    for (const row of operations) {
      const key = identity(row);
      known.set(key, (known.get(key) || 0) + 1);
    }
    const additions = rows.filter(row => {
      const key = identity(row);
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      return count > (known.get(key) || 0);
    }).map(row => Bank.classify({...row, origin}));
    if (additions.length) save([...operations, ...additions]);
    feedback = `Добавлено операций: ${additions.length}. Уже в списке: ${rows.length - additions.length}.`;
    filter = "all";
  } catch (error) {
    feedback = error.name === "QuotaExceededError" || error.name === "SecurityError"
      ? "Браузер не смог сохранить выписку."
      : `Не удалось загрузить выписку. ${error.message}`;
  }
  if (location.hash === initialPage) render();
}

function openItem(index) {
  selected = index;
  const row = operations[index];
  document.querySelector("#details").innerHTML = `
    <p class="detail-amount">${amount(row)}</p>
    <p><strong>${escapeHtml(row.counterparty || "Контрагент не указан")}</strong> · ${formatDate(row.date)}</p>
    <p class="purpose">${escapeHtml(row.purpose || "Назначение не указано")}</p>
    <p>${badge(row.status)} ${row.score === null ? "" : `<span class="muted">Уверенность ${row.score}%</span>`}</p>
    <p class="muted">${escapeHtml(row.reason)}</p><p id="review-error" role="status"></p>`;
  category.innerHTML = '<option value="">Выберите категорию</option>' +
    Bank.categories.map(name => `<option>${escapeHtml(name)}</option>`).join("");
  category.value = row.category;
  dialog.showModal();
}

function openTaskComposer(recipient) {
  taskRecipient = recipient;
  voiceUrl = "";
  document.querySelector("#task-recipient").textContent = `Получатель: ${recipient}`;
  document.querySelector("#task-text").value = "";
  document.querySelector("#voice-preview").hidden = true;
  document.querySelector("#voice-status").textContent = "";
  document.querySelector("#record-voice").textContent = "● Записать голосовое";
  taskDialog.showModal();
}

async function toggleVoiceRecording() {
  const button = document.querySelector("#record-voice");
  const status = document.querySelector("#voice-status");
  if (voiceRecorder?.state === "recording") {
    voiceRecorder.stop();
    button.disabled = true;
    status.textContent = "Сохраняем запись…";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    voiceChunks = [];
    voiceRecorder = new MediaRecorder(stream);
    voiceRecorder.addEventListener("dataavailable", event => { if (event.data.size) voiceChunks.push(event.data); });
    voiceRecorder.addEventListener("stop", () => {
      const blob = new Blob(voiceChunks, {type: voiceRecorder.mimeType || "audio/webm"});
      voiceUrl = URL.createObjectURL(blob);
      const player = document.querySelector("#voice-preview");
      player.src = voiceUrl;
      player.hidden = false;
      status.textContent = "Голосовое прикреплено к задаче в этом рабочем месте.";
      button.disabled = false;
      button.textContent = "● Перезаписать голосовое";
      stream.getTracks().forEach(track => track.stop());
    });
    voiceRecorder.start();
    button.textContent = "■ Остановить запись";
    status.textContent = "Идёт запись…";
  } catch {
    status.textContent = "Не удалось включить микрофон. Проверьте разрешение браузера.";
  }
}

screen.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "upload") screen.querySelector("#file").click();
  if (button.id === "demo") importStatement(async () => {
    const response = await fetch("examples/vypiska.csv");
    if (!response.ok) throw new Error("Демонстрационный файл недоступен.");
    return response.arrayBuffer();
  }, "Демонстрационная выписка");
  if (button.id === "reconcile") reconcileWith1C(button);
  if (button.id === "load-1c-months") loadMonthlyControl(button);
  if (button.dataset.taskFor) openTaskComposer(button.dataset.taskFor);
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    render();
    screen.querySelector(`[data-filter="${filter}"]`).focus();
  }
  if (button.dataset.review !== undefined) openItem(Number(button.dataset.review));
  if (button.id === "clear-selection") { selectedRows.clear(); render(); }
});

async function reconcileWith1C(button) {
  if (!operations.length) return;
  const selectedOperations = selectedRows.size
    ? [...selectedRows].sort((a, b) => a - b).map(index => operations[index])
    : operations;
  button.disabled = true;
  agentActivity.Нейла = "working";
  feedback = `Сверяем с документами 1С: ${selectedOperations.length} операций…`;
  render();
  try {
    const response = await fetch("/api/1c/reconcile", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({operations: selectedOperations.map(row => ({
        reference: row.reference,
        date: row.date,
        direction: row.direction,
        kopecks: row.kopecks,
      }))}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось выполнить сверку.");
    const matches = new Map((result.results || []).map(item => [String(item.reference || ""), item]));
    let foundCount = 0;
    save(operations.map(row => {
      const match = matches.get(String(row.reference || ""));
      if (!match) return row;
      if (match.state === "matched") foundCount++;
      return {...row, syncState: match.state, syncDocumentNumber: match.documentNumber || ""};
    }));
    feedback = `Сверка завершена: совпало с документами 1С — ${foundCount}; не найдено — ${selectedOperations.length - foundCount}.`;
  } catch (error) {
    feedback = error.message;
  }
  agentActivity.Нейла = "idle";
  render();
}

async function loadMonthlyControl(button) {
  button.disabled = true;
  agentActivity.Нейла = "working";
  feedback = "Загружаем банковские и кассовые документы из 1С…";
  render();
  try {
    const response = await fetch("/api/1c/monthly-preview", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось загрузить документы 1С.");
    const additions = (result.operations || []).map(operationFrom1C).filter(Boolean).map(Bank.classify);
    const unique = new Map(operations.map(row => [identity(row), row]));
    additions.forEach(row => unique.set(identity(row), row));
    save([...unique.values()]);
    feedback = `Из 1С загружено для контроля: ${additions.length} документов. Ничего в 1С не изменено.`;
  } catch (error) {
    feedback = error.message;
  }
  agentActivity.Нейла = "idle";
  render();
}

document.querySelector(".sidebar").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "sign-in") window.NeilaAuth?.signIn();
  if (button.id === "sign-out") window.NeilaAuth?.signOut();
});

screen.addEventListener("change", event => {
  if (event.target.id === "select-visible") {
    const visible = [...screen.querySelectorAll(".row-select")].map(input => Number(input.dataset.select));
    visible.forEach(index => event.target.checked ? selectedRows.add(index) : selectedRows.delete(index));
    render();
    return;
  }
  if (event.target.matches(".row-select")) {
    const index = Number(event.target.dataset.select);
    event.target.checked ? selectedRows.add(index) : selectedRows.delete(index);
    const count = screen.querySelector(".ledger-tools span");
    if (count) count.textContent = selectedRows.size ? `Выбрано: ${selectedRows.size}` : "";
    return;
  }
  const file = event.target.id === "file" && event.target.files[0];
  if (!file) return;
  importStatement(() => {
    if (file.size > 10 * 1024 * 1024) throw new Error("Максимальный размер файла — 10 МБ.");
    return file.arrayBuffer();
  }, `Выписка: ${file.name}`);
});

screen.addEventListener("input", event => {
  if (event.target.id !== "operation-search") return;
  query = event.target.value;
  render();
  screen.querySelector("#operation-search")?.focus();
});

document.querySelector("#close").addEventListener("click", () => dialog.close());
document.querySelector("#close-task").addEventListener("click", () => taskDialog.close());
document.querySelector("#record-voice").addEventListener("click", toggleVoiceRecording);
document.querySelector("#task-form").addEventListener("submit", event => {
  event.preventDefault();
  const text = document.querySelector("#task-text").value.trim();
  if (!text || !taskRecipient) return;
  saveTasks([{id: crypto.randomUUID(), recipient: taskRecipient, text, hasVoice: Boolean(voiceUrl), status: "new", createdAt: new Date().toISOString()}, ...tasks]);
  feedback = `Задача для ${taskRecipient} добавлена в очередь.${voiceUrl ? " Голосовое прикреплено в текущем рабочем месте." : ""}`;
  taskDialog.close();
  render();
});
document.querySelector("#review-form").addEventListener("submit", event => {
  event.preventDefault();
  try {
    save(operations.map((row, index) => index === selected
      ? {...row, category: category.value, score: null, status: "confirmed", source: "Подтверждено бухгалтером", reason: "Категория подтверждена бухгалтером."}
      : row));
  } catch {
    document.querySelector("#review-error").textContent = "Браузер не смог сохранить решение.";
    return;
  }
  dialog.close();
  feedback = "Решение сохранено.";
  render();
  (screen.querySelector(`[data-review="${selected}"]`) || screen.querySelector('[data-filter="queue"]')).focus();
});

window.addEventListener("hashchange", () => {
  if (dialog.open) dialog.close();
  render();
  screen.focus();
});
window.addEventListener("opora-auth", event => {
  signedInUser = event.detail.user;
  authError = event.detail.error || "";
  renderAccount();
});
render();
refreshConnectionStatus();
