// Data-table с поддержкой:
//  - Клик по заголовку колонки → onColumnHeaderClick(column) (для sort-modal).
//  - Клик по строке → активная строка (onActiveRowChange).
//  - Двойной клик по строке → onRowClick (детали).
//  - Чекбоксы выбора строк (bulk-операции).
//  - Inline row-edit: если editingRowKey совпадает с rowKey(row), вся строка
//    рендерится в режиме редактирования (input / dropdown / readonly), и в
//    конце ряда — кнопки Очистить / ок.
//
// Edit-режим:
//   - col.editKind === 'enum' с пустым col.enumValues → рендерим disabled
//     <select> с треугольником (для UI-намёка, см. P-011).
//   - col.editKind === 'checkbox' → чекбокс.
//   - col.editKind === 'textarea' → textarea.
//   - col.editKind === 'input' → <input> с правильным типом.
//   - col.editable === false → ячейка остаётся read-only, но визуально приглушена.

const KIND_INPUT = 'input';
const KIND_TEXTAREA = 'textarea';
const KIND_CHECKBOX = 'checkbox';
const KIND_ENUM = 'enum';

export function createDataTable({
  columns = [],
  rows = [],
  sort = null,                  // { key, dir } — текущая сортировка
  onColumnHeaderClick = null,   // (column) => void — открывает sort-modal
  columnTools = false,          // показывать треугольники в шапке + клик по ним (Excel-режим)
  cellMode = 'fit',             // 'fit' (всё помещается) | 'ellipsis' (одна строка) | 'wrap' (перенос)
  onRowClick = null,            // (row) => void — двойной клик
  onActiveRowChange = null,     // (rowKey|null) => void — одиночный клик
  activeRowKey = null,          // ключ активной (выбранной) строки
  editingRowKey = null,         // ключ редактируемой строки
  onRowEditCommit = null,       // (row, changes) => Promise — сохранить все изменения
  onRowEditCancel = null,       // () => void — отменить
  rowKey = null,                // (row) => any
  selection = null,             // Set (bulk-select checkboxes)
  onSelectionChange = null,
  emptyState = null,
} = {}) {
  const wrap = document.createElement('div');
  const wrapMode = cellMode === 'wrap' ? 'wrap' : cellMode === 'ellipsis' ? 'ellipsis' : 'fit';
  wrap.className = `data-table-wrapper data-table-wrapper--${wrapMode}`;

  const selectable = !!(rowKey && onSelectionChange);
  const editing = editingRowKey != null;

  if (!rows.length) {
    if (emptyState instanceof Node) wrap.append(emptyState);
    else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Пусто';
      wrap.append(empty);
    }
    return wrap;
  }

  const ctx = {
    columns, rows, sort, onColumnHeaderClick, columnTools, onRowClick, onActiveRowChange,
    activeRowKey, editingRowKey, onRowEditCommit, onRowEditCancel,
    rowKey, selection, onSelectionChange, selectable, editing,
  };

  const table = document.createElement('table');
  const modeClass = cellMode === 'wrap' ? 'data-table--wrap'
    : cellMode === 'ellipsis' ? 'data-table--ellipsis'
    : 'data-table--fit';
  table.className = `data-table ${modeClass}`;
  table.append(buildHead(ctx));
  table.append(buildBody(ctx));
  wrap.append(table);
  return wrap;
}

function buildHead(ctx) {
  const { columns, sort, onColumnHeaderClick, selectable, rows, rowKey, selection, onSelectionChange } = ctx;
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
    th.className = 'data-table__th';
    // Внутренний flex-контейнер: НЕ ставим display:flex на сам <th>, иначе он
    // перестаёт быть table-cell и шапка «разворачивается» в столбец.
    const inner = document.createElement('div');
    inner.className = 'data-table__th-inner';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'data-table__th-label';
    // Zero-width space после «_» — чистый перенос «source_type» → «source_/type».
    labelSpan.textContent = String(col.label ?? col.key).replace(/_/g, '_​');
    inner.append(labelSpan);

    // Треугольники-инструменты в шапке показываем только в Excel-режиме
    // (включается кнопкой ⇅ в тулбаре). Иначе шапка статична.
    if (ctx.columnTools && onColumnHeaderClick) {
      th.classList.add('data-table__th--tool');
      const indicator = document.createElement('span');
      indicator.className = 'data-table__sort-indicator';
      if (sort && sort.key === col.key) {
        indicator.textContent = sort.dir === 'desc' ? '▾' : '▴';
        th.classList.add('data-table__th--sorted');
      } else {
        indicator.textContent = '▾';
      }
      inner.append(indicator);
      th.addEventListener('click', (e) => {
        e.stopPropagation();
        onColumnHeaderClick(col);
      });
    }
    th.append(inner);
    headRow.append(th);
  }

  // Доп. колонка в конце для кнопок Очистить/ок при edit-режиме.
  if (ctx.editing) {
    const th = document.createElement('th');
    th.className = 'data-table__th--actions';
    headRow.append(th);
  }

  thead.append(headRow);
  return thead;
}

