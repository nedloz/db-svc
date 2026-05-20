// Mock для P-002 — серверная фильтрация (`where`).
// Применяет массив фильтров к уже-загруженной странице строк. Это ВРЕМЕННО
// и сознательно не покрывает строки за пределами текущей страницы — об этом
// UI явно предупреждает (см. rows-panel.js, банер при filterMode='client').
//
// Когда бэк начнёт принимать query-параметр ?filter=<json>, выставляем
// USE_MOCK_FILTERS=false и этот файл больше не используется.

export function applyClientFilters(rows, filters) {
  if (!filters?.length) return rows;
  return rows.filter((row) => filters.every((f) => matchFilter(row, f)));
}

function matchFilter(row, filter) {
  const { column, op, value } = filter;
  const v = row[column];
  switch (op) {
    case 'eq':       return looseEq(v, value);
    case 'ne':       return !looseEq(v, value);
    case 'contains': return v != null && String(v).toLowerCase().includes(String(value).toLowerCase());
    case 'starts':   return v != null && String(v).toLowerCase().startsWith(String(value).toLowerCase());
    case 'ends':     return v != null && String(v).toLowerCase().endsWith(String(value).toLowerCase());
    case 'null':     return v === null || v === undefined;
    case 'not_null': return v !== null && v !== undefined;
    case 'between':  return inRange(v, value);
    case 'in':       return Array.isArray(value) && value.some((x) => looseEq(v, x));
    default:         return true;
  }
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function inRange(v, range) {
  if (!Array.isArray(range) || range.length !== 2) return true;
  if (v == null) return false;
  const [from, to] = range;
  const nv = Number(v), nfrom = Number(from), nto = Number(to);
  if (Number.isFinite(nv) && Number.isFinite(nfrom) && Number.isFinite(nto)) {
    return nv >= nfrom && nv <= nto;
  }
  return String(v) >= String(from) && String(v) <= String(to);
}
