// Эвристика определения первичного ключа таблицы.
// Бэк (P-001) пока не отдаёт метаданные PK — берём колонку 'id' если есть,
// иначе первую. Покрывает 99% таблиц проекта (см. infra/db/init/init.sql);
// для композитных PK мок будет работать неточно — фиксить после P-001.

export function detectPkColumn(columns) {
  if (!Array.isArray(columns) || !columns.length) return null;
  const id = columns.find((c) => c?.name === 'id');
  return id ? 'id' : columns[0].name;
}

export function detectPkValue(row, columns) {
  if (!row || typeof row !== 'object') return null;
  const col = detectPkColumn(columns);
  if (col) return row[col];
  if ('id' in row) return row.id;
  const first = Object.keys(row)[0];
  return first ? row[first] : null;
}
