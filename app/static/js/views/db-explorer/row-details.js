// Модал «Детали строки». Открывается кликом по строке в data-table.
//
// Логика:
//  - читаемое отображение каждого поля (NULL / bool / datetime / json / uuid /
//    vector / длинные строки) — без обрезки, в отличие от cell-рендера;
//  - копирование отдельного поля в буфер;
//  - копирование всей строки как JSON;
//  - Edit / Delete вызывают переданные обработчики (получают row и close —
//    обработчик сам решает, закрывать ли модал деталей до открытия формы).
//  - Cascade preview перед удалением появится в M6 (P-004).

import { openModal } from '../../components/modal.js';
import { categorizePgType } from '../../utils/types.js';
import { toast } from '../../components/toast.js';

export function openRowDetails({ row, columns, selection, onEdit, onDelete }) {
  const body = buildBody({ row, columns });
  return openModal({
    title: selection ? `${selection.schema}.${selection.table}` : 'Строка',
    body,
    actions: [
      { label: 'Редактировать', onClick: (close) => onEdit?.(row, close) },
      { label: 'Удалить', variant: 'danger', onClick: (close) => onDelete?.(row, close) },
      { label: 'Закрыть', onClick: (close) => close() },
    ],
  });
}

function buildBody({ row, columns }) {
  const root = document.createElement('div');
  root.className = 'row-details';

  const header = document.createElement('div');
  header.className = 'row-details__header';
  const copyAllBtn = document.createElement('button');
  copyAllBtn.type = 'button';
  copyAllBtn.className = 'btn row-details__copy-all';
  copyAllBtn.textContent = 'Скопировать строку как JSON';
  copyAllBtn.addEventListener('click', () => copyText(JSON.stringify(row, null, 2), 'Строка скопирована'));
  header.append(copyAllBtn);
  root.append(header);

  const list = document.createElement('div');
  list.className = 'row-details__fields';
  for (const col of columns) list.append(buildField(col, row[col.name]));
  root.append(list);
  return root;
}

function buildField(col, value) {
  const field = document.createElement('div');
  field.className = 'row-details__field';

  const head = document.createElement('div');
  head.className = 'row-details__field-head';
  const name = makeSpan(col.name, 'row-details__field-name');
  const meta = makeSpan(`${col.type}${col.nullable ? '' : ' NOT NULL'}`, 'row-details__field-meta');
  head.append(name, meta);

  const valueWrap = document.createElement('div');
  valueWrap.className = 'row-details__field-value';
  const valueEl = formatDetailValue(value, col.type);
  if (valueEl instanceof Node) valueWrap.append(valueEl);
  else valueWrap.textContent = valueEl;

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn row-details__copy-field';
  copyBtn.textContent = 'Копировать';
  copyBtn.addEventListener('click', () => copyText(serialize(value, col.type), 'Скопировано'));

  field.append(head, valueWrap, copyBtn);
  return field;
}

function formatDetailValue(value, rawType) {
  if (value === null || value === undefined) return makeSpan('NULL', 'cell--muted');
  const category = categorizePgType(rawType);
  switch (category) {
    case 'json':    return formatJsonPretty(value);
    case 'bool':    return value ? '✓ true' : '✗ false';
    case 'vector':  return formatVectorDetail(value);
    case 'datetime':
    case 'uuid':
    case 'binary':  return makeSpan(String(value), 'cell--mono');
    default:        return formatTextFull(value);
  }
}

function formatJsonPretty(value) {
  const pre = document.createElement('pre');
  pre.className = 'detail-value detail-value--json';
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value;
    pre.textContent = JSON.stringify(obj, null, 2);
  } catch (_e) {
    pre.textContent = String(value);
  }
  return pre;
}

function formatTextFull(value) {
  const pre = document.createElement('pre');
  pre.className = 'detail-value detail-value--text';
  pre.textContent = String(value);
  return pre;
}

function formatVectorDetail(value) {
  let dims;
  let preview;
  if (Array.isArray(value)) {
    dims = value.length;
    const head = value.slice(0, 6).map((n) => String(n)).join(', ');
    preview = dims > 6 ? `${head}, …` : head;
  } else {
    const str = String(value);
    dims = (str.match(/,/g) || []).length + 1;
    preview = str.length > 200 ? `${str.slice(0, 200)}…` : str;
  }
  const pre = document.createElement('pre');
  pre.className = 'detail-value detail-value--vector';
  pre.textContent = `[${dims} dims]\n${preview}`;
  return pre;
}

function makeSpan(text, className = '') {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = text;
  return s;
}

function serialize(value, rawType) {
  if (value === null || value === undefined) return 'NULL';
  if (categorizePgType(rawType) === 'json') {
    try {
      const obj = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(obj, null, 2);
    } catch (_e) { /* fall through */ }
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function copyText(text, successMessage) {
  if (!navigator.clipboard?.writeText) {
    toast.error('Буфер обмена недоступен (нужен HTTPS или localhost)');
    return;
  }
  navigator.clipboard.writeText(text)
    .then(() => toast.success(successMessage))
    .catch((err) => toast.error(`Ошибка копирования: ${err.message}`));
}
