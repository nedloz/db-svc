// Mock для P-001 — CRUD endpoints. In-memory persistence в рамках сессии.
// Хранит изменения по (schema, table) как три набора:
//   created — новые строки, которых нет на бэке;
//   updated — карта pk → полный изменённый row;
//   deleted — set pk, которые надо скрыть.
// applyClientCrud() накладывает это на ответ listRows. mockCountDelta() корректирует total.
//
// PK определяется эвристикой: колонка 'id' если есть, иначе первая колонка.
// Это подходит для большинства таблиц проекта (см. infra/db/init/init.sql);
// для таблиц с композитным PK мок будет работать неточно — фиксить, когда бэк P-001
// будет готов и мок выключится.

const store = new Map(); // `${schema}.${table}` -> { created, updated, deleted }
let intCounter = -1;     // отрицательный счётчик для int PK без коллизий с реальными

function key(schema, table) { return `${schema}.${table}`; }

function getOrInit(schema, table) {
  const k = key(schema, table);
  if (!store.has(k)) store.set(k, { created: [], updated: new Map(), deleted: new Set() });
  return store.get(k);
}

function detectPk(columns) {
  return columns.find((c) => c.name === 'id')?.name || columns[0]?.name || null;
}

function detectPkFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  if ('id' in row) return 'id';
  return Object.keys(row)[0] || null;
}

function generateId(columns) {
  const pkCol = columns.find((c) => c.name === 'id') || columns[0];
  if (!pkCol) return null;
  const t = String(pkCol.type).toLowerCase();
  if (t.includes('uuid')) return crypto.randomUUID();
  if (t.includes('int')) return intCounter--;
  return null;
}

export function mockCreate(schema, table, columns, data) {
  const state = getOrInit(schema, table);
  const pkCol = detectPk(columns);
  const row = { ...data };
  if (pkCol && (row[pkCol] === undefined || row[pkCol] === null || row[pkCol] === '')) {
    row[pkCol] = generateId(columns);
  }
  const now = new Date().toISOString();
  if (columns.some((c) => c.name === 'created_at') && !row.created_at) row.created_at = now;
  if (columns.some((c) => c.name === 'updated_at') && !row.updated_at) row.updated_at = now;
  state.created.push(row);
  return row;
}

export function mockUpdate(schema, table, columns, pk, data) {
  const state = getOrInit(schema, table);
  // Если эта строка только что создана локально — обновляем там же.
  const pkCol = detectPk(columns);
  if (pkCol) {
    const idx = state.created.findIndex((r) => looseEq(r[pkCol], pk));
    if (idx >= 0) {
      const row = { ...data };
      if (columns.some((c) => c.name === 'updated_at')) row.updated_at = new Date().toISOString();
      state.created[idx] = row;
      return row;
    }
  }
  const row = { ...data };
  if (columns.some((c) => c.name === 'updated_at')) row.updated_at = new Date().toISOString();
  state.updated.set(pk, row);
  return row;
}

export function mockDelete(schema, table, columns, pk) {
  const state = getOrInit(schema, table);
  const pkCol = detectPk(columns);
  if (pkCol) {
    const idx = state.created.findIndex((r) => looseEq(r[pkCol], pk));
    if (idx >= 0) {
      state.created.splice(idx, 1);
      return { ok: true };
    }
  }
  state.updated.delete(pk);
  state.deleted.add(pk);
  return { ok: true };
}

export function applyClientCrud(rows, schema, table) {
  const state = store.get(key(schema, table));
  if (!state) return rows;
  const pkCol = rows.length > 0 ? detectPkFromRow(rows[0]) : null;
  if (!pkCol) return [...state.created, ...rows];

  const filtered = rows.filter((r) => !setHasLoose(state.deleted, r[pkCol]));
  const replaced = filtered.map((r) => {
    const pk = r[pkCol];
    return mapGetLoose(state.updated, pk) || r;
  });
  return [...state.created, ...replaced];
}

export function mockCountDelta(schema, table) {
  const state = store.get(key(schema, table));
  if (!state) return 0;
  return state.created.length - state.deleted.size;
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}
function setHasLoose(set, value) {
  if (set.has(value)) return true;
  for (const v of set) if (looseEq(v, value)) return true;
  return false;
}
function mapGetLoose(map, key) {
  if (map.has(key)) return map.get(key);
  for (const [k, v] of map) if (looseEq(k, key)) return v;
  return null;
}
