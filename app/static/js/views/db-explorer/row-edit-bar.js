// Оверлей редактирования строки (дизайн edit.jsx): отдельная панель, которая
// открывается ПОВЕРХ таблицы по кнопке ✎. Заголовок «Редактирование», ряд
// ячеек-полей (редактируемые — голубая рамка #94B2F0, read-only — серая),
// enum-колонки рендерятся выпадающим списком, внизу справа — «Очистить» / «ок».
//
// columns — это tableColumns из rows-panel (key/label/editable/editKind/
// enumValues/nullable/parse). row — данные редактируемой строки.

export function buildRowEditBar({ columns, row, onCommit, onCancel, onDelete }) {
  const bar = document.createElement('div');
  bar.className = 'row-edit-bar';

  const title = document.createElement('div');
  title.className = 'row-edit-bar__title';
  title.textContent = 'Редактирование';
  bar.append(title);

  const cells = document.createElement('div');
  cells.className = 'row-edit-bar__cells';

  const readers = new Map();      // colKey -> { read, parse, raw }
  const cellErrors = new Map();   // colKey -> errorEl

  for (const col of columns) {
    const cell = document.createElement('div');
    cell.className = 'row-edit-bar__cell';

    const label = document.createElement('div');
    label.className = 'row-edit-bar__cell-label';
    label.textContent = col.label || col.key;
    label.title = col.label || col.key;
    cell.append(label);

    const raw = row[col.key];

    if (!col.editable) {
      const ro = document.createElement('div');
      ro.className = 'row-edit-bar__readonly';
      const text = raw == null ? '—' : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
      ro.textContent = text;
      ro.title = text;
      cell.append(ro);
      cells.append(cell);
      continue;
    }

    const kind = col.editKind || 'input';
    let input;
    let read;

    if (kind === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'row-edit-bar__checkbox';
      input.checked = !!raw;
      read = () => input.checked;
    } else if (kind === 'enum' && Array.isArray(col.enumValues) && col.enumValues.length) {
      input = document.createElement('select');
      input.className = 'row-edit-bar__select';
      if (col.nullable) {
        const empty = document.createElement('option');
        empty.value = ''; empty.textContent = '—';
        input.append(empty);
      }
      const values = raw != null && !col.enumValues.includes(String(raw))
        ? [String(raw), ...col.enumValues] : col.enumValues;
      for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        input.append(opt);
      }
      input.value = raw == null ? '' : String(raw);
      read = () => (input.value === '' ? null : input.value);
    } else if (kind === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'row-edit-bar__input row-edit-bar__input--textarea';
      input.rows = 3;
      input.value = raw == null ? '' : (typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw));
      read = () => input.value;
    } else {
      input = document.createElement('input');
      input.className = 'row-edit-bar__input';
      input.type = col.editInputType || 'text';
      input.value = raw == null ? '' : String(raw);
      read = () => input.value;
    }
    cell.append(input);

    const errEl = document.createElement('div');
    errEl.className = 'row-edit-bar__cell-error';
    errEl.hidden = true;
    cell.append(errEl);
    cellErrors.set(col.key, errEl);

    readers.set(col.key, { read, parse: col.parse, raw });
    cells.append(cell);
  }

  bar.append(cells);

  // ----- Футер: Удалить (слева) · Очистить / ок (справа) -----
  const footer = document.createElement('div');
  footer.className = 'row-edit-bar__footer';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn--danger row-edit-bar__delete';
  deleteBtn.textContent = 'Удалить';
  deleteBtn.addEventListener('click', () => onDelete?.(row));

  const rightGroup = document.createElement('div');
  rightGroup.className = 'row-edit-bar__footer-right';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn row-edit-bar__cancel';
  cancelBtn.textContent = 'Очистить';
  cancelBtn.addEventListener('click', () => onCancel?.());

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn btn--primary row-edit-bar__ok';
  okBtn.textContent = 'ок';
  okBtn.addEventListener('click', async () => {
    for (const errEl of cellErrors.values()) { errEl.hidden = true; errEl.textContent = ''; }
    const changes = {};
    let hasError = false;
    for (const [key, { read, parse, raw }] of readers) {
      try {
        const value = parse ? parse(read(), raw, row) : read();
        if (!looseEq(value, raw)) changes[key] = value;
      } catch (err) {
        hasError = true;
        const errEl = cellErrors.get(key);
        if (errEl) { errEl.textContent = err?.message || 'Невалидное значение'; errEl.hidden = false; }
      }
    }
    if (hasError) return;
    okBtn.disabled = true; cancelBtn.disabled = true;
    try {
      await onCommit?.(row, changes);
    } catch (_e) {
      okBtn.disabled = false; cancelBtn.disabled = false;
    }
  });

  rightGroup.append(cancelBtn, okBtn);
  footer.append(deleteBtn, rightGroup);
  bar.append(footer);

  return bar;
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
