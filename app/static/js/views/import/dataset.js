// Связанный импорт датасета (M8). Идёт сразу на реальный бэк
// `POST /api/db/import/dataset`, мока нет — UX полностью функционален.
//
// UX:
//  1) поля файлов генерируются из DATASET_FIELDS — один массив, добавление
//     нового поля = одна строчка (плюс правка бэка);
//  2) сначала «Dry-run» — бэк валидирует и подготавливает строки без INSERT;
//  3) «Применить» disabled до тех пор, пока последний dry-run не вернул ok=true
//     (и не были изменены файлы / флаги после этого);
//  4) отчёт — табы по уровням errors / warnings / info / inserts.

import { createStore } from '../../state/store.js';
import { createErrorView } from '../../components/error-view.js';
import { createFilePicker } from '../../components/form-controls.js';
import { toast } from '../../components/toast.js';
import { importDataset } from '../../api/db.js';
import { DATASET_FIELDS } from './dataset-mapping.js';

const TABS = ['errors', 'warnings', 'info', 'inserts'];

export function mountDatasetImport(container) {
  const store = createStore({
    files: {},                  // field -> File
    replaceMode: false,
    dryRun: true,
    busy: null,                 // null | 'dry-run' | 'apply'
    lastDryRun: null,           // {report, signature} — для разблокировки «Применить»
    report: null,               // последний отчёт от бэка (любой режим)
    reportKind: null,           // 'dry-run' | 'apply'
    error: null,
    activeTab: 'info',
  });

  const root = document.createElement('div');
  root.className = 'dataset-import';
  container.replaceChildren(root);

  const unsubscribe = store.subscribe(render);
  render();
  return () => unsubscribe();

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildBulkPicker(s));
    root.append(buildForm(s));
    root.append(buildOptions(s));
    const mismatch = buildMismatchWarning(s);
    if (mismatch) root.append(mismatch);
    root.append(buildActions(s));
    if (s.error) root.append(createErrorView(s.error));
    if (s.report) root.append(buildReport(s));
  }

  // ----- state mutators -----

  function setFile(field, file) {
    const next = { ...store.get().files };
    if (file) next[field] = file; else delete next[field];
    store.set({ files: next, lastDryRun: null, error: null });
  }
  function setReplace(v) { store.set({ replaceMode: !!v, lastDryRun: null }); }

  // Авто-распределение пачки файлов по полям на основе имени файла.
  function assignBulk(fileList) {
    if (!fileList || !fileList.length) return;
    const next = { ...store.get().files };
    const used = new Set();
    // Длинные ключи первыми (document_relations раньше documents), чтобы не перехватить.
    const fieldsByLen = [...DATASET_FIELDS].sort((a, b) => fieldKeyword(b).length - fieldKeyword(a).length);
    for (const file of fileList) {
      const norm = normalizeName(file.name);
      const match = fieldsByLen.find((f) => !used.has(f.field) && norm.includes(fieldKeyword(f)));
      if (match) { next[match.field] = file; used.add(match.field); }
    }
    store.set({ files: next, lastDryRun: null, error: null });
    const assigned = used.size;
    const skipped = fileList.length - assigned;
    if (assigned) toast.success(`Распределено: ${assigned}${skipped ? `, не распознано: ${skipped}` : ''}`);
    else toast.warn('Не удалось сопоставить файлы по имени — выберите вручную');
  }

  function buildMismatchWarning(s) {
    const bad = DATASET_FIELDS.filter((f) => s.files[f.field] && isLikelyMismatch(f, s.files[f.field]));
    if (!bad.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'dataset-import__warning';
    const head = document.createElement('div');
    head.textContent = `⚠ Похоже, ${bad.length} файл(ов) добавлены не в своё поле:`;
    wrap.append(head);
    const ul = document.createElement('ul');
    ul.className = 'dataset-import__mismatch-list';
    for (const f of bad) {
      const li = document.createElement('li');
      li.textContent = `${f.field}: «${s.files[f.field].name}» (ожидается ${f.defaultFilename})`;
      ul.append(li);
    }
    wrap.append(ul);
    const note = document.createElement('div');
    note.className = 'dataset-import__mismatch-note';
    note.textContent = 'Это предупреждение, не ошибка — можно импортировать, если файлы верные.';
    wrap.append(note);
    return wrap;
  }

  function currentSignature() {
    const { files, replaceMode } = store.get();
    const parts = [];
    for (const f of DATASET_FIELDS) {
      const file = files[f.field];
      parts.push(file ? `${f.field}:${file.name}:${file.size}:${file.lastModified}` : `${f.field}:-`);
    }
    parts.push(`replace=${replaceMode}`);
    return parts.join('|');
  }

  async function run(dryRunFlag) {
    const s = store.get();
    if (s.busy) return;
    const missing = DATASET_FIELDS.filter((f) => f.required && !s.files[f.field]);
    if (missing.length) {
      toast.warn(`Не выбраны файлы: ${missing.map((f) => f.field).join(', ')}`);
      return;
    }
    store.set({
      busy: dryRunFlag ? 'dry-run' : 'apply',
      report: null,
      reportKind: null,
      error: null,
    });
    const sigBefore = currentSignature();
    try {
      const report = await importDataset(
        { files: s.files, replaceMode: s.replaceMode, dryRun: dryRunFlag },
        { trackAs: dryRunFlag ? 'Dataset dry-run' : 'Связанный импорт' },
      );
      const next = {
        busy: null,
        report,
        reportKind: dryRunFlag ? 'dry-run' : 'apply',
        activeTab: pickInitialTab(report),
      };
      if (dryRunFlag && report?.ok) next.lastDryRun = { signature: sigBefore };
      if (!dryRunFlag) next.lastDryRun = null; // после реального импорта повторное «Применить» должно снова требовать dry-run
      store.set(next);
      if (dryRunFlag) toast[report?.ok ? 'success' : 'warn'](report?.ok ? 'Dry-run прошёл' : 'Dry-run нашёл ошибки');
      else toast[report?.ok ? 'success' : 'error'](report?.ok ? 'Импорт применён' : 'Импорт завершился с ошибками');
    } catch (err) {
      store.set({ busy: null, error: err, report: null, reportKind: null });
    }
  }

  // ----- builders -----

  // Импорт одной кнопкой: выбрать сразу все CSV — авто-распределяем по полям
  // на основе имени файла. Поля можно поправить вручную ниже.
  function buildBulkPicker(s) {
    const wrap = document.createElement('div');
    wrap.className = 'dataset-import__bulk';

    const picker = createFilePicker({
      accept: '.csv,text/csv',
      multiple: true,
      label: 'Выбрать все файлы сразу',
      onChange: (fileList) => assignBulk(fileList),
    });
    const hint = document.createElement('span');
    hint.className = 'dataset-import__bulk-hint';
    hint.textContent = 'Распределим по полям автоматически по имени файла. Поля ниже можно поправить вручную.';
    wrap.append(picker, hint);
    return wrap;
  }

  function buildForm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'dataset-import__form';

    const head = document.createElement('div');
    head.className = 'dataset-import__form-head';
    head.textContent =
      `Файлов: ${Object.keys(s.files).length} из ${DATASET_FIELDS.length}. ` +
      `Бэк примет ровно ${DATASET_FIELDS.length} полей — недостающие приведут к 422.`;
    wrap.append(head);

    const list = document.createElement('div');
    list.className = 'dataset-import__fields';
    for (const f of DATASET_FIELDS) list.append(buildFieldRow(f, s.files[f.field]));
    wrap.append(list);
    return wrap;
  }

  function buildFieldRow(spec, file) {
    const row = document.createElement('div');
    row.className = 'dataset-import__field';

    const label = document.createElement('div');
    label.className = 'dataset-import__field-label';
    const fieldName = document.createElement('span'); fieldName.className = 'dataset-import__field-name';
    fieldName.textContent = spec.field;
    const target = document.createElement('span'); target.className = 'dataset-import__field-target';
    target.textContent = ` → ${spec.schema}.${spec.table}`;
    const expected = document.createElement('span'); expected.className = 'dataset-import__field-expected';
    expected.textContent = ` · ожидается: ${spec.defaultFilename}`;
    label.append(fieldName, target, expected);
    row.append(label);

    const picker = createFilePicker({
      accept: '.csv,text/csv',
      label: file ? 'Заменить' : 'Выберите файл',
      onChange: (f) => setFile(spec.field, f),
    });
    row.append(picker);

    if (file) {
      const info = document.createElement('span');
      info.className = 'dataset-import__field-fileinfo';
      info.textContent = `${file.name} · ${formatBytes(file.size)}`;
      row.append(info);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn--danger dataset-import__field-remove';
      removeBtn.textContent = 'Убрать';
      removeBtn.addEventListener('click', () => setFile(spec.field, null));
      row.append(removeBtn);

      // Предупреждение прямо в карточке поля, если файл похоже не тот.
      if (isLikelyMismatch(spec, file)) {
        const warn = document.createElement('span');
        warn.className = 'dataset-import__field-mismatch';
        warn.textContent = '⚠ возможно не тот файл';
        warn.title = `Имя файла «${file.name}» не похоже на ${spec.field}`;
        row.append(warn);
      }
    } else if (spec.required) {
      const need = document.createElement('span');
      need.className = 'dataset-import__field-required';
      need.textContent = '(обязательно)';
      row.append(need);
    }
    return row;
  }

  function buildOptions(s) {
    const wrap = document.createElement('div');
    wrap.className = 'dataset-import__options';

    const replaceLbl = document.createElement('label');
    const replaceCb = document.createElement('input');
    replaceCb.type = 'checkbox';
    replaceCb.checked = s.replaceMode;
    replaceCb.addEventListener('change', () => setReplace(replaceCb.checked));
    replaceLbl.append(replaceCb, document.createTextNode(' replace_mode (очистить целевые таблицы перед вставкой)'));
    wrap.append(replaceLbl);

    if (s.replaceMode) {
      const warn = document.createElement('div');
      warn.className = 'dataset-import__warning';
      warn.textContent = '⚠ replace_mode=true сначала очистит таблицы датасета. Все текущие строки в core.* / library.* (по списку выше) будут удалены до вставки.';
      wrap.append(warn);
    }
    return wrap;
  }

  function buildActions(s) {
    const wrap = document.createElement('div');
    wrap.className = 'dataset-import__actions';

    const dryBtn = document.createElement('button');
    dryBtn.type = 'button';
    dryBtn.className = 'btn dataset-import__dry';
    dryBtn.textContent = s.busy === 'dry-run' ? 'Dry-run идёт…' : 'Dry-run';
    dryBtn.disabled = !!s.busy;
    dryBtn.addEventListener('click', () => run(true));

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn--primary dataset-import__apply';
    applyBtn.textContent = s.busy === 'apply' ? 'Импорт идёт…' : 'Применить';
    const applyReady = s.lastDryRun && s.lastDryRun.signature === currentSignature();
    applyBtn.disabled = !!s.busy || !applyReady;
    applyBtn.title = applyReady
      ? 'Применить импорт (dry-run прошёл, файлы не менялись)'
      : 'Сначала Dry-run; если файлы / флаги изменятся — Dry-run придётся повторить';
    applyBtn.addEventListener('click', () => run(false));

    wrap.append(dryBtn, applyBtn);

    if (s.busy) {
      const hint = document.createElement('span');
      hint.className = 'dataset-import__busy-hint';
      hint.textContent = 'Бэк не отдаёт промежуточный прогресс (P-006). Отмена через operations-indicator прервёт соединение, но операция допишется.';
      wrap.append(hint);
    }
    return wrap;
  }

  function buildReport({ report, reportKind, activeTab }) {
    const wrap = document.createElement('div');
    wrap.className = `dataset-import__report dataset-import__report--${report.ok ? 'ok' : 'fail'}`;

    const head = document.createElement('div');
    head.className = 'dataset-import__report-head';
    const verdict = report.ok
      ? (reportKind === 'dry-run' ? '✓ Dry-run прошёл успешно' : '✓ Импорт применён')
      : (reportKind === 'dry-run' ? '✗ Dry-run нашёл ошибки' : '✗ Импорт упал');
    head.textContent = `${verdict} · dry_run=${report.dry_run}`;
    wrap.append(head);

    const counts = {
      errors: (report.errors || []).length,
      warnings: (report.warnings || []).length,
      info: Object.keys(report.counts_read || {}).length + (report.logs?.filter(isPlainLog).length || 0),
      inserts: Object.keys(report.inserted || {}).length,
    };

    const tabs = document.createElement('div');
    tabs.className = 'dataset-import__tabs';
    for (const t of TABS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `btn dataset-import__tab${activeTab === t ? ' dataset-import__tab--active' : ''}`;
      tab.textContent = `${tabLabel(t)} (${counts[t]})`;
      tab.addEventListener('click', () => store.set({ activeTab: t }));
      tabs.append(tab);
    }
    wrap.append(tabs);

    const body = document.createElement('div');
    body.className = 'dataset-import__tab-body';
    body.append(renderTab(activeTab, report));
    wrap.append(body);
    return wrap;
  }
}

