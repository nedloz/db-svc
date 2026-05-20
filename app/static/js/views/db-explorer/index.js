// Вкладка «База данных». Композиция: sidebar + content (info / columns / rows).
// Состояние локально для view (createStore), не лезет в глобальный store.
//
// Этапы M1–M6 готовы для db-explorer (паритет + типы + детали + фильтры +
// индикация + CRUD + FK/cascade). M10 добавил кнопку Export CSV рядом с
// фильтрами (mock-режим: выгрузка текущей страницы; реальный fetch уже
// написан рядом с моком).
import { createStore } from '../../state/store.js';
import {
  getSchemas, getTables, getColumns, listRows,
  createRow, updateRow, updateField, deleteRow,
  getRelations, previewCascade, exportCsv,
} from '../../api/db.js';
import { detectPkValue } from '../../utils/pk.js';

import { mountSidebar } from './sidebar.js';
import { mountTableInfo } from './table-info.js';
import { mountColumnsPanel } from './columns-panel.js';
import { mountFiltersPanel } from './filters.js';
import { mountRowsPanel } from './rows-panel.js';
import { openRowDetails } from './row-details.js';
import { openRowForm } from './row-form.js';
import { openConfirmDelete } from './confirm-delete.js';
import { openCascadeModal } from './cascade-modal.js';
import { toast } from '../../components/toast.js';

export const dbExplorerView = {
  title: 'База данных',
  hash: '#/db',
  mount(container) {
    return mountDbExplorer(container);
  },
};

