// Тонкие фабрики базовых контролов формы. Без бизнес-логики.

export function createField({ label, control } = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  if (label) {
    const lbl = document.createElement('span');
    lbl.className = 'field__label';
    lbl.textContent = label;
    wrap.append(lbl);
  }
  if (control) wrap.append(control);
  return wrap;
}

export function createInput({ value = '', placeholder = '', type = 'text', onInput = null } = {}) {
  const el = document.createElement('input');
  el.className = 'input';
  el.type = type;
  el.value = value;
  if (placeholder) el.placeholder = placeholder;
  if (onInput) el.addEventListener('input', (e) => onInput(e.target.value, e));
  return el;
}

export function createTextarea({ value = '', placeholder = '', rows = 3, onInput = null } = {}) {
  const el = document.createElement('textarea');
  el.className = 'textarea';
  el.rows = rows;
  el.value = value;
  if (placeholder) el.placeholder = placeholder;
  if (onInput) el.addEventListener('input', (e) => onInput(e.target.value, e));
  return el;
}

export function createSelect({ value = '', options = [], onChange = null } = {}) {
  const el = document.createElement('select');
  el.className = 'select';
  for (const opt of options) {
    const o = document.createElement('option');
    if (opt && typeof opt === 'object') {
      o.value = opt.value;
      o.textContent = opt.label ?? opt.value;
    } else {
      o.value = opt;
      o.textContent = opt;
    }
    el.append(o);
  }
  el.value = value;
  if (onChange) el.addEventListener('change', (e) => onChange(e.target.value, e));
  return el;
}

export function createCheckbox({ checked = false, label = '', onChange = null } = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const row = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  if (onChange) input.addEventListener('change', (e) => onChange(e.target.checked, e));
  row.append(input);
  if (label) {
    const text = document.createElement('span');
    text.textContent = ` ${label}`;
    row.append(text);
  }
  wrap.append(row);
  return { element: wrap, input };
}
