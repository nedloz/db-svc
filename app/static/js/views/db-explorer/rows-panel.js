// Панель строк: data-table с типизированным рендером + пагинация.
// Сортировка — клик по заголовку: первый клик ставит order_by на колонку,
// второй клик снимает. Направление сейчас всегда asc, см. P-002.
//
// M5: на data-table проброшены rowKey/selection (для bulk-delete) и
// onCellEdit (для inline-edit). Колонки PK / auto-managed редактировать нельзя
// (бэк P-001 пока не отдаёт PATCH с переименованием PK, мок тоже не поддерживает).
// M6: FK-колонки рендерятся как ссылки → переход к связанной записи.
import { createDataTable } from '../../components/data-table.js';
import { createPagination } from '../../components/pagination.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { createEmptyState } from '../../components/empty-state.js';
import { formatCell } from '../../utils/format.js';
import { categorizePgType } from '../../utils/types.js';
import { detectPkColumn, detectPkValue } from '../../utils/pk.js';
import { USE_MOCK_CRUD } from '../../mocks/index.js';

const AUTO_MANAGED = new Set(['id', 'created_at', 'updated_at']);

export function mountRowsPanel({ container, store, onPageChange, onSortChange, onRowClick, onCellEdit, onSelectionChange, onFkClick }) {
  const wrap = document.createElement('div');
  wrap.className = 'rows-panel';
  container.replaceChildren(wrap);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const {
      selection, columns, rows, rowsTotal,
      page, pageSize, orderBy,
      filters, filterMode, pageRowsBeforeFilter,
      selectedPks,
      outboundRelations,
      loading, errors,
    } = store.get();
    const fkByColumn = new Map();
    for (const rel of (outboundRelations || [])) fkByColumn.set(rel.column, rel);

    wrap.replaceChildren();
    if (!selection) return;

    if (errors.rows) {
      wrap.append(createErrorView(errors.rows));
      return;
    }
    if (loading.rows && !rows.length) {
      wrap.append(createLoader({ label: 'Загружаю строки…' }));
      return;
    }
    if (!columns.length) {
      wrap.append(createLoader({ label: 'Готовлю таблицу…' }));
      return;
    }

    if (USE_MOCK_CRUD) {
      const mockBanner = document.createElement('div');
      mockBanner.className = 'rows-panel__notice';
      mockBanner.textContent =
        'ℹ Mock CRUD (P-001): создание / изменение / удаление работают только в памяти ' +
        'браузера и пропадут после reload. Бэк-эндпоинты ещё не подключены.';
      wrap.append(mockBanner);
    }

    if (filters.length && filterMode === 'client') {
      const banner = document.createElement('div');
      banner.className = 'rows-panel__warning';
      const before = pageRowsBeforeFilter ?? '?';
      banner.textContent =
        `⚠ Серверной фильтрации пока нет (P-002, mock). ` +
        `Показано ${rows.length} из ${before} строк на текущей странице — ` +
        `другие страницы не сканируются. Чтобы просмотреть всю таблицу под фильтром, ` +
        `листайте страницы вручную.`;
      wrap.append(banner);
    }

    const pkColumn = detectPkColumn(columns);

    const tableColumns = columns.map((col) => {
      const cat = categorizePgType(col.type);
      const isPk = col.name === pkColumn;
      const isAuto = AUTO_MANAGED.has(col.name);
      const fk = fkByColumn.get(col.name) || null;
      const editable = !!onCellEdit && !isPk && !isAuto && !fk && cat !== 'vector' && cat !== 'binary' && cat !== 'array';

      return {
        key: col.name,
        label: fk ? `${col.name} ↗` : col.name,
        sortable: true,
        render: fk
          ? (value, row) => renderFkCell(value, row, col, fk, onFkClick)
          : (value) => formatCell(value, col.type),
        editable,
        editKind: pickEditKind(cat),
        parse: editable ? (raw) => parseCellValue(raw, col, cat) : null,
      };
    });

    const empty = !rows.length
      ? createEmptyState({
          title: 'Строк нет',
          description: filters.length
            ? 'На текущей странице нет совпадений с фильтрами.'
            : 'В таблице нет данных под текущими параметрами.',
        })
      : null;

    const table = createDataTable({
      columns: tableColumns,
      rows,
      sort: orderBy ? { key: orderBy } : null,
      onSortChange,
      onRowClick,
      onCellEdit,
      rowKey: (row) => detectPkValue(row, columns),
      selection: selectedPks,
      onSelectionChange,
      emptyState: empty,
    });

    const pagination = createPagination({
      page,
      pageSize,
      total: rowsTotal,
      onChange: onPageChange,
    });

    wrap.append(table, pagination);
  }

  return () => unsubscribe();
}

function renderFkCell(value, row, col, fk, onFkClick) {
  if (value === null || value === undefined) {
    const span = document.createElement('span');
    span.className = 'cell--muted';
    span.textContent = '—';
    span.title = `NULL → ${fk.references.schema}.${fk.references.table}`;
    return span;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn fk-link';
  btn.textContent = String(value);
  btn.title = `Перейти к ${fk.references.schema}.${fk.references.table} по ${fk.references.column}=${value}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onFkClick?.({
      schema: fk.references.schema,
      table: fk.references.table,
      column: fk.references.column,
      value,
    });
  });
  return btn;
}

function pickEditKind(cat) {
  if (cat === 'bool') return 'checkbox';
  if (cat === 'text' || cat === 'json') return 'textarea';
  return 'input';
}

function parseCellValue(raw, col, cat) {
  if (cat === 'bool') return !!raw;
  const str = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  if (str === '') {
    if (!col.nullable) throw new Error('Поле NOT NULL — пустое значение не допускается');
    return null;
  }
  if (cat === 'number') {
    const n = Number(str);
    if (!Number.isFinite(n)) throw new Error('Должно быть число');
    return n;
  }
  if (cat === 'json') {
    try { return JSON.parse(str); }
    catch (_e) { throw new Error('Невалидный JSON'); }
  }
  if (cat === 'datetime') {
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) throw new Error('Невалидная дата');
    return d.toISOString();
  }
  return str;
}
