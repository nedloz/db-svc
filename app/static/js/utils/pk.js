// Определение первичного ключа таблицы.
// Бэк отдаёт is_pk в /columns, поэтому используем его. Поддержка составного PK
// (P-010): detectPkValue для нескольких PK-колонок возвращает объект
// { col: value, ... }, для одиночной — скаляр.

// Все PK-колонки по is_pk; fallback — 'id' или первая колонка.
export function pkColumns(columns) {
  if (!Array.isArray(columns) || !columns.length) return [];
  const pks = columns.filter((c) => c?.is_pk).map((c) => c.name);
  if (pks.length) return pks;
  const id = columns.find((c) => c?.name === 'id');
  return id ? ['id'] : [columns[0].name];
}

// Имя одиночной PK-колонки (для рендера/детекта). Для составного — первая.
export function detectPkColumn(columns) {
  const pks = pkColumns(columns);
  return pks.length ? pks[0] : null;
}

// Значение PK строки: скаляр для одиночного, объект {col: val} для составного.
export function detectPkValue(row, columns) {
  if (!row || typeof row !== 'object') return null;
  const pks = pkColumns(columns);
  if (pks.length <= 1) {
    const col = pks[0];
    if (col && col in row) return row[col];
    if ('id' in row) return row.id;
    const first = Object.keys(row)[0];
    return first ? row[first] : null;
  }
  const out = {};
  for (const col of pks) out[col] = row[col];
  return out;
}

// Стабильный строковый ключ строки (для Set/сравнения активной/редактируемой).
export function pkKey(pkValue) {
  if (pkValue && typeof pkValue === 'object') {
    try { return JSON.stringify(pkValue); } catch { return String(pkValue); }
  }
  return String(pkValue);
}
