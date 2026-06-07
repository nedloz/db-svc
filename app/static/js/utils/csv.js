// Vanilla CSV-парсер для предпросмотра импорта. Без DOM, без fetch.
// Поддерживает базовый RFC 4180: кавычки, экранированные двойными кавычками,
// переносы строк внутри кавычек, CR/LF.
//
// Не цель — заменить серверный парсер; на бэке всё равно COPY FROM STDIN.
// Это только превью, чтобы пользователь увидел, ЧТО он заливает.

export function parseCsv(text, { delimiter = ',', maxRows = Infinity } = {}) {
  if (!text) return { headers: [], rows: [], truncated: false };

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // maxRows = максимум DATA-строк; всегда выходим после header + maxRows.
  const stopAt = Number.isFinite(maxRows) ? maxRows + 1 : Infinity;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') {
      row.push(field); rows.push(row);
      row = []; field = ''; i++;
      if (rows.length >= stopAt) break;
      continue;
    }
    if (ch === '\r') { i++; continue; }
    field += ch; i++;
  }
  if (i >= n && (field !== '' || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }

  const truncated = i < n;
  const headers = rows.length ? rows[0] : [];
  const dataRows = rows.slice(1);
  return { headers, rows: dataRows, truncated };
}

// Грубая оценка количества строк по \n. Не корректна для CSV с переносами
// внутри кавычек, но для приблизительного счётчика «в файле ≈ N строк»
// этого достаточно. Финальное число вставленных вернёт бэк (когда сможет).
export function countCsvLines(text) {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++;
  // Если последняя строка без trailing \n — учитываем её отдельно.
  if (text[text.length - 1] !== '\n') count++;
  return count;
}

// Сравнение headers CSV ↔ колонок таблицы.
// Возвращает: missingInCsv, extraInCsv, orderMismatch, intersection.
export function compareColumns(csvHeaders, tableColumns) {
  const tableNames = tableColumns.map((c) => c.name);
  const csvSet = new Set(csvHeaders);
  const tableSet = new Set(tableNames);

  const missingInCsv = tableNames.filter((c) => !csvSet.has(c));
  const extraInCsv   = csvHeaders.filter((c) => !tableSet.has(c));
  const intersection = csvHeaders.filter((c) => tableSet.has(c));

  // Проверяем порядок только по пересечению (extra/missing уже выявлены).
  const tableIntersection = tableNames.filter((c) => csvSet.has(c));
  let orderMismatch = false;
  for (let i = 0; i < intersection.length; i++) {
    if (intersection[i] !== tableIntersection[i]) { orderMismatch = true; break; }
  }
  return { missingInCsv, extraInCsv, orderMismatch, intersection };
}

// Преварительная проверка типов: пробегает первые N строк превью, для каждого
// (имя колонки → значение) смотрит тип целевой колонки в таблице и пытается
// сконвертировать. Возвращает массив проблем: {column, type, samples: [...], expected: '...'}
//
// Идея — отловить очевидные несовпадения до отправки на бэк, чтобы пользователь
// не ловил `22P02 invalid input syntax for type uuid` 78 раз подряд.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCsvTypes(csvHeaders, csvRows, tableColumns, { sampleRows = 5 } = {}) {
  const colByName = new Map(tableColumns.map((c) => [c.name, c]));
  const problems = [];

  for (let h = 0; h < csvHeaders.length; h++) {
    const header = csvHeaders[h];
    const col = colByName.get(header);
    if (!col) continue;                       // лишняя колонка — это другая проверка
    const type = String(col.type || '').toLowerCase();
    const samples = [];
    let badCount = 0;

    for (let r = 0; r < Math.min(csvRows.length, sampleRows); r++) {
      const raw = csvRows[r]?.[h];
      if (raw == null || raw === '') continue; // пустое значение — пусть бэк решает (NOT NULL он сам поймает)
      if (!isValueCompatible(raw, type)) {
        badCount++;
        if (samples.length < 3) samples.push(raw);
      }
    }

    if (badCount > 0) {
      problems.push({
        column: header,
        type: col.type,
        samples,
        hint: hintFor(type),
      });
    }
  }
  return problems;
}

function isValueCompatible(raw, type) {
  if (type === 'uuid') return UUID_RE.test(String(raw).trim());
  if (type.includes('int') || type === 'numeric' || type === 'decimal' || type.includes('serial')
      || type === 'real' || type === 'double precision' || type === 'money') {
    return Number.isFinite(Number(raw));
  }
  if (type === 'boolean') {
    const s = String(raw).trim().toLowerCase();
    return ['true','false','t','f','0','1','yes','no','y','n'].includes(s);
  }
  if (type.startsWith('timestamp') || type === 'date' || type.startsWith('time')) {
    const d = new Date(raw);
    return !Number.isNaN(d.getTime());
  }
  if (type === 'json' || type === 'jsonb') {
    try { JSON.parse(raw); return true; } catch { return false; }
  }
  // Для text / varchar / character / citext / user-defined (enum) и т.п. — не валидируем.
  return true;
}

function hintFor(type) {
  if (type === 'uuid')
    return 'Колонка ожидает UUID (например, "3ea3899a-783d-48c8-8ff2-eb..."). ' +
           'Если в CSV целые auto-id из Excel — удали колонку (Postgres сгенерирует UUID сам через DEFAULT) ' +
           'или используй «Связанный импорт» — он сам делает UUID-ремаппинг.';
  if (type === 'boolean')
    return 'Колонка ожидает boolean (true/false/t/f/0/1/yes/no).';
  if (type === 'json' || type === 'jsonb')
    return 'Колонка ожидает валидный JSON.';
  if (type.startsWith('timestamp') || type === 'date' || type.startsWith('time'))
    return 'Колонка ожидает дату/время в ISO-формате (например, "2025-05-23T17:25:00Z").';
  return `Колонка ожидает ${type}.`;
}

// Синтез CSV из JS-массивов: header по columns, далее строки.
// Используется M10 (export) и для возможных fallback'ов.
// Экранирование: если ячейка содержит delimiter / quote / \n / \r — оборачиваем
// в кавычки, внутренние кавычки удваиваем. NULL → пустая строка. Объекты /
// массивы → JSON.stringify (без обёртки в строку — экранируем тем же правилом).
export function rowsToCsv(rows, columns, { delimiter = ',' } = {}) {
  const keys = columns.map((c) => c.name || c.key || String(c));
  const lines = [keys.map((k) => escapeCell(k, delimiter)).join(delimiter)];
  for (const row of rows) {
    const line = keys.map((k) => escapeCell(formatExportValue(row?.[k]), delimiter)).join(delimiter);
    lines.push(line);
  }
  return lines.join('\r\n');
}

function formatExportValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

function escapeCell(str, delimiter) {
  const s = String(str);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Чтение файла как текст в указанной кодировке через FileReader.
// Если нужен только превью — заранее .slice(0, N) до вызова.
export function readFileAsText(file, encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
    try {
      reader.readAsText(file, encoding);
    } catch (err) {
      reject(err);
    }
  });
}
