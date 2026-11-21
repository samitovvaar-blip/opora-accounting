"use strict";

const screen = document.querySelector("#screen");
const dialog = document.querySelector("#review");
const category = document.querySelector("#category");
const storageKey = "opora-accounting:bank:v1";
const amounts = new Intl.NumberFormat("ru-RU", {style: "currency", currency: "RUB"});
const dates = new Intl.DateTimeFormat("ru-RU", {timeZone: "UTC"});
let operations = [];
let filter = "all";
let selected = null;
let feedback = "";

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(stored)) operations = stored;
} catch {
  feedback = "Не удалось прочитать сохранённые операции.";
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

function nonBank(page) {
  const counts = stats();
  return `
    <div class="breadcrumb">Рабочее пространство</div>
    <header class="hero">
      <div><h1>${page === "team" ? "ИИ-сотрудники" : "ОПОРА Бухгалтерия"}</h1>
      <p>${page === "team" ? "Цифровые сотрудники бухгалтерии" : "Рабочее пространство для бухгалтеров"}</p></div>
    </header>
    <section class="card employee">
      <span class="avatar" aria-hidden="true">Н</span>
      <div><h2>Нейла</h2><p>ИИ-бухгалтер по банку</p>
      <p class="muted">${operations.length ? `Операций в очереди: ${counts.review + counts.unknown}` : "Импорт выписок и проверка банковских операций"}</p></div>
      <a class="button" href="#bank">Открыть рабочее место</a>
    </section>`;
}

function operationTable(rows) {
  if (!rows.length) return `<div class="empty"><strong>${operations.length ? "В этой очереди пока пусто" : "Выписок пока нет"}</strong><p>${operations.length ? "Все загруженные записи доступны во вкладке «Все операции»." : "Загрузите банковскую выписку или попробуйте демонстрационный файл."}</p></div>`;
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Список банковских операций"><table>
    <thead><tr><th scope="col">Дата</th><th scope="col">Контрагент и назначение</th><th scope="col">Сумма</th><th scope="col">Категория</th><th scope="col">Статус</th><th scope="col"><span class="sr-only">Действие</span></th></tr></thead>
    <tbody>${rows.map(({row, index}) => `<tr>
      <td class="nowrap">${formatDate(row.date)}</td>
      <td><strong>${escapeHtml(row.counterparty || "Контрагент не указан")}</strong><small>${escapeHtml(row.purpose || "Назначение не указано")}</small></td>
      <td class="nowrap amount ${row.direction}">${amount(row)}</td>
      <td>${escapeHtml(row.category || "—")}${row.score === null ? "" : `<small>Уверенность ${row.score}%</small>`}</td>
      <td>${badge(row.status)}</td>
      <td><button class="secondary" data-review="${index}">${["review", "unknown"].includes(row.status) ? "Разобрать" : "Открыть"}</button></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function bankPage() {
  const counts = stats();
  const queueSize = counts.review + counts.unknown;
  const rate = operations.length ? `${new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1}).format(counts.auto / operations.length * 100)}%` : "—";
  const pending = row => ["review", "unknown"].includes(row.status);
  const rows = operations.map((row, index) => ({row, index}))
    .filter(({row}) => filter === "all" || pending(row))
    .sort((a, b) => b.row.date.localeCompare(a.row.date));
  const metrics = [["Всего операций", operations.length], ["Распознано автоматически", counts.auto], ["В очереди на проверку", queueSize], ["Доля автораспознавания", rate]];
  return `
    <div class="breadcrumb"><a href="#team">ИИ-сотрудники</a><span aria-hidden="true">/</span> Банк</div>
    <header class="hero">
      <div class="profile"><span class="avatar" aria-hidden="true">Н</span><div><h1>Нейла</h1><p>ИИ-бухгалтер по банку</p></div></div>
      <button id="upload">+ Загрузить выписку</button>
      <input type="file" id="file" accept=".txt,.csv" hidden aria-label="Файл банковской выписки">
    </header>
    <div class="import-info"><span>CSV по образцу или TXT в формате 1С</span><a href="examples/vypiska.csv" download>Скачать образец CSV</a><button class="text-button" id="demo">Открыть демо</button></div>
    <p class="feedback" role="status">${escapeHtml(feedback)}</p>
    <section class="metrics" aria-label="Итоги обработки">${metrics.map(([label, value]) => `<div class="card metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}</section>
    <section class="card ledger" aria-labelledby="ledger-title">
      <div class="ledger-heading"><h2 id="ledger-title">Банковские операции</h2>
        <div class="filters" aria-label="Фильтр операций">
          <button class="secondary" aria-pressed="${filter === "all"}" data-filter="all">Все операции</button>
          <button class="secondary" aria-pressed="${filter === "queue"}" data-filter="queue">На проверку · ${queueSize}</button>
        </div>
      </div>
      ${operationTable(rows)}
    </section>`;
}

function render() {
  const page = ["team", "bank"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  document.querySelectorAll("nav a").forEach(link => {
    if (link.hash === `#${page}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  screen.innerHTML = page === "bank" ? bankPage() : nonBank(page);
}

async function importStatement(read) {
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
    }).map(Bank.classify);
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

screen.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "upload") screen.querySelector("#file").click();
  if (button.id === "demo") importStatement(async () => {
    const response = await fetch("examples/vypiska.csv");
    if (!response.ok) throw new Error("Демонстрационный файл недоступен.");
    return response.arrayBuffer();
  });
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    render();
    screen.querySelector(`[data-filter="${filter}"]`).focus();
  }
  if (button.dataset.review !== undefined) openItem(Number(button.dataset.review));
});

screen.addEventListener("change", event => {
  const file = event.target.id === "file" && event.target.files[0];
  if (!file) return;
  importStatement(() => {
    if (file.size > 10 * 1024 * 1024) throw new Error("Максимальный размер файла — 10 МБ.");
    return file.arrayBuffer();
  });
});

document.querySelector("#close").addEventListener("click", () => dialog.close());
document.querySelector("#review-form").addEventListener("submit", event => {
  event.preventDefault();
  try {
    save(operations.map((row, index) => index === selected
      ? {...row, category: category.value, score: null, status: "confirmed", reason: "Категория подтверждена бухгалтером."}
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
render();
