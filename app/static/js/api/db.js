// Обёртки над /api/db/*. Не трогают DOM. Все ошибки идут как ApiError.
import { request } from './client.js';
import {
  USE_MOCK_FILTERS, USE_MOCK_CRUD,
  USE_MOCK_RELATIONS, USE_MOCK_CASCADE,
  USE_MOCK_EXPORT,
} from '../mocks/index.js';
import { applyClientFilters } from '../mocks/db-filters.js';
import {
  applyClientCrud,
  mockCountDelta,
  mockCreate,
  mockUpdate,
  mockDelete,
} from '../mocks/db-crud.js';
import { mockOutboundRelations } from '../mocks/db-relations.js';
import { mockPreviewCascade } from '../mocks/db-cascade.js';
import { rowsToCsv } from '../utils/csv.js';

const enc = encodeURIComponent;

export async function getSchemas(opts = {}) {
  const data = await request('/api/db/schemas', opts);
  return data?.schemas || [];
}

export async function getTables(schema, opts = {}) {
  const data = await request(`/api/db/${enc(schema)}/tables`, opts);
  return data?.tables || [];
}

export async function getColumns(schema, table, opts = {}) {
  const data = await request(`/api/db/${enc(schema)}/${enc(table)}/columns`, opts);
  return data?.columns || [];
}

export async function listRows(
  { schema, table, limit = 50, offset = 0, orderBy = null, filters = [] } = {},
  opts = {},
) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (orderBy) params.set('order_by', orderBy);

  const useMockOverlay = USE_MOCK_FILTERS || USE_MOCK_CRUD;

  if (useMockOverlay) {
    // TODO(backend): P-001 + P-002 — снять флаги и убрать локальные оверлеи.
    const data = await request(
      `/api/db/${enc(schema)}/${enc(table)}/rows?${params}`,
      opts,
    );
    let rows = data?.rows || [];
    let total = typeof data?.total === 'number' ? data.total : null;

    if (USE_MOCK_CRUD) {
      rows = applyClientCrud(rows, schema, table);
      if (total !== null) total = Math.max(0, total + mockCountDelta(schema, table));
    }
    const beforeFilterCount = rows.length;
    if (USE_MOCK_FILTERS) rows = applyClientFilters(rows, filters);

    return {
      columns: data?.columns || [],
      rows,
      total,
      limit: data?.limit ?? limit,
      offset: data?.offset ?? offset,
      filterMode: USE_MOCK_FILTERS ? 'client' : 'server',
      pageRowsBeforeFilter: USE_MOCK_FILTERS ? beforeFilterCount : null,
    };
  }

  if (filters?.length) params.set('filter', JSON.stringify(filters));
  const data = await request(`/api/db/${enc(schema)}/${enc(table)}/rows?${params}`, opts);
  return {
    columns: data?.columns || [],
    rows: data?.rows || [],
    total: typeof data?.total === 'number' ? data.total : null,
    limit: data?.limit ?? limit,
    offset: data?.offset ?? offset,
    filterMode: 'server',
    pageRowsBeforeFilter: null,
  };
}

// ----- CRUD (P-001) -----

export async function createRow(schema, table, data, columns = [], opts = {}) {
  if (USE_MOCK_CRUD) {
    // TODO(backend): P-001 — заменить на POST /api/db/{schema}/{table}
    return mockCreate(schema, table, columns, data);
  }
  return request(`/api/db/${enc(schema)}/${enc(table)}`, {
    method: 'POST',
    body: data,
    ...opts,
  });
}

export async function updateRow(schema, table, pk, data, columns = [], opts = {}) {
  if (USE_MOCK_CRUD) {
    // TODO(backend): P-001 — заменить на PATCH /api/db/{schema}/{table}/{pk}
    return mockUpdate(schema, table, columns, pk, data);
  }
  return request(`/api/db/${enc(schema)}/${enc(table)}/${enc(String(pk))}`, {
    method: 'PATCH',
    body: data,
    ...opts,
  });
}

export async function updateField(schema, table, pk, column, value, prevRow, columns = [], opts = {}) {
  if (USE_MOCK_CRUD) {
    // TODO(backend): P-001 — заменить на PATCH /api/db/{schema}/{table}/{pk}
    const next = { ...prevRow, [column]: value };
    return mockUpdate(schema, table, columns, pk, next);
  }
  return request(`/api/db/${enc(schema)}/${enc(table)}/${enc(String(pk))}`, {
    method: 'PATCH',
    body: { [column]: value },
    ...opts,
  });
}

export async function deleteRow(schema, table, pk, columns = [], opts = {}) {
  if (USE_MOCK_CRUD) {
    // TODO(backend): P-001 — заменить на DELETE /api/db/{schema}/{table}/{pk}
    return mockDelete(schema, table, columns, pk);
  }
  return request(`/api/db/${enc(schema)}/${enc(table)}/${enc(String(pk))}`, {
    method: 'DELETE',
    ...opts,
  });
}