// ===== helpers =====

function tabLabel(t) {
  switch (t) {
    case 'errors':   return 'Errors';
    case 'warnings': return 'Warnings';
    case 'info':     return 'Info';
    case 'inserts':  return 'Inserts';
    default:         return t;
  }
}

function pickInitialTab(report) {
  if ((report?.errors || []).length) return 'errors';
  if ((report?.warnings || []).length) return 'warnings';
  if (Object.keys(report?.inserted || {}).length) return 'inserts';
  return 'info';
}

function isPlainLog(line) {
  return typeof line === 'string' && !line.startsWith('WARN:') && !line.startsWith('ERROR:');
}

function renderTab(tab, report) {
  const wrap = document.createElement('div');
  wrap.className = `dataset-import__tab-content dataset-import__tab-content--${tab}`;

  if (tab === 'errors' || tab === 'warnings') {
    const items = report[tab] || [];
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = tab === 'errors' ? 'Ошибок нет.' : 'Предупреждений нет.';
      wrap.append(empty);
      return wrap;
    }
    const ul = document.createElement('ul');
    ul.className = `dataset-import__list dataset-import__list--${tab}`;
    for (const msg of items) {
      const li = document.createElement('li'); li.textContent = msg; ul.append(li);
    }
    wrap.append(ul);
    return wrap;
  }

  if (tab === 'info') {
    const filesSeen = report.files_seen || {};
    const read = report.counts_read || {};
    const prep = report.counts_prepared || {};
    const tableFields = [...new Set([...Object.keys(read), ...Object.keys(prep), ...Object.keys(filesSeen)])];
    if (tableFields.length) {
      const t = document.createElement('table');
      t.className = 'dataset-import__counts';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const h of ['field', 'файл', 'прочитано', 'подготовлено']) {
        const th = document.createElement('th'); th.textContent = h; hr.append(th);
      }
      thead.append(hr); t.append(thead);
      const tbody = document.createElement('tbody');
      for (const k of tableFields) {
        const tr = document.createElement('tr');
        addTd(tr, k);
        addTd(tr, filesSeen[k] || '—');
        addTd(tr, read[k] ?? '—');
        addTd(tr, prep[k] ?? '—');
        tbody.append(tr);
      }
      t.append(tbody);
      wrap.append(t);
    }
    const plainLogs = (report.logs || []).filter(isPlainLog);
    if (plainLogs.length) {
      const ul = document.createElement('ul');
      ul.className = 'dataset-import__list dataset-import__list--info';
      for (const line of plainLogs) {
        const li = document.createElement('li'); li.textContent = line; ul.append(li);
      }
      wrap.append(ul);
    }
    if (!tableFields.length && !plainLogs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Бэк не вернул информационных данных.';
      wrap.append(empty);
    }
    return wrap;
  }

  if (tab === 'inserts') {
    const ins = report.inserted || {};
    const keys = Object.keys(ins);
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = report.dry_run
        ? 'В dry-run строки не вставляются. Переключитесь на «Применить», чтобы получить реальные счётчики.'
        : 'Ничего не вставлено.';
      wrap.append(empty);
      return wrap;
    }
    const total = keys.reduce((a, k) => a + (ins[k] || 0), 0);
    const head = document.createElement('div');
    head.className = 'dataset-import__inserts-total';
    head.textContent = `Всего вставлено: ${total}`;
    wrap.append(head);

    const t = document.createElement('table');
    t.className = 'dataset-import__inserts';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['field', 'вставлено']) {
      const th = document.createElement('th'); th.textContent = h; hr.append(th);
    }
    thead.append(hr); t.append(thead);
    const tbody = document.createElement('tbody');
    for (const k of keys) {
      const tr = document.createElement('tr');
      addTd(tr, k);
      addTd(tr, ins[k]);
      tbody.append(tr);
    }
    t.append(tbody);
    wrap.append(t);
    return wrap;
  }

  return wrap;
}

function addTd(tr, value) {
  const td = document.createElement('td');
  td.textContent = value == null ? '—' : String(value);
  tr.append(td);
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ`;
}

// Имя файла → только латинские буквы в нижнем регистре (для матчинга).
// "core_ - universities (1).csv" → "coreuniversities"
function normalizeName(name) {
  return String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z]/g, '');
}

// Ключевое слово поля для матчинга: имя поля без подчёркиваний.
// "document_relations" → "documentrelations"
function fieldKeyword(spec) {
  return spec.field.toLowerCase().replace(/[^a-z]/g, '');
}

// Файл похоже не для этого поля, если ключевое слово поля не встречается в имени.
function isLikelyMismatch(spec, file) {
  if (!file) return false;
  return !normalizeName(file.name).includes(fieldKeyword(spec));
}
