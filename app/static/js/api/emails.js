// Тексты писем: core.email_templates через общий CRUD /api/db/*. Не трогают DOM.
// Свой роут не нужен: таблица лежит в core, куда у роли db-svc есть запись, а правки
// попадают в журнал действий так же, как и любые другие строки.
import { listRows, updateRow } from './db.js';

const SCHEMA = 'core';
const TABLE = 'email_templates';

export async function listEmailTemplates(opts = {}) {
  // Без orderBy: общий listRows шлёт «col asc» одной строкой, а бэкенд ждёт имя колонки
  // отдельно и отвечает 500. Писем единицы, сортируем здесь.
  const data = await listRows({ schema: SCHEMA, table: TABLE, limit: 200 }, opts);
  return [...data.rows].sort((a, b) => a.event_type.localeCompare(b.event_type));
}

export async function saveEmailTemplate(eventType, { subject_template, body_html }, opts = {}) {
  return updateRow(
    SCHEMA,
    TABLE,
    eventType,
    { subject_template, body_html, updated_at: new Date().toISOString() },
    [],
    opts,
  );
}
