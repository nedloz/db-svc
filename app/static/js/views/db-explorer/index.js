// Вкладка «База данных». Композиция: sidebar + content (info / columns / rows).
// Состояние локально для view (createStore), не лезет в глобальный store.
//
// Этапы M1–M6 готовы для db-explorer (паритет + типы + детали + фильтры +
// индикация + CRUD + FK/cascade). M10 добавил кнопку Export CSV рядом с
// фильтрами (mock-режим: выгрузка текущей страницы; реальный fetch уже
// написан рядом с моком).
import { createStore } from '../../state/store.js';
import {
  getSchemas, getTables, getColumns, getColumnEnums, listRows,
  createRow, updateRow, updateField, deleteRow,
  getRelations, previewCascade, exportCsv,
} from '../../api/db.js';
import { detectPkValue } from '../../utils/pk.js';

import { mountSidebar } from './sidebar.js';
import { mountTableInfo } from './table-info.js';
import { mountFiltersPanel } from './filters.js';
import { mountRowsPanel } from './rows-panel.js';
import { buildRowsControls } from './rows-controls.js';
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

// Состояние вкладки живёт на уровне модуля (singleton), чтобы переживать
// размонтирование при переходе на другую вкладку. Возврат на «База данных»
// восстанавливает выбранную таблицу, строки, фильтры — как было.
let dbStore = null;

function initialDbState() {
  return {
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
    orderDir: null,                 // 'asc' | 'desc' | null
    filters: [],                    // [{ column, op, value }]
    filterMode: null,               // 'client' | 'server' | null
    pageRowsBeforeFilter: null,
    selectedPks: new Set(),         // bulk-select (зарезервировано, чекбоксы убраны из UI)
    activePk: null,                 // активная строка (одиночный клик)
    editingPk: null,                // редактируемая строка (✎)
    columnTools: false,             // режим «инструменты колонок» (треугольники в шапке)
    cellMode: 'fit',                // 'fit' | 'ellipsis' | 'wrap' — режим отображения ячеек
    valueFilters: {},               // {colKey: { include: Set<string> }} из sort-modal
    columnEnums: {},                // {col: [values]} из бэка (P-011)
    outboundRelations: [],
    rowSearch: '',
    loading: { schemas: false, tables: null, columns: false, rows: false, relations: false },
    errors:  { schemas: null, tables: null, columns: null, rows: null, relations: null },
  };
}