function mountDbExplorer(container) {
  const store = createStore({
    schemas: [],
    tables: {},                     // schema -> string[] (lazy)
    expandedSchemas: new Set(),
    selection: null,                // { schema, table }
    columns: [],
    rows: [],
    rowsTotal: null,
    page: 1,
    pageSize: 50,
    orderBy: null,
    filters: [],                    // [{ column, op, value }]
    filterMode: null,               // 'client' | 'server' | null
    pageRowsBeforeFilter: null,     // сколько было до клиентского фильтра
    selectedPks: new Set(),         // выбранные строки на текущей странице (M5)
    outboundRelations: [],          // FK текущей таблицы (M6, P-003)
    loading: { schemas: false, tables: null, columns: false, rows: false, relations: false },
    errors:  { schemas: null, tables: null, columns: null, rows: null, relations: null },
  });

  const layout = buildLayout();
  container.replaceChildren(layout.root);

  const unmounters = [
    mountSidebar({
      container: layout.sidebar,
      store,
      api: {
        getTables: (schema) => getTables(schema, { trackAs: `Таблицы ${schema}` }),
      },
      onSelect: selectTable,
    }),
    mountTableInfo({
      container: layout.info,
      store,
      onCreateRow: handleCreate,
      onDeleteSelected: handleDeleteSelected,
    }),
    mountColumnsPanel({ container: layout.columnsPanel, store }),
    mountFiltersPanel({
      container: layout.filtersPanel,
      store,
      onApply: applyFilters,
      onClear: clearFilters,
      onExport: handleExport,
    }),
    mountRowsPanel({
      container: layout.rowsPanel,
      store,
      onPageChange,
      onSortChange,
      onRowClick: openDetailsForRow,
      onCellEdit: handleCellEdit,
      onSelectionChange: handleSelectionChange,
      onFkClick: navigateToRelated,
    }),
  ];

  loadSchemas();

  function loadSchemas() {
    patchLoading('schemas', true);
    patchError('schemas', null);
    getSchemas({ trackAs: 'Схемы' })
      .then((schemas) => {
        store.set({ schemas });
        patchLoading('schemas', false);
      })
      .catch((err) => {
        patchLoading('schemas', false);
        patchError('schemas', err);
      });
  }

  function selectTable(schema, table, opts = {}) {
    store.set({
      selection: { schema, table },
      page: 1,
      orderBy: null,
      filters: opts.filters || [],
      filterMode: null,
      pageRowsBeforeFilter: null,
      columns: [],
      rows: [],
      rowsTotal: null,
      selectedPks: new Set(),
      outboundRelations: [],
    });
    loadColumns();
    loadRows();
    loadRelations();
  }

  function loadRelations() {
    const sel = store.get().selection;
    if (!sel) return;
    patchLoading('relations', true);
    patchError('relations', null);
    getRelations(sel.schema, sel.table, { trackAs: `FK ${sel.schema}.${sel.table}` })
      .then((relations) => {
        // Игнорируем устаревший ответ, если пользователь уже переключил таблицу.
        const cur = store.get().selection;
        if (!cur || cur.schema !== sel.schema || cur.table !== sel.table) return;
        store.set({ outboundRelations: relations });
        patchLoading('relations', false);
      })
      .catch((err) => {
        patchLoading('relations', false);
        patchError('relations', err);
      });
  }

  function navigateToRelated({ schema, table, column, value }) {
    // Открыть связанную таблицу с фильтром по PK ссылающейся колонки.
    // Если бэк не отдаёт filter (P-002 mock), фильтрация будет клиентской —
    // rows-panel сам покажет баннер.
    const cur = store.get();
    const expanded = new Set(cur.expandedSchemas);
    expanded.add(schema);
    store.set({ expandedSchemas: expanded });
    selectTable(schema, table, {
      filters: [{ column, op: 'eq', value }],
    });
  }

  function loadColumns() {
    const sel = store.get().selection;
    if (!sel) return;
    patchLoading('columns', true);
    patchError('columns', null);
    getColumns(sel.schema, sel.table, { trackAs: `Колонки ${sel.schema}.${sel.table}` })
      .then((columns) => {
        store.set({ columns });
        patchLoading('columns', false);
      })
      .catch((err) => {
        patchLoading('columns', false);
        patchError('columns', err);
      });
  }

  function loadRows() {
    const { selection, page, pageSize, orderBy, filters } = store.get();
    if (!selection) return;
    patchLoading('rows', true);
    patchError('rows', null);
    const offset = (page - 1) * pageSize;
    listRows(
      {
        schema: selection.schema,
        table: selection.table,
        limit: pageSize,
        offset,
        orderBy,
        filters,
      },
      { trackAs: `Строки ${selection.schema}.${selection.table}` },
    )
      .then((data) => {
        store.set({
          rows: data.rows,
          rowsTotal: data.total,
          filterMode: data.filterMode,
          pageRowsBeforeFilter: data.pageRowsBeforeFilter,
        });
        patchLoading('rows', false);
      })
      .catch((err) => {
        patchLoading('rows', false);
        patchError('rows', err);
      });
  }

  function applyFilters(filters) {
    store.set({ filters, page: 1 });
    loadRows();
  }
  function clearFilters() {
    store.set({ filters: [], page: 1 });
    loadRows();
  }

  function onPageChange({ page, pageSize }) {
    store.set({ page, pageSize, selectedPks: new Set() });
    loadRows();
  }

  function onSortChange({ key }) {
    const cur = store.get().orderBy;
    store.set({ orderBy: cur === key ? null : key, page: 1, selectedPks: new Set() });
    loadRows();
  }

  function handleSelectionChange(nextSet) {
    store.set({ selectedPks: nextSet });
  }

  function patchLoading(key, value) {
    store.set({ loading: { ...store.get().loading, [key]: value } });
  }
  function patchError(key, value) {
    store.set({ errors: { ...store.get().errors, [key]: value } });
  }

  function openDetailsForRow(row) {
    const { selection, columns } = store.get();
    openRowDetails({
      row,
      columns,
      selection,
      onEdit: (r, closeDetails) => { closeDetails?.(); handleEdit(r); },
      onDelete: (r, closeDetails) => { closeDetails?.(); handleDelete(r); },
    });
  }

  function handleCreate() {
    const { selection, columns, outboundRelations } = store.get();
    if (!selection) { toast.warn('Сначала выберите таблицу'); return; }
    if (!columns.length) { toast.warn('Колонки ещё не загружены'); return; }
    // TODO(backend): P-001 — POST /api/db/{schema}/{table}; сейчас mock-in-memory.
    openRowForm({
      mode: 'create',
      columns,
      selection,
      relations: outboundRelations,
      onSubmit: async (data) => {
        await createRow(selection.schema, selection.table, data, columns, {
          trackAs: `Создание в ${selection.schema}.${selection.table}`,
        });
        toast.success('Строка создана (mock — только в памяти браузера)');
        loadRows();
      },
    });
  }

  function handleEdit(row) {
    const { selection, columns, outboundRelations } = store.get();
    if (!selection) return;
    const pk = detectPkValue(row, columns);
    if (pk == null) { toast.error('Не удалось определить первичный ключ строки'); return; }
    // TODO(backend): P-001 — PATCH /api/db/{schema}/{table}/{pk}; сейчас mock.
    openRowForm({
      mode: 'edit',
      columns,
      row,
      selection,
      relations: outboundRelations,
      onSubmit: async (data) => {
        await updateRow(selection.schema, selection.table, pk, data, columns, {
          trackAs: `Обновление ${selection.schema}.${selection.table}`,
        });
        toast.success('Строка обновлена (mock)');
        loadRows();
      },
    });
  }

  function handleDelete(row) {
    const { selection, columns } = store.get();
    if (!selection) return;
    const pk = detectPkValue(row, columns);
    if (pk == null) { toast.error('Не удалось определить первичный ключ строки'); return; }
    // TODO(backend): P-001 — DELETE; P-004 — cascade-preview через previewCascade (mock).
    const previewPromise = previewCascade(selection.schema, selection.table, pk, {
      trackAs: `Cascade-preview ${selection.schema}.${selection.table}`,
    });
    openCascadeModal({
      schema: selection.schema,
      table: selection.table,
      pkValue: pk,
      previewPromise,
      onConfirm: async () => {
        await deleteRow(selection.schema, selection.table, pk, columns, {
          trackAs: `Удаление в ${selection.schema}.${selection.table}`,
        });
        toast.success('Строка удалена (mock)');
        const sel = new Set(store.get().selectedPks);
        sel.delete(pk);
        store.set({ selectedPks: sel });
        loadRows();
      },
    });
  }

  function handleDeleteSelected() {
    const { selection, columns, selectedPks } = store.get();
    if (!selection || !selectedPks.size) return;
    const pks = [...selectedPks];
    // TODO(backend): P-001 — массовое удаление; P-004 — cascade-preview в M6.
    openConfirmDelete({
      pkValue: `${pks.length} строк`,
      bulk: true,
      onConfirm: async () => {
        for (const pk of pks) {
          await deleteRow(selection.schema, selection.table, pk, columns, {
            trackAs: `Удаление ${selection.schema}.${selection.table} (${pk})`,
          });
        }
        toast.success(`Удалено: ${pks.length} (mock)`);
        store.set({ selectedPks: new Set() });
        loadRows();
      },
    });
  }

  async function handleExport(draftFilters) {
    const { selection, columns, rows, orderBy } = store.get();
    if (!selection) { toast.warn('Сначала выберите таблицу'); return; }
    if (!columns.length) { toast.warn('Колонки ещё не загружены'); return; }
    // Если пользователь правил DOM-фильтры, но не нажал «Применить» —
    // используем их черновик (как и при Apply); rows при mock-режиме
    // всё равно будут текущей страницей.
    const filters = Array.isArray(draftFilters) ? draftFilters : store.get().filters;
    try {
      const { csv, source, truncated } = await exportCsv(
        {
          schema: selection.schema,
          table: selection.table,
          filters, orderBy,
          fallback: { rows, columns },
        },
        { trackAs: `Export ${selection.schema}.${selection.table}` },
      );
      triggerCsvDownload(csv, selection.schema, selection.table);
      if (source === 'mock' || truncated) {
        toast.warn('Mock export (P-005): экспортирована только текущая страница. Серверный /export.csv ещё не подключён.');
      } else {
        toast.success('CSV экспортирован');
      }
    } catch (err) {
      toast.error(err?.message || 'Не удалось экспортировать CSV');
    }
  }

  async function handleCellEdit({ row, column, value }) {
    const { selection, columns } = store.get();
    if (!selection) return;
    const pk = detectPkValue(row, columns);
    if (pk == null) { toast.error('Не удалось определить первичный ключ строки'); throw new Error('no pk'); }
    // TODO(backend): P-001 — PATCH /api/db/{schema}/{table}/{pk} с одним полем.
    await updateField(selection.schema, selection.table, pk, column, value, row, columns, {
      trackAs: `Поле ${column} в ${selection.schema}.${selection.table}`,
    });
    toast.success(`Поле ${column} обновлено (mock)`);
    loadRows();
  }

  return () => {
    for (const off of unmounters) {
      try { off?.(); } catch (_e) { /* swallow */ }
    }
  };
}

function triggerCsvDownload(csv, schema, table) {
  // BOM (U+FEFF) — чтобы Excel корректно открывал UTF-8 кириллицу.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${schema}_${table}_${isoDateStamp()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  // Освобождаем URL чуть позже, чтобы скачивание точно стартовало.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isoDateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function buildLayout() {
  const root = document.createElement('div');
  root.className = 'db-explorer';

  const sidebar = document.createElement('aside');
  sidebar.className = 'db-explorer__sidebar';

  const content = document.createElement('div');
  content.className = 'db-explorer__content';

  const info = document.createElement('div');
  info.className = 'db-explorer__info';

  const columnsPanel = document.createElement('div');
  columnsPanel.className = 'db-explorer__columns';

  const filtersPanel = document.createElement('div');
  filtersPanel.className = 'db-explorer__filters';

  const rowsPanel = document.createElement('div');
  rowsPanel.className = 'db-explorer__rows';

  content.append(info, columnsPanel, filtersPanel, rowsPanel);
  root.append(sidebar, content);
  return { root, sidebar, content, info, columnsPanel, filtersPanel, rowsPanel };
}