// ----- Import (M7) -----

// Импорт одиночного CSV через `COPY FROM STDIN` на бэке. Передаём multipart;
// браузер сам выставит boundary в Content-Type, request() это поддерживает.
// timeout=0 — отключаем дефолтные 30s, импорт большого файла может тянуться;
// отмена доступна через operations-indicator (trackAs).
export async function importCsv({ schema, table, file, mode = 'append', delimiter = ',', encoding = 'utf-8' }, opts = {}) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('schema', schema);
  fd.append('table', table);
  fd.append('mode', mode);
  fd.append('delimiter', delimiter);
  fd.append('encoding', encoding);
  return request('/api/db/import/csv', {
    method: 'POST',
    body: fd,
    timeout: 0,
    ...opts,
  });
}

// Связанный датасет (M8). Бэк ждёт фиксированный набор файловых полей
// (см. dataset-mapping.js). `files` — `{ field: File }`; недостающие/пустые
// поля приведут к 422 на стороне бэка. `dry_run=true` — пройти валидацию
// и подготовку без INSERT'ов; `replace_mode=true` — очистка целевых таблиц
// перед вставкой.
export async function importDataset({ files, replaceMode = false, dryRun = false }, opts = {}) {
  const fd = new FormData();
  for (const [field, file] of Object.entries(files)) {
    if (file) fd.append(field, file);
  }
  fd.append('replace_mode', String(!!replaceMode));
  fd.append('dry_run', String(!!dryRun));
  return request('/api/db/import/dataset', {
    method: 'POST',
    body: fd,
    timeout: 0,
    ...opts,
  });
}

export async function getDatasetStatus(opts = {}) {
  return request('/api/db/import/dataset/status', opts);
}

// ----- Export CSV (P-005) -----

// Возвращает { csv, source, truncated }, не файл — вызывающий код сам
// формирует Blob и триггерит браузерный download.
//
// В mock-режиме (USE_MOCK_EXPORT=true) синтезирует CSV из текущих rows +
// columns (`fallback`) — это «экспорт текущей страницы», бэк ещё не отдаёт
// `export.csv`. UI обязан показать warning, что выгружено не всё.
//
// В реальном режиме идёт `GET /api/db/{schema}/{table}/export.csv` с теми же
// фильтрами / order_by, что и `listRows`. Бэк отдаёт text/csv стримом.
export async function exportCsv({ schema, table, filters = [], orderBy = null, fallback = null }, opts = {}) {
  if (USE_MOCK_EXPORT) {
    // TODO(backend): P-005 — заменить на GET /api/db/{schema}/{table}/export.csv
    if (!fallback || !Array.isArray(fallback.rows) || !Array.isArray(fallback.columns)) {
      throw new Error('mock export требует fallback={rows, columns}');
    }
    const csv = rowsToCsv(fallback.rows, fallback.columns);
    return { csv, source: 'mock', truncated: true };
  }
  const params = new URLSearchParams();
  if (orderBy) params.set('order_by', orderBy);
  if (filters?.length) params.set('filter', JSON.stringify(filters));
  const qs = params.toString();
  const csv = await request(
    `/api/db/${enc(schema)}/${enc(table)}/export.csv${qs ? `?${qs}` : ''}`,
    opts,
  );
  return { csv: typeof csv === 'string' ? csv : String(csv ?? ''), source: 'server', truncated: false };
}

// ----- Foreign Keys (P-003) -----

export async function getRelations(schema, table, opts = {}) {
  if (USE_MOCK_RELATIONS) {
    // TODO(backend): P-003 — replace mock with GET /api/db/{schema}/{table}/relations
    return mockOutboundRelations(schema, table);
  }
  const data = await request(`/api/db/${enc(schema)}/${enc(table)}/relations`, opts);
  return Array.isArray(data) ? data : (data?.relations || []);
}

// ----- Cascade preview (P-004) -----

export async function previewCascade(schema, table, pk, opts = {}) {
  if (USE_MOCK_CASCADE) {
    // TODO(backend): P-004 — replace mock with GET /api/db/{schema}/{table}/{pk}/dependencies
    return mockPreviewCascade({
      schema, table, pkValue: pk,
      // Передаём listRows: он сам разрулит mock-оверлеи (db-crud + db-filters).
      // Не передаём opts.trackAs внутрь — каждое сканирование таблицы трекать
      // отдельно слишком шумно; общая операция трекается снаружи (handleDelete).
      listRowsRaw: (args) => listRows(args),
    });
  }
  return request(
    `/api/db/${enc(schema)}/${enc(table)}/${enc(String(pk))}/dependencies`,
    opts,
  );
}
