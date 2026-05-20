// Колоночный рендерер по типу. Возвращает либо строку, либо DOM Node
// (когда нужен tooltip / спец-класс). Никаких inline-стилей — только classNames.
import { categorizePgType } from './types.js';

const ELLIPSIS_LIMIT = 80;

export function formatCell(value, rawType) {
  const category = categorizePgType(rawType);
  if (value === null || value === undefined) return makeSpan('—', 'cell--muted');

  switch (category) {
    case 'bool':
      return value
        ? makeSpan('✓', 'cell--bool-true')
        : makeSpan('✗', 'cell--bool-false');
    case 'json':
      return formatJson(value);
    case 'datetime':
      return formatDatetime(value);
    case 'vector':
      return formatVector(value);
    case 'binary':
      return makeSpan('<binary>', 'cell--mono cell--muted');
    case 'uuid':
      return makeSpan(String(value), 'cell--mono');
    case 'array':
      return formatArrayLike(value);
    default:
      return formatText(value);
  }
}

function makeSpan(text, className = '') {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

function formatText(value) {
  const str = String(value);
  if (str.length > ELLIPSIS_LIMIT) {
    const span = makeSpan(str.slice(0, ELLIPSIS_LIMIT) + '…');
    span.title = str;
    return span;
  }
  return str;
}

function formatJson(value) {
  let serialized;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_e) {
    serialized = String(value);
  }
  const display = serialized.length > ELLIPSIS_LIMIT
    ? serialized.slice(0, ELLIPSIS_LIMIT) + '…'
    : serialized;
  const span = makeSpan(display, 'cell--json');
  span.title = serialized;
  return span;
}

function formatDatetime(value) {
  const str = String(value);
  // Если бэк отдаёт ISO 8601 — обрежем дробные секунды и тайм-зону для удобства.
  const match = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(.*)$/);
  if (match) {
    const span = makeSpan(`${match[1]} ${match[2]}`, 'cell--date');
    span.title = str;
    return span;
  }
  return makeSpan(str, 'cell--date');
}

function formatVector(value) {
  if (Array.isArray(value)) return makeSpan(`[${value.length} dims]`, 'cell--vector');
  if (typeof value === 'string') {
    const dims = (value.match(/,/g) || []).length + 1;
    const span = makeSpan(`[${dims} dims]`, 'cell--vector');
    span.title = value.length > 200 ? value.slice(0, 200) + '…' : value;
    return span;
  }
  return makeSpan('<vector>', 'cell--vector');
}

function formatArrayLike(value) {
  let serialized;
  try {
    serialized = Array.isArray(value) ? JSON.stringify(value) : String(value);
  } catch (_e) {
    serialized = String(value);
  }
  return formatText(serialized);
}
