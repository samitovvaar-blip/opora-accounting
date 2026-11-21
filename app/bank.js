"use strict";

const Bank = (() => {
  const rules = [
    ["Комиссия банка", "out", /комисси/i, 96],
    ["Страховые взносы", "out", /страхов.{0,5} взнос/i, 95],
    ["Налоги", "out", /(?:единый налоговый плат[её]ж|налог на|уплата налога)/i, 95],
    ["Зарплата", "out", /заработн.{0,5} плат|зарплат/i, 95],
    ["Аренда", "out", /аренд/i, 83],
    ["Подотчёт", "out", /подотч[её]т/i, 83],
    ["Дивиденды", "out", /дивиденд/i, 83],
    ["Возврат покупателю", "out", /возврат/i, 66],
    ["Возврат от поставщика", "in", /возврат/i, 66],
    ["Эквайринг", "in", /эквайринг/i, 82],
    ["Аванс поставщику", "out", /аванс|предоплат/i, 78],
    ["Аванс покупателя", "in", /аванс|предоплат/i, 78],
    ["Оплата поставщику", "out", /оплат|по сч[её]ту/i, 74],
    ["Оплата от покупателя", "in", /оплат|по сч[её]ту/i, 74],
  ];
  const categories = [...new Set([...rules.map(rule => rule[0]), "Перевод между своими счетами", "Получение займа", "Погашение займа или кредита", "Проценты", "Прочие поступления", "Прочие расходы"])];
  const status = {auto: "Распознано", review: "На проверке", unknown: "Не определено", confirmed: "Подтверждено"};

  function classify(operation) {
    const matches = rules.filter(([, direction, pattern]) => direction === operation.direction && pattern.test(operation.purpose));
    // General payment language often appears alongside a more specific category.
    const specific = matches.filter(([name]) => !name.startsWith("Оплата "));
    const candidates = specific.length ? specific : matches;
    if (!candidates.length) return {...operation, category: "", score: null, status: "unknown", reason: "В назначении платежа нет признаков знакомой категории."};
    const [category, , , confidence] = candidates[0];
    const score = candidates.length === 1 ? confidence : Math.min(70, confidence);
    const reason = candidates.length === 1
      ? "Категория предложена по назначению и направлению платежа."
      : "В назначении найдены признаки нескольких категорий.";
    return {...operation, category, score, reason, status: score >= 90 ? "auto" : "review"};
  }

  function csvRows(text) {
    const rows = [];
    let row = [], field = "", quoted = false, closed = false;
    for (let index = 0; index < text.length; index++) {
      const ch = text[index];
      if (quoted) {
        if (ch === '"' && text[index + 1] === '"') {
          field += '"';
          index++;
        } else if (ch === '"') {
          quoted = false;
          closed = true;
        } else field += ch;
      } else if (ch === '"' && field === "" && !closed) {
        quoted = true;
      } else if (ch === ";" || ch === "\r" || ch === "\n") {
        row.push(field.trim());
        field = "";
        closed = false;
        if (ch !== ";") {
          if (row.some(Boolean)) rows.push(row);
          row = [];
          if (ch === "\r" && text[index + 1] === "\n") index++;
        }
      } else if (closed || ch === '"') {
        throw new Error("Проверьте кавычки в CSV.");
      } else field += ch;
    }
    if (quoted) throw new Error("В CSV есть незакрытая кавычка.");
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function normalize(date, amount, direction, counterparty, purpose, reference = "") {
    const iso = date.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, "$3-$2-$1");
    const parsed = new Date(iso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== iso) {
      throw new Error("Некорректная дата.");
    }
    const value = amount.replace(/[\s\u00a0]/g, "").replace(",", ".");
    const kopecks = Math.round(Number(value) * 100);
    if (!/^\d+(\.\d{1,2})?$/.test(value) || kopecks <= 0 || !Number.isSafeInteger(kopecks)) throw new Error("Некорректная сумма.");
    if (!["in", "out"].includes(direction)) throw new Error("Укажите приход или расход.");
    return {date: iso, kopecks, direction, counterparty, purpose, reference};
  }

  function parseCSV(text) {
    const [header, ...rows] = csvRows(text);
    const expected = ["Дата", "Сумма", "Направление", "Контрагент", "Назначение", "Номер"];
    if (!header || ![5, 6].includes(header.length) || header.some((name, index) => name !== expected[index])) {
      throw new Error("Заголовки CSV должны совпадать с образцом.");
    }
    return rows.map(([date, amount, direction, party, purpose, number], index) => {
      try {
        if (rows[index].length !== header.length) throw new Error("Неверное число столбцов.");
        return normalize(date, amount, {приход: "in", расход: "out"}[direction.toLowerCase()], party, purpose, number);
      } catch (error) {
        throw new Error(`Операция ${index + 1} в CSV. ${error.message}`);
      }
    });
  }

  function parseClientBank(text) {
    const operations = [];
    let document = null;
    for (const line of text.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (line.startsWith("СекцияДокумент=")) {
        if (document) throw new Error("Один из документов выписки не закрыт.");
        document = Object.create(null);
      } else if (line.trim() === "КонецДокумента" && document) {
        const d = document;
        const incoming = Boolean(d.ДатаПоступило);
        if (incoming === Boolean(d.ДатаСписано)) throw new Error("Для документа требуется одна дата зачисления или списания.");
        const prefix = incoming ? "Плательщик" : "Получатель";
        const account = [d.ПлательщикСчет || d.ПлательщикРасчСчет, d.ПолучательСчет || d.ПолучательРасчСчет, d.Номер].join("|");
        operations.push(normalize(d.ДатаПоступило || d.ДатаСписано, d.Сумма || "", incoming ? "in" : "out",
          d[prefix + "1"] || d[prefix] || "", d.НазначениеПлатежа || "", account));
        document = null;
      } else if (document && separator > 0) {
        document[line.slice(0, separator)] = line.slice(separator + 1).trim();
      }
    }
    if (document || !/^КонецФайла\s*$/m.test(text)) throw new Error("Файл 1С заполнен не полностью.");
    return operations;
  }

  function parse(bytes) {
    let text;
    try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
    catch { text = new TextDecoder("windows-1251").decode(bytes); }
    text = text.trim();
    const rows = /^1CClientBankExchange(?:\r?\n|$)/.test(text) ? parseClientBank(text) : parseCSV(text);
    if (!rows.length) throw new Error("В выписке нет операций.");
    return rows;
  }

  return {parse, classify, categories, status};
})();
