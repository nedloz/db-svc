// Mock для P-004 — cascade preview перед удалением.
// Берёт INBOUND-карту FK (см. db-relations.js) и для каждой ссылающейся
// таблицы запрашивает её строки с фильтром «column = pk» (через переданный
// listRowsRaw, который уже умеет применять mock-оверлеи). Возвращает дерево:
// { total, by_table: [{ schema, table, column, count, on_delete, samples, truncated }] }.
//
// ВАЖНО: это не «правда из БД», а приблизительная картина в пределах того,
// что фронт мог увидеть (см. ограничения USE_MOCK_FILTERS / USE_MOCK_CRUD).
// UI это честно подсвечивает баннером.

import { mockInboundRelations } from './db-relations.js';

const SAMPLE_LIMIT = 500; // = верхний лимит бэка для /rows
const SAMPLES_PREVIEW = 3;

export async function mockPreviewCascade({ schema, table, pkValue, listRowsRaw }) {
  const inbound = mockInboundRelations(schema, table);
  const byTable = [];
  let total = 0;
  let approximate = false;

  for (const rel of inbound) {
    let count = 0;
    let samples = [];
    let truncated = false;
    let error = null;
    try {
      const data = await listRowsRaw({
        schema: rel.schema, table: rel.table,
        limit: SAMPLE_LIMIT, offset: 0,
        filters: [{ column: rel.column, op: 'eq', value: pkValue }],
      });
      count = data.rows.length;
      samples = data.rows.slice(0, SAMPLES_PREVIEW);
      if (count >= SAMPLE_LIMIT) {
        truncated = true;
        approximate = true;
      }
    } catch (err) {
      error = err?.message || String(err);
      approximate = true;
    }

    if (count > 0 || rel.on_delete === 'NO ACTION' || rel.on_delete === 'RESTRICT' || error) {
      byTable.push({
        schema: rel.schema, table: rel.table, column: rel.column,
        count, on_delete: rel.on_delete, samples, truncated, error,
      });
      total += count;
    }
  }

  return { total, by_table: byTable, approximate };
}
