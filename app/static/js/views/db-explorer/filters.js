// Панель фильтров над таблицей. Каждая строка: column → op → value.
// Состояние строк живёт в DOM (uncontrolled inputs) — на «Применить» собираем
// значения и отдаём наружу. Это спасает фокус ввода при ре-рендере store.
//
// Логика, какие операторы уместны для какого pg-типа, добавится позже —
// в M3 даём все операторы для любых колонок (мок всё равно фильтрует строково).
import { createSelect, createInput } from '../../components/form-controls.js';

const OPERATORS = [
  { value: 'eq',       label: '=' },
  { value: 'ne',       label: '≠' },
  { value: 'contains', label: 'contains' },
  { value: 'starts',   label: 'starts with' },
  { value: 'ends',     label: 'ends with' },
  { value: 'null',     label: 'is null' },
  { value: 'not_null', label: 'is not null' },
  { value: 'between',  label: 'between' },
  { value: 'in',       label: 'in (csv)' },
];

export function mountFiltersPanel({ container, store, onApply, onClear, onExport }) {
  const wrap = document.createElement('div');
  wrap.className = 'filters-panel';
  container.replaceChildren(wrap);

  let lastSelection = undefined;
  let lastFilters = undefined;

  const unsub = store.subscribe(() => {
    const s = store.get();
    if (s.selection === lastSelection && s.filters === lastFilters) return;
    lastSelection = s.selection;
    lastFilters = s.filters;
    render();
  });
  render();

  function render() {
    const { selection, columns, filters } = store.get();
    wrap.replaceChildren();
    if (!selection) return;

    const list = document.createElement('div');
    list.className = 'filters-panel__list';
    for (const f of filters.map(filterToDraft)) list.append(buildRow(columns, f));

    const controls = document.createElement('div');
    controls.className = 'filters-panel__controls';

    const addBtn = mkBtn('+ Добавить фильтр', 'filters-panel__add', () => {
      list.append(buildRow(columns, {
        column: columns[0]?.name || '',
        op: 'eq',
        value: '',
      }));
    });
    addBtn.disabled = !columns.length;

    const applyBtn = mkBtn('Применить', 'filters-panel__apply', () => onApply(readFromDom(list)));
    applyBtn.disabled = !columns.length;

    const clearBtn = mkBtn('Очистить', 'filters-panel__clear', () => onClear());

    const exportBtn = mkBtn('Export CSV', 'filters-panel__export', () => onExport?.(readFromDom(list)));
    exportBtn.disabled = !columns.length || !onExport;

    controls.append(addBtn, applyBtn, clearBtn, exportBtn);
    wrap.append(list, controls);
  }

  return () => unsub();
}

function buildRow(columns, draft) {
  const row = document.createElement('div');
  row.className = 'filters-panel__row';
  row.dataset.filter = '1';

  const colSelect = createSelect({
    value: draft.column,
    options: columns.map((c) => ({ value: c.name, label: c.name })),
  });
  colSelect.classList.add('filters-panel__column');

  const opSelect = createSelect({
    value: draft.op,
    options: OPERATORS,
    onChange: () => updateValueInputs(row, opSelect.value, '', ''),
  });
  opSelect.classList.add('filters-panel__op');

  const valueWrap = document.createElement('span');
  valueWrap.className = 'filters-panel__value';

  const removeBtn = mkBtn('×', 'filters-panel__remove', () => row.remove());

  row.append(colSelect, opSelect, valueWrap, removeBtn);
  updateValueInputs(row, draft.op, draft.value, draft.value2);
  return row;
}

function updateValueInputs(row, op, value, value2) {
  const valueWrap = row.querySelector('.filters-panel__value');
  valueWrap.replaceChildren();
  if (op === 'null' || op === 'not_null') return;

  if (op === 'between') {
    const a = createInput({ value: value ?? '', placeholder: 'от' });
    const b = createInput({ value: value2 ?? '', placeholder: 'до' });
    a.classList.add('filters-panel__value-from');
    b.classList.add('filters-panel__value-to');
    valueWrap.append(a, b);
    return;
  }
  if (op === 'in') {
    const i = createInput({ value: value ?? '', placeholder: 'a, b, c' });
    i.classList.add('filters-panel__value-in');
    valueWrap.append(i);
    return;
  }
  const i = createInput({ value: value ?? '', placeholder: 'значение' });
  i.classList.add('filters-panel__value-single');
  valueWrap.append(i);
}

function readFromDom(list) {
  const out = [];
  for (const row of list.querySelectorAll('[data-filter]')) {
    const column = row.querySelector('.filters-panel__column')?.value || '';
    const op = row.querySelector('.filters-panel__op')?.value || 'eq';
    if (!column) continue;
    const f = { column, op };
    if (op === 'null' || op === 'not_null') { out.push(f); continue; }
    if (op === 'between') {
      const from = row.querySelector('.filters-panel__value-from')?.value ?? '';
      const to   = row.querySelector('.filters-panel__value-to')?.value ?? '';
      f.value = [from, to];
      out.push(f); continue;
    }
    if (op === 'in') {
      const raw = row.querySelector('.filters-panel__value-in')?.value ?? '';
      f.value = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      out.push(f); continue;
    }
    f.value = row.querySelector('.filters-panel__value-single')?.value ?? '';
    out.push(f);
  }
  return out;
}

function filterToDraft(stored) {
  if (stored.op === 'between') {
    const [a, b] = Array.isArray(stored.value) ? stored.value : ['', ''];
    return { column: stored.column, op: stored.op, value: a, value2: b };
  }
  if (stored.op === 'in') {
    return {
      column: stored.column,
      op: stored.op,
      value: Array.isArray(stored.value) ? stored.value.join(', ') : '',
    };
  }
  return { column: stored.column, op: stored.op, value: stored.value ?? '' };
}

function mkBtn(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${className}`;
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
