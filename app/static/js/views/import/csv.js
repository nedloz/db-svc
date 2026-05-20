// CSV-импорт в существующую таблицу (M7). Идёт сразу на реальный бэк
// `POST /api/db/import/csv`, мока нет.
//
// Что делает фронт:
//  1) показывает превью первых 20 строк (vanilla parseCsv);
//  2) сверяет header CSV с колонками таблицы (`getColumns`);
//  3) блокирует «Импортировать», пока операция активна (M4);
//  4) выводит структурированный результат с client-side elapsed.
//
// Чего бэк ещё не отдаёт: количество вставленных строк, per-line ошибки —
// см. PROBLEMS.md → P-007.

import { createStore } from '../../state/store.js';
import { createInput, createSelect, createField } from '../../components/form-controls.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { toast } from '../../components/toast.js';
import { getSchemas, getTables, getColumns, importCsv } from '../../api/db.js';
import { parseCsv, countCsvLines, compareColumns, readFileAsText } from '../../utils/csv.js';

const PREVIEW_BYTES = 64 * 1024;   // первые 64 КБ для превью
const PREVIEW_ROWS = 20;
const ENCODINGS = ['utf-8', 'windows-1251', 'cp1251', 'utf-16', 'latin1'];

export function mountCsvImport(container) {
  const store = createStore({
    schemas: [],
    tables: {},                  // schema -> string[]
    selectedSchema: '',
    selectedTable: '',
    columns: [],
    mode: 'append',              // 'append' | 'replace'
    delimiter: ',',
    encoding: 'utf-8',
    file: null,
    preview: null,               // { headers, rows, truncated, approxTotal }
    previewError: null,
    busy: false,
    result: null,                // { ok, payload, elapsedMs, filename }
    error: null,                 // ApiError | Error
    loading: { schemas: false, tables: false, columns: false, preview: false },
  });

  const root = document.createElement('div');
  root.className = 'csv-import';
  container.replaceChildren(root);

  const unsubscribe = store.subscribe(render);
  loadSchemas();
  render();

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildForm(s));
    if (s.previewError) root.append(buildPreviewError(s.previewError));
    if (s.preview) root.append(buildPreview(s));
    if (s.preview && s.columns.length) root.append(buildComparison(s));
    root.append(buildActions(s));
    if (s.error) root.append(createErrorView(s.error));
    if (s.result) root.append(buildResult(s.result));
  }

  // ----- data loading -----

  function loadSchemas() {
    patchLoading('schemas', true);
    getSchemas({ trackAs: 'Импорт CSV: схемы' })
      .then((schemas) => store.set({ schemas, loading: { ...store.get().loading, schemas: false } }))
      .catch((err) => {
        patchLoading('schemas', false);
        store.set({ error: err });
      });
  }

  function loadTables(schema) {
    if (store.get().tables[schema]) return;
    patchLoading('tables', true);
    getTables(schema, { trackAs: `Импорт CSV: таблицы ${schema}` })
      .then((list) => {
        const cur = store.get();
        store.set({ tables: { ...cur.tables, [schema]: list }, loading: { ...cur.loading, tables: false } });
      })
      .catch((err) => { patchLoading('tables', false); store.set({ error: err }); });
  }

  function loadColumns(schema, table) {
    patchLoading('columns', true);
    getColumns(schema, table, { trackAs: `Импорт CSV: колонки ${schema}.${table}` })
      .then((columns) => store.set({ columns, loading: { ...store.get().loading, columns: false } }))
      .catch((err) => { patchLoading('columns', false); store.set({ error: err, columns: [] }); });
  }

  // ----- form events -----

  function onSchemaChange(schema) {
    store.set({ selectedSchema: schema, selectedTable: '', columns: [], result: null });
    if (schema) loadTables(schema);
  }
  function onTableChange(table) {
    const { selectedSchema } = store.get();
    store.set({ selectedTable: table, columns: [], result: null });
    if (selectedSchema && table) loadColumns(selectedSchema, table);
  }
  function onModeChange(mode)           { store.set({ mode, result: null }); }
  function onDelimiterChange(delimiter) { store.set({ delimiter, result: null }); refreshPreview(); }
  function onEncodingChange(encoding)   { store.set({ encoding, result: null }); refreshPreview(); }

  function onFileChange(file) {
    store.set({ file, preview: null, previewError: null, result: null });
    if (file) refreshPreview();
  }

  async function refreshPreview() {
    const { file, delimiter, encoding } = store.get();
    if (!file) return;
    patchLoading('preview', true);
    try {
      const slice = file.size > PREVIEW_BYTES ? file.slice(0, PREVIEW_BYTES) : file;
      const text = await readFileAsText(slice, encoding);
      const { headers, rows, truncated } = parseCsv(text, { delimiter, maxRows: PREVIEW_ROWS });
      const approxTotal = file.size > PREVIEW_BYTES ? null : countCsvLines(text) - (headers.length ? 1 : 0);
      store.set({
        preview: { headers, rows, truncated: truncated || file.size > PREVIEW_BYTES, approxTotal },
        previewError: null,
        loading: { ...store.get().loading, preview: false },
      });
    } catch (err) {
      store.set({
        preview: null,
        previewError: err?.message || 'Не удалось прочитать файл',
        loading: { ...store.get().loading, preview: false },
      });
    }
  }

  // ----- submit -----

  async function submit() {
    const { selectedSchema, selectedTable, file, mode, delimiter, encoding, busy } = store.get();
    if (busy) return;
    if (!selectedSchema || !selectedTable) { toast.warn('Выберите схему и таблицу'); return; }
    if (!file) { toast.warn('Выберите CSV-файл'); return; }
    if (delimiter.length !== 1) { toast.warn('Разделитель должен быть одним символом'); return; }

    store.set({ busy: true, result: null, error: null });
    const startedAt = performance.now();
    try {
      const payload = await importCsv(
        { schema: selectedSchema, table: selectedTable, file, mode, delimiter, encoding },
        { trackAs: `CSV-импорт в ${selectedSchema}.${selectedTable}` },
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      store.set({
        busy: false,
        result: { ok: true, payload, elapsedMs, filename: file.name, size: file.size },
      });
      toast.success(`CSV-импорт завершён за ${(elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      store.set({
        busy: false,
        result: { ok: false, payload: err?.payload || null, elapsedMs, filename: file.name, size: file.size },
        error: err,
      });
    }
  }

  function patchLoading(key, value) {
    store.set({ loading: { ...store.get().loading, [key]: value } });
  }

  return () => unsubscribe();

  // ===== builders =====

  function buildForm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'csv-import__form';

    const schemaSelect = createSelect({
      value: s.selectedSchema,
      options: [{ value: '', label: '— выберите схему —' }, ...s.schemas.map((sc) => ({ value: sc, label: sc }))],
      onChange: onSchemaChange,
    });
    wrap.append(createField({ label: 'Схема', control: schemaSelect }));

    const tableList = s.tables[s.selectedSchema] || [];
    const tableSelect = createSelect({
      value: s.selectedTable,
      options: [{ value: '', label: s.loading.tables ? 'Загружаю…' : '— выберите таблицу —' }, ...tableList.map((t) => ({ value: t, label: t }))],
      onChange: onTableChange,
    });
    if (!s.selectedSchema) tableSelect.disabled = true;
    wrap.append(createField({ label: 'Таблица', control: tableSelect }));

    const modeWrap = document.createElement('span');
    modeWrap.className = 'csv-import__mode';
    for (const m of ['append', 'replace']) {
      const lbl = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = 'csv-mode'; r.value = m; r.checked = s.mode === m;
      r.addEventListener('change', () => onModeChange(m));
      const sp = document.createElement('span'); sp.textContent = ` ${m}`;
      lbl.append(r, sp);
      modeWrap.append(lbl);
    }
    wrap.append(createField({ label: 'Режим', control: modeWrap }));

    if (s.mode === 'replace') {
      const warn = document.createElement('div');
      warn.className = 'csv-import__warning';
      warn.textContent = '⚠ replace = TRUNCATE TABLE перед COPY. Это уничтожит ВСЕ текущие строки в таблице.';
      wrap.append(warn);
    }

    const delimInput = createInput({ value: s.delimiter, onInput: onDelimiterChange });
    delimInput.maxLength = 1;
    wrap.append(createField({ label: 'Разделитель (1 символ)', control: delimInput }));

    const encSelect = createSelect({
      value: s.encoding, options: ENCODINGS, onChange: onEncodingChange,
    });
    wrap.append(createField({ label: 'Кодировка', control: encSelect }));

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.csv,text/csv';
    fileInput.className = 'csv-import__file';
    fileInput.addEventListener('change', (e) => onFileChange(e.target.files[0] || null));
    wrap.append(createField({ label: 'CSV-файл', control: fileInput }));

    if (s.file) {
      const fileInfo = document.createElement('div');
      fileInfo.className = 'csv-import__file-info';
      fileInfo.textContent = `${s.file.name} · ${formatBytes(s.file.size)}`;
      wrap.append(fileInfo);
    }
    return wrap;
  }

  function buildPreviewError(message) {
    const el = document.createElement('div');
    el.className = 'csv-import__preview-error';
    el.textContent = `Ошибка чтения файла: ${message}`;
    return el;
  }

  function buildPreview(s) {
    const wrap = document.createElement('div');
    wrap.className = 'csv-import__preview';
    if (s.loading.preview) { wrap.append(createLoader({ label: 'Парсю файл…' })); return wrap; }

    const head = document.createElement('div');
    head.className = 'csv-import__preview-head';
    const total = s.preview.approxTotal != null
      ? `≈ ${s.preview.approxTotal} строк (по \\n в полном файле)`
      : `> ${PREVIEW_ROWS} строк (превью обрезано до первых ${PREVIEW_BYTES / 1024} КБ)`;
    head.textContent = `Превью первых ${s.preview.rows.length} строк · ${total}`;
    wrap.append(head);

    const table = document.createElement('table');
    table.className = 'csv-import__preview-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const h of s.preview.headers) {
      const th = document.createElement('th'); th.textContent = h; headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of s.preview.rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td'); td.textContent = cell; tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);

    if (s.preview.truncated) {
      const more = document.createElement('div');
      more.className = 'csv-import__preview-more';
      more.textContent = 'Дальше есть ещё строки — здесь не показаны.';
      wrap.append(more);
    }
    return wrap;
  }

  function buildComparison(s) {
    const wrap = document.createElement('div');
    wrap.className = 'csv-import__comparison';
    const cmp = compareColumns(s.preview.headers, s.columns);

    const summary = document.createElement('div');
    summary.className = 'csv-import__comparison-summary';
    summary.textContent =
      `CSV header: ${s.preview.headers.length} · Колонок в таблице: ${s.columns.length} · ` +
      `Совпало: ${cmp.intersection.length}`;
    wrap.append(summary);

    if (cmp.missingInCsv.length) wrap.append(buildBadgeList(
      `Колонки таблицы, которых НЕТ в CSV (${cmp.missingInCsv.length}):`,
      cmp.missingInCsv, 'csv-import__cmp-missing',
      'Бэк ожидает HEADER, совпадающий с колонками таблицы. COPY запишет NULL только если колонка nullable.',
    ));
    if (cmp.extraInCsv.length) wrap.append(buildBadgeList(
      `Колонки CSV, которых НЕТ в таблице (${cmp.extraInCsv.length}):`,
      cmp.extraInCsv, 'csv-import__cmp-extra',
      'Эти колонки бэк не примет — COPY упадёт. Удалите их из CSV или переименуйте.',
    ));
    if (cmp.orderMismatch) {
      const o = document.createElement('div');
      o.className = 'csv-import__cmp-order';
      o.textContent = '⚠ Порядок CSV-колонок не совпадает с порядком в таблице. ' +
        'Текущий бэк COPY полагается на порядок header — данные уедут в неправильные поля.';
      wrap.append(o);
    }
    if (!cmp.missingInCsv.length && !cmp.extraInCsv.length && !cmp.orderMismatch) {
      const ok = document.createElement('div');
      ok.className = 'csv-import__cmp-ok';
      ok.textContent = '✓ Колонки совпадают с таблицей, порядок верный.';
      wrap.append(ok);
    }
    return wrap;
  }

  function buildBadgeList(title, items, className, hint) {
    const wrap = document.createElement('div');
    wrap.className = className;
    const t = document.createElement('div'); t.className = `${className}-title`; t.textContent = title;
    const list = document.createElement('div'); list.className = `${className}-items`;
    for (const it of items) {
      const b = document.createElement('span'); b.className = `${className}-badge`; b.textContent = it;
      list.append(b);
    }
    const h = document.createElement('div'); h.className = `${className}-hint`; h.textContent = hint;
    wrap.append(t, list, h);
    return wrap;
  }

  function buildActions(s) {
    const wrap = document.createElement('div');
    wrap.className = 'csv-import__actions';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary csv-import__submit';
    btn.textContent = s.busy ? 'Импорт идёт…' : 'Импортировать';
    btn.disabled = s.busy || !s.selectedSchema || !s.selectedTable || !s.file;
    btn.addEventListener('click', submit);
    wrap.append(btn);

    if (s.busy) {
      const hint = document.createElement('span');
      hint.className = 'csv-import__busy-hint';
      hint.textContent = 'Прогресс блокирующего импорта пока не отдаётся бэком (P-006). ' +
        'Отмена возможна в индикаторе операций в шапке — она прервёт соединение, но бэк допишет начатое.';
      wrap.append(hint);
    }
    return wrap;
  }

  function buildResult(r) {
    const wrap = document.createElement('div');
    wrap.className = `csv-import__result csv-import__result--${r.ok ? 'ok' : 'fail'}`;
    const head = document.createElement('div');
    head.className = 'csv-import__result-head';
    head.textContent = r.ok ? '✓ Импорт завершён' : '✗ Импорт упал';
    wrap.append(head);

    const dl = document.createElement('dl');
    dl.className = 'csv-import__result-list';
    addPair(dl, 'Файл',     r.filename);
    addPair(dl, 'Размер',   formatBytes(r.size));
    addPair(dl, 'Длилось',  `${(r.elapsedMs / 1000).toFixed(2)} s`);
    if (r.payload && typeof r.payload === 'object') {
      for (const [k, v] of Object.entries(r.payload)) addPair(dl, k, formatVal(v));
    }
    wrap.append(dl);

    if (!r.ok) {
      const hint = document.createElement('div');
      hint.className = 'csv-import__result-hint';
      hint.textContent = 'Подробное сообщение бэка — выше, в блоке «Ошибка».';
      wrap.append(hint);
    } else {
      const note = document.createElement('div');
      note.className = 'csv-import__result-note';
      note.textContent = 'Бэк пока не возвращает количество вставленных строк и список ' +
        'построчных ошибок — см. PROBLEMS.md → P-007. Финальная проверка — заглянуть на ' +
        'вкладку «База данных» в эту же таблицу.';
      wrap.append(note);
    }
    return wrap;
  }
}

function addPair(dl, label, value) {
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value == null ? '—' : String(value);
  dl.append(dt, dd);
}

function formatVal(v) {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ`;
}
