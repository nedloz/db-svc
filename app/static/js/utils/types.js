// Маппинг PostgreSQL data_type → высокоуровневая категория.
// information_schema.columns даёт типы как 'character varying', 'timestamp without time zone',
// 'USER-DEFINED' (для enum) и т.п. — ниже учитываем именно их.

const NUMBER_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real',
  'double precision', 'serial', 'bigserial', 'smallserial', 'money',
]);
const BOOL_TYPES = new Set(['boolean']);
const DATE_TYPES = new Set([
  'date', 'time', 'time without time zone', 'time with time zone',
  'timestamp', 'timestamp without time zone', 'timestamp with time zone',
  'timestamptz', 'timetz', 'interval',
]);
const JSON_TYPES = new Set(['json', 'jsonb']);
const UUID_TYPES = new Set(['uuid']);
const TEXT_TYPES = new Set([
  'text', 'character varying', 'varchar', 'character', 'char',
  'citext', 'name',
]);
const BINARY_TYPES = new Set(['bytea']);

export function categorizePgType(rawType) {
  if (!rawType) return 'unknown';
  const t = String(rawType).toLowerCase().trim();
  if (NUMBER_TYPES.has(t)) return 'number';
  if (BOOL_TYPES.has(t)) return 'bool';
  if (DATE_TYPES.has(t)) return 'datetime';
  if (JSON_TYPES.has(t)) return 'json';
  if (UUID_TYPES.has(t)) return 'uuid';
  if (TEXT_TYPES.has(t)) return 'text';
  if (BINARY_TYPES.has(t)) return 'binary';
  if (t.startsWith('vector')) return 'vector';
  if (t === 'array' || t.endsWith('[]')) return 'array';
  if (t === 'user-defined') return 'enum';
  return 'unknown';
}

const TYPE_ALIASES = {
  'character varying': 'varchar',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  'double precision': 'float8',
  'user-defined': 'enum',
};

// Короткое отображение типа для UI.
export function shortPgType(rawType) {
  if (!rawType) return '';
  const t = String(rawType).toLowerCase().trim();
  return TYPE_ALIASES[t] || t;
}