function buildBody(ctx) {
  const { columns, rows, rowKey, selection, onSelectionChange, selectable,
    activeRowKey, editingRowKey, onActiveRowChange, onRowClick, editing } = ctx;
  const tbody = document.createElement('tbody');

  for (const row of rows) {
    const tr = document.createElement('tr');
    const pk = rowKey ? rowKey(row) : null;
    const isEditing = editingRowKey != null && pk === editingRowKey;
    const isActive = activeRowKey != null && pk === activeRowKey;

    if (selectable && selection?.has(pk)) tr.classList.add('data-table__tr--selected');
    if (isActive) tr.classList.add('data-table__tr--active');
    if (isEditing) tr.classList.add('data-table__tr--editing');

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

    if (isEditing) {
      buildEditingRow(tr, row, ctx);
    } else {
      for (const col of columns) {
        const td = document.createElement('td');
        renderCellInto(td, col, row);
        if (editing) {
          // Чтобы readonly-ячейки не редактируемой строки визуально совпадали
          // по высоте с edit-row, ничего не делаем — стили это сами разрулят.
        }
        tr.append(td);
      }
      if (editing) {
        // Пустая колонка под actions, чтобы не плыла сетка.
        tr.append(document.createElement('td'));
      }

      // Клик по строке → активная; двойной клик → детали.
      if (!editing) {
        let clickTimer = null;
        tr.classList.add('data-table__tr--clickable');
        tr.addEventListener('click', (e) => {
          if (e.target.closest('input, button, textarea, select, a, .data-table__cell-fk')) return;
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            clickTimer = null;
            onActiveRowChange?.(isActive ? null : pk);
          }, 220);
        });
        tr.addEventListener('dblclick', (e) => {
          if (e.target.closest('input, button, textarea, select, a, .data-table__cell-fk')) return;
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          onRowClick?.(row);
        });
      }
    }

    tbody.append(tr);
  }
  return tbody;
}

function buildEditingRow(tr, row, ctx) {
  const { columns, onRowEditCommit, onRowEditCancel } = ctx;
  const changes = {}; // {colKey: rawInputValue}
  const readers = new Map();
  const cellErrors = new Map();

  for (const col of columns) {
    const td = document.createElement('td');
    td.className = 'data-table__td--edit';
    const raw = row[col.key];

    if (!col.editable) {
      // Read-only ячейка в edit-режиме: тот же текст, но визуально приглушённая.
      td.classList.add('data-table__td--edit-readonly');
      renderCellInto(td, col, row);
    } else {
      const kind = col.editKind || KIND_INPUT;
      const fieldWrap = document.createElement('div');
      fieldWrap.className = 'data-table__edit-field';
      let input;
      let read;

      if (kind === KIND_CHECKBOX) {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'data-table__edit-checkbox';
        input.checked = !!raw;
        read = () => input.checked;
      } else if (kind === KIND_ENUM) {
        const sel = document.createElement('select');
        sel.className = 'data-table__edit-select';
        const values = Array.isArray(col.enumValues) ? col.enumValues : [];
        if (values.length) {
          // Реальный выпадающий список из допустимых значений (CHECK IN).
          if (col.nullable) {
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = '—';
            sel.append(empty);
          }
          // Текущее значение, даже если его нет в списке — чтобы не потерять.
          const all = raw != null && !values.includes(String(raw))
            ? [String(raw), ...values] : values;
          for (const v of all) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            sel.append(opt);
          }
          sel.value = raw == null ? '' : String(raw);
          read = () => (sel.value === '' ? null : sel.value);
        } else {
          // P-011: значений нет — disabled-заглушка с треугольником (намёк).
          sel.disabled = true;
          sel.title = 'Список значений станет доступен после P-011 (метаданные enum)';
          const opt = document.createElement('option');
          opt.textContent = raw == null ? '—' : String(raw);
          sel.append(opt);
          read = () => raw;
        }
        input = sel;
      } else if (kind === KIND_TEXTAREA) {
        input = document.createElement('textarea');
        input.className = 'data-table__edit-input data-table__edit-input--textarea';
        input.rows = 2;
        input.value = raw == null ? '' : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
        read = () => input.value;
      } else {
        input = document.createElement('input');
        input.className = 'data-table__edit-input';
        input.type = col.editInputType || 'text';
        input.value = raw == null ? '' : String(raw);
        read = () => input.value;
      }

      const errorEl = document.createElement('div');
      errorEl.className = 'data-table__edit-error';
      errorEl.hidden = true;
      cellErrors.set(col.key, errorEl);

      fieldWrap.append(input, errorEl);
      td.append(fieldWrap);

      readers.set(col.key, { read, parse: col.parse, raw });
    }
    tr.append(td);
  }

  // Колонка с кнопками
  const actionsTd = document.createElement('td');
  actionsTd.className = 'data-table__td--row-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn data-table__row-action data-table__row-action--cancel';
  cancelBtn.textContent = 'Очистить';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onRowEditCancel?.();
  });

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn btn--primary data-table__row-action data-table__row-action--ok';
  okBtn.textContent = 'ок';
  okBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Собираем изменения
    let hasError = false;
    for (const [key, errEl] of cellErrors) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    for (const [key, { read, parse, raw }] of readers) {
      try {
        const value = parse ? parse(read(), raw, row) : read();
        if (!looseEq(value, raw)) changes[key] = value;
      } catch (err) {
        hasError = true;
        const errEl = cellErrors.get(key);
        if (errEl) {
          errEl.textContent = err?.message || 'Невалидное значение';
          errEl.hidden = false;
        }
      }
    }
    if (hasError) return;

    okBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await onRowEditCommit?.(row, changes);
    } catch (err) {
      okBtn.disabled = false;
      cancelBtn.disabled = false;
      // toast покажется в parent
    }
  });

  actionsTd.append(cancelBtn, okBtn);
  tr.append(actionsTd);
}

function renderCellInto(td, col, row) {
  td.replaceChildren();
  const raw = row[col.key];
  const value = col.render ? col.render(raw, row) : defaultFormat(raw);
  // Контент в обёртке: на ней работают max-width + ellipsis (single-line режим).
  const cell = document.createElement('div');
  cell.className = 'data-table__cell';
  if (value instanceof Node) cell.append(value);
  else cell.textContent = value;
  td.append(cell);
  // tooltip с полным значением (текст обрезается «…»)
  if (typeof raw === 'string' && raw.length > 20 && !td.title) td.title = raw;
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