function mountDbExplorer(container) {
  const store = dbStore || (dbStore = createStore(initialDbState()));
  // editingPk не восстанавливаем — оверлей редактирования закрываем при уходе.
  if (store.get().editingPk != null) store.set({ editingPk: null });

  const layout = buildLayout();
  container.replaceChildren(layout.root);

  // Шапка rows-card: «Навигация по БД» + Обновить, потом контролы, потом таблица.
  const rowsHeader = document.createElement('div');
  rowsHeader.className = 'card__header';
  const rowsTitle = document.createElement('h2');
  rowsTitle.className = 'card__title';
  rowsTitle.textContent = 'Навигация по БД';
  const rowsRefresh = document.createElement('button');
  rowsRefresh.type = 'button';
  rowsRefresh.className = 'btn';
  rowsRefresh.textContent = 'Обновить';
  rowsRefresh.addEventListener('click', () => loadRows());
  rowsHeader.append(rowsTitle, rowsRefresh);

  const rowsControls = buildRowsControls({
    onSearch: (value) => {
      // Клиентский поиск по строкам — сохраняем в локальный store как «rowSearch»,
      // rows-panel сам отфильтрует видимые строки. (Серверный полный поиск —
      // через панель фильтров.)
      store.set({ rowSearch: value.trim().toLowerCase() });
    },
    onLoad: loadRows,
    onClear: () => { clearFilters(); store.set({ rowSearch: '' }); },
    getLimit: () => store.get().pageSize,
    getOffset: () => (store.get().page - 1) * store.get().pageSize,
    onLimitChange: (v) => { store.set({ pageSize: v, page: 1 }); loadRows(); },
    onOffsetChange: (v) => {
      const ps = store.get().pageSize;
      const newPage = Math.max(1, Math.floor(v / ps) + 1);
      store.set({ page: newPage }); loadRows();
    },
    getPagination: () => {
      const { page, pageSize, rowsTotal } = store.get();
      const totalPages = rowsTotal !== null ? Math.max(1, Math.ceil(rowsTotal / pageSize)) : null;
      return { page, totalPages };
    },
    onPrev: () => {
      const { page } = store.get();
      if (page <= 1) return;
      onPageChange({ page: page - 1, pageSize: store.get().pageSize });
    },
    onNext: () => {
      const { page, pageSize, rowsTotal } = store.get();
      if (rowsTotal !== null && page >= Math.ceil(rowsTotal / pageSize)) return;
      onPageChange({ page: page + 1, pageSize });
    },
    onToggleFilters: () => { layout.filtersPanel.classList.toggle('is-hidden'); },
    onExport: () => handleExport(),
    onToggleEdit: () => handleToggleEdit(),
    getEditState: () => ({
      hasActive: store.get().activePk != null,
      isEditing: store.get().editingPk != null,
    }),
    onToggleColumnTools: () => store.set({ columnTools: !store.get().columnTools }),
    getColumnToolsState: () => store.get().columnTools,
    onCycleCellMode: () => {
      const order = ['fit', 'ellipsis', 'wrap'];
      const next = order[(order.indexOf(store.get().cellMode) + 1) % order.length];
      store.set({ cellMode: next });
    },
    getCellMode: () => store.get().cellMode,
  });

  // По умолчанию панель фильтров скрыта — открывается через ⛛-кнопку.
  layout.filtersPanel.classList.add('is-hidden');

  layout.rowsCard.append(rowsHeader, rowsControls.el, layout.filtersPanel, layout.rowsPanel);

  // Контролы зависят от store (pageSize / page / total) — обновляем при изменениях.
  const unsubControls = store.subscribe(() => rowsControls.update());

  const unmounters = [
    mountSidebar({
      container: layout.sidebar,
      store,
      api: {
        getTables: (schema) => getTables(schema, { trackAs: `Таблицы ${schema}` }),
      },
      onSelect: selectTable,
      onRefresh: loadSchemas,
    }),
    mountTableInfo({
      container: layout.info,
      store,
      onCreateRow: handleCreate,
      onDeleteSelected: handleDeleteSelected,
      onRefresh: () => { loadColumns(); loadRows(); },
    }),
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
      onRowClick: openDetailsForRow,                  // dblclick → детали
      onActiveRowChange: handleActiveRowChange,       // click → активная
      onRowEditCommit: handleRowEditCommit,
      onRowEditCancel: () => store.set({ editingPk: null }),
      onRowDelete: (row) => { store.set({ editingPk: null }); handleDelete(row); },
      onSortChange: handleSortChange,
      onValueFilterChange: handleValueFilterChange,
      onSelectionChange: handleSelectionChange,
      onFkClick: navigateToRelated,
    }),
  ];

  // Грузим схемы только при первом открытии. При возврате на вкладку —
  // состояние уже в store, повторный fetch не нужен (есть кнопка «Обновить»).
  if (!store.get().schemas.length) loadSchemas();

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
      orderDir: null,
      filters: opts.filters || [],
      filterMode: null,
      pageRowsBeforeFilter: null,
      columns: [],
      rows: [],
      rowsTotal: null,
      selectedPks: new Set(),
      activePk: null,
      editingPk: null,
      valueFilters: {},
      columnEnums: {},
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

    // P-011: допустимые значения колонок (для выпадающих списков). Не блокирует.
    getColumnEnums(sel.schema, sel.table)
      .then((columnEnums) => {
        const cur = store.get().selection;
        if (!cur || cur.schema !== sel.schema || cur.table !== sel.table) return;
        store.set({ columnEnums: columnEnums || {} });
      })
      .catch(() => { /* не критично — fallback на mocks/db-enums.js */ });
  }

  function loadRows() {
    const { selection, page, pageSize, orderBy, orderDir, filters } = store.get();
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
        orderDir,
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
    store.set({ page, pageSize, selectedPks: new Set(), activePk: null, editingPk: null });
    loadRows();
  }

  function handleSortChange(key, dir) {
    store.set({
      orderBy: dir ? key : null,
      orderDir: dir || null,
      page: 1,
      selectedPks: new Set(),
      activePk: null,
      editingPk: null,
    });
    loadRows();
  }

  function handleValueFilterChange(colKey, valueFilter) {
    const cur = store.get().valueFilters || {};
    const next = { ...cur };
    if (!valueFilter) delete next[colKey];
    else next[colKey] = valueFilter;
    store.set({ valueFilters: next });
  }

  function handleActiveRowChange(pk) {
    // Если идёт edit — не позволяем переключать активную строку.
    if (store.get().editingPk != null) return;
    store.set({ activePk: pk });
  }

  function handleToggleEdit() {
    const { activePk, editingPk } = store.get();
    if (editingPk != null) {
      // Уже редактируем — кнопка работает как «отмена».
      store.set({ editingPk: null });
      return;
    }
    if (activePk == null) {
      toast.warn('Сначала выберите строку (клик)');
      return;
    }
    store.set({ editingPk: activePk });
  }

  async function handleRowEditCommit(row, changes) {
    const { selection, columns } = store.get();
    if (!selection) return;
    if (!Object.keys(changes).length) {
      store.set({ editingPk: null });
      return;
    }
    const pk = detectPkValue(row, columns);
    if (pk == null) {
      toast.error('Не удалось определить первичный ключ строки');
      throw new Error('no pk');
    }
    try {
      // TODO(backend): P-001 — серия PATCH'ей по полям. Сейчас updateField — mock-friendly.
      for (const [column, value] of Object.entries(changes)) {
        await updateField(selection.schema, selection.table, pk, column, value, row, columns, {
          trackAs: `Поле ${column} в ${selection.schema}.${selection.table}`,
        });
      }
      toast.success(`Сохранено полей: ${Object.keys(changes).length}`);
      store.set({ editingPk: null });
      loadRows();
    } catch (err) {
      toast.error(err?.message || 'Ошибка сохранения');
      throw err;
    }
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
    const { selection, columns, outboundRelations, columnEnums } = store.get();
    if (!selection) { toast.warn('Сначала выберите таблицу'); return; }
    if (!columns.length) { toast.warn('Колонки ещё не загружены'); return; }
    // TODO(backend): P-001 — POST /api/db/{schema}/{table}; сейчас mock-in-memory.
    openRowForm({
      mode: 'create',
      columns,
      selection,
      relations: outboundRelations,
      enums: columnEnums,
      onSubmit: async (data) => {
        await createRow(selection.schema, selection.table, data, columns, {
          trackAs: `Создание в ${selection.schema}.${selection.table}`,
        });
        toast.success('Строка создана');
        loadRows();
      },
    });
  }

  function handleEdit(row) {
    const { selection, columns, outboundRelations, columnEnums } = store.get();
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
      enums: columnEnums,
      onSubmit: async (data) => {
        await updateRow(selection.schema, selection.table, pk, data, columns, {
          trackAs: `Обновление ${selection.schema}.${selection.table}`,
        });
        toast.success('Строка обновлена');
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
        toast.success('Строка удалена');
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
        toast.success(`Удалено: ${pks.length}`);
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

  return () => {
    try { unsubControls?.(); } catch (_e) { /* swallow */ }
    for (const off of unmounters) {
      try { off?.(); } catch (_e) { /* swallow */ }
    }
  };
}

function triggerCsvDownload(csv, schema, table) {
  // BOM добавляет бэк (export_csv_text). Здесь не дублируем.
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
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
  // Контейнер использует display: contents, реальная сетка — на .app-main.
  const root = document.createElement('div');
  root.className = 'db-explorer';

  // Левая карточка — навигация по схемам.
  const sidebar = document.createElement('section');
  sidebar.className = 'card db-explorer__sidebar';

  // Правая карточка — Текущая таблица: info + columns.
  const info = document.createElement('section');
  info.className = 'card db-explorer__info';

  // Колонки и фильтры монтируются внутрь info/rows-card соответственно.
  const columnsPanel = document.createElement('div');
  columnsPanel.className = 'db-explorer__columns-slot';

  // Нижняя широкая карточка — строки + фильтры + пагинация.
  const rowsCard = document.createElement('section');
  rowsCard.className = 'card db-explorer__rows-card';

  const filtersPanel = document.createElement('div');
  filtersPanel.className = 'db-explorer__filters-slot';

  const rowsPanel = document.createElement('div');
  rowsPanel.className = 'db-explorer__rows-slot';

  root.append(sidebar, info, rowsCard);
  return {
    root,
    sidebar,
    info,
    columnsPanel,   // монтируется внутрь info через mountTableInfo
    rowsCard,
    filtersPanel,   // монтируется внутрь rowsCard
    rowsPanel,      // монтируется внутрь rowsCard
  };
}
