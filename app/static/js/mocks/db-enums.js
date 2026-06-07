// Карта допустимых значений колонок, ограниченных в БД через CHECK (col IN (...))
// или enum-тип. Источник правды — infra/db/init/init.sql.
//
// Бэк пока не отдаёт метаданные допустимых значений (см. PROBLEMS.md → P-011),
// поэтому карта статична и обновляется вручную при изменении init.sql — ровно
// как карта FK в mocks/db-relations.js.
//
// Когда бэк начнёт отдавать allowed_values по колонке — заменить getColumnEnum
// на реальный fetch и убрать этот файл.

export const COLUMN_ENUMS = {
  'auth.users.role':        ['student', 'curator', 'admin'],
  'chat.chat_messages.role': ['user', 'assistant', 'system'],
  'library.documents.status': ['draft', 'published', 'archived'],
};

// Возвращает массив допустимых значений или null.
export function getColumnEnum(schema, table, column) {
  return COLUMN_ENUMS[`${schema}.${table}.${column}`] || null;
}
