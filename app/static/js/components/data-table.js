// Data-table с поддержкой:
//  - кликабельных заголовков (сортировка);
//  - типизированных рендереров ячеек;
//  - выбор строк через чекбоксы (M5, опционально через rowKey + selection);
//  - inline-edit одной ячейки (M5, dblclick → input → Enter / Escape).
//
// FK-ссылки и расширенный selection — M6.

const EDIT_KIND_INPUT = 'input';
const EDIT_KIND_TEXTAREA = 'textarea';
const EDIT_KIND_CHECKBOX = 'checkbox';

export function createDataTable({
  columns = [],         // [{ key, label, sortable, editable, editKind, parse?, format?, render?(value, row) }]
  rows = [],
  sort = null,          // { key } — текущая сортировка (направление пока всегда asc, см. P-002)
  onSortChange = null,
  onRowClick = null,
  onCellEdit = null,    // ({ row, column, value }) => Promise|void — возврат отказа кидать исключением
  rowKey = null,        // (row) => any — обязательно для selection
  selection = null,     // Set значений rowKey(row) — управляется снаружи
  onSelectionChange = null, // (newSet: Set) => void
  emptyState = null,
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrapper';

  const selectable = !!(rowKey && onSelectionChange);
  const editable = !!onCellEdit;

  if (!rows.length) {
    if (emptyState instanceof Node) {
      wrap.append(emptyState);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Пусто';
      wrap.append(empty);
    }
    return wrap;
  }

  const ctx = { columns, rows, sort, onSortChange, onRowClick, onCellEdit, rowKey, selection, onSelectionChange, selectable, editable };

  const table = document.createElement('table');
  table.className = 'data-table';
  table.append(buildHead(ctx));
  table.append(buildBody(ctx));
  wrap.append(table);
  return wrap;
}

function buildHead(ctx) {
  const { columns, sort, onSortChange, selectable, rows, rowKey, selection, onSelectionChange } = ctx;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  if (selectable) {
    const th = document.createElement('th');
    th.className = 'data-table__th--select';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', 'Выделить все строки на странице');
    const pageKeys = rows.map((r) => rowKey(r));
    const allChecked = pageKeys.length > 0 && pageKeys.every((k) => selection?.has(k));
    const someChecked = !allChecked && pageKeys.some((k) => selection?.has(k));
    cb.checked = allChecked;
    cb.indeterminate = someChecked;
    cb.addEventListener('change', () => {
      const next = new Set(selection || []);
      if (cb.checked) for (const k of pageKeys) next.add(k);
      else for (const k of pageKeys) next.delete(k);
      onSelectionChange(next);
    });
    th.append(cb);
    headRow.append(th);
  }

  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col.label ?? col.key;
    if (col.sortable && onSortChange) {
      th.classList.add('data-table__th--sortable');
      const indicator = document.createElement('span');
      indicator.className = 'data-table__sort-indicator';
      const isActive = sort && sort.key === col.key;
      indicator.textContent = isActive ? '▴' : '·';
      if (isActive) th.classList.add('data-table__th--sorted');
      th.append(indicator);
      th.addEventListener('click', () => onSortChange({ key: col.key }));
    }
    headRow.append(th);
  }
  thead.append(headRow);
  return thead;
}

function buildBody(ctx) {
  const { columns, rows, onRowClick, rowKey, selection, onSelectionChange, selectable, editable } = ctx;
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const pk = rowKey ? rowKey(row) : null;
    if (selectable && selection?.has(pk)) tr.classList.add('data-table__tr--selected');

    if (selectable) {
      const td = document.createElement('td');
      td.className = 'data-table__td--select';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!selection?.has(pk);
      cb.setAttribute('aria-label', 'Выбрать строку');
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const next = new Set(selection || []);
        if (cb.checked) next.add(pk);
        else next.delete(pk);
        onSelectionChange(next);
      });
      td.append(cb);
      tr.append(td);
    }

    let clickTimer = null;
    for (const col of columns) {
      const td = document.createElement('td');
      renderCellInto(td, col, row);

      if (editable && col.editable) {
        td.classList.add('data-table__td--editable');
        td.title = (td.title ? td.title + ' · ' : '') + 'Двойной клик — редактировать';
        td.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          startInlineEdit(td, col, row, ctx);
        });
      }
      tr.append(td);
    }

    if (onRowClick) {
      tr.classList.add('data-table__tr--clickable');
      tr.addEventListener('click', (e) => {
        // Не открывать детали по клику на чекбокс / inline-input / кнопку.
        if (e.target.closest('input, button, textarea, select, .data-table__td--editing')) return;
        // Откладываем, чтобы dblclick по editable-ячейке успел отменить.
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickTimer = null; onRowClick(row); }, 200);
      });
      tr.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      });
    }
    tbody.append(tr);
  }
  return tbody;
}

function renderCellInto(td, col, row) {
  td.replaceChildren();
  const raw = row[col.key];
  const value = col.render ? col.render(raw, row) : defaultFormat(raw);
  if (value instanceof Node) td.append(value);
  else td.textContent = value;
  if (typeof raw === 'string' && raw.length > 60 && !td.title) td.title = raw;
}

function startInlineEdit(td, col, row, ctx) {
  if (td.classList.contains('data-table__td--editing')) return;
  td.classList.add('data-table__td--editing');
  const raw = row[col.key];
  const kind = col.editKind || EDIT_KIND_INPUT;

  const original = [...td.childNodes];
  td.replaceChildren();

  let input;
  let getValue;
  if (kind === EDIT_KIND_CHECKBOX) {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!raw;
    getValue = () => input.checked;
  } else if (kind === EDIT_KIND_TEXTAREA) {
    input = document.createElement('textarea');
    input.className = 'textarea';
    input.rows = 3;
    input.value = raw == null ? '' : (typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw));
    getValue = () => input.value;
  } else {
    input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.value = raw == null ? '' : String(raw);
    getValue = () => input.value;
  }
  td.append(input);

  const error = document.createElement('div');
  error.className = 'data-table__edit-error';
  error.hidden = true;
  td.append(error);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    td.classList.remove('data-table__td--editing');
    td.replaceChildren(...original);
  };

  const commit = async () => {
    if (done) return;
    let value;
    try {
      value = col.parse ? col.parse(getValue(), raw, row) : getValue();
    } catch (err) {
      error.textContent = err.message || 'Невалидное значение';
      error.hidden = false;
      return;
    }
    if (looseEq(value, raw)) { finish(); return; }
    input.disabled = true;
    try {
      await ctx.onCellEdit({ row, column: col.key, value });
      // После успешного onCellEdit вызывающий перезагрузит строки; finish не нужен.
    } catch (err) {
      input.disabled = false;
      error.textContent = err?.message || 'Ошибка сохранения';
      error.hidden = false;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'Enter' && kind !== EDIT_KIND_TEXTAREA) { e.preventDefault(); commit(); }
    else if (e.key === 'Enter' && e.ctrlKey && kind === EDIT_KIND_TEXTAREA) { e.preventDefault(); commit(); }
  });
  input.addEventListener('blur', () => { if (!done) commit(); });
  input.focus();
  if (typeof input.select === 'function') input.select();
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return String(a) === String(b);
}

function defaultFormat(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
