// Панель строк: data-table с типизированным рендером.
// Клик по строке — активная строка, дабл-клик — модалка деталей.
// Сортировка — клик по заголовку открывает sort-modal (см. ./sort-modal.js).
// Inline row edit — управляется через editingPk из store; data-table сам
// рендерит редактируемый ряд с input / dropdown / readonly.
//
// Enum-колонки (col.type === 'USER-DEFINED') рендерятся в edit-режиме как
// disabled <select> с треугольником — UI-намёк, что значение из набора.
// Реальный список значений придёт с P-011.

import { createDataTable } from '../../components/data-table.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { createEmptyState } from '../../components/empty-state.js';
import { formatCell } from '../../utils/format.js';
import { categorizePgType } from '../../utils/types.js';
import { detectPkColumn, detectPkValue, pkKey } from '../../utils/pk.js';
import { getColumnEnum } from '../../mocks/db-enums.js';
import { openSortModal } from './sort-modal.js';
import { buildRowEditBar } from './row-edit-bar.js';

const AUTO_MANAGED = new Set(['id', 'created_at', 'updated_at']);

export function mountRowsPanel({
  container, store,
  onRowClick,                  // dblclick → детали
  onActiveRowChange,           // click → активная строка
  onRowEditCommit,             // ok → сохранить изменения
  onRowEditCancel,             // очистить → выйти из edit
  onRowDelete,                 // удалить → каскадное удаление активной строки
  onSortChange,                // (key, dir) → сортировка
  onValueFilterChange,         // (column, valueFilter) → фильтр по значениям
  onSelectionChange,
  onFkClick,
}) {
  const wrap = document.createElement('div');
  wrap.className = 'rows-panel';
  container.replaceChildren(wrap);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const {
      selection, columns, rows,
      orderBy, orderDir,
      filters, filterMode, pageRowsBeforeFilter,
      activePk, editingPk, columnTools, cellMode,
      outboundRelations, columnEnums,
      rowSearch,
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

    if (filters.length && filterMode === 'client') {
      const banner = document.createElement('div');
      banner.className = 'rows-panel__warning';
      const before = pageRowsBeforeFilter ?? '?';
      banner.textContent =
        `⚠ Серверной фильтрации пока нет (P-002, mock). ` +
        `Показано ${rows.length} из ${before} строк на текущей странице.`;
      wrap.append(banner);
    }

    const pkColumn = detectPkColumn(columns);

    const tableColumns = columns.map((col) => {
      const cat = categorizePgType(col.type);
      const isPk = col.name === pkColumn;
      const isAuto = AUTO_MANAGED.has(col.name);
      const fk = fkByColumn.get(col.name) || null;
      // Допустимые значения: сперва с бэка (P-011), иначе хардкод-карта (fallback).
      const enumValues = (columnEnums && columnEnums[col.name])
        || getColumnEnum(selection.schema, selection.table, col.name);
      // Что считается «можно править» — все основные типы.
      // FK мы пока не редактируем inline (есть отдельная форма с fk-picker).
      // Vector / binary / array — нет.
      const editable = !isPk && !isAuto && !fk
        && cat !== 'vector' && cat !== 'binary' && cat !== 'array';

      return {
        key: col.name,
        label: fk ? `${col.name} ↗` : col.name,
        render: fk
          ? (value, row) => renderFkCell(value, row, col, fk, onFkClick)
          : (value) => formatCell(value, col.type),
        editable,
        // Колонка с CHECK-IN → реальный dropdown; иначе по типу (enum USER-DEFINED
        // без значений останется disabled-заглушкой, см. P-011).
        editKind: enumValues ? 'enum' : pickEditKind(cat),
        enumValues: enumValues || null,
        nullable: !!col.nullable,
        editInputType: cat === 'number' ? 'number' : (cat === 'datetime' ? 'datetime-local' : 'text'),
        parse: editable ? (raw) => parseCellValue(raw, col, cat) : null,
        // Для sort-modal — передаём cat и сам col, чтобы можно было собрать distinct.
        _meta: { cat, col, fk },
      };
    });

    // Клиентский substring-фильтр (общий поиск над таблицей).
    const q = (rowSearch || '').trim().toLowerCase();
    let visibleRows = q
      ? rows.filter((r) => Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q)))
      : rows;

    // Клиентский value-filter из sort-modal: применяется к текущей странице.
    const { valueFilters } = store.get(); // {colKey: { include: Set }}
    if (valueFilters && Object.keys(valueFilters).length) {
      visibleRows = visibleRows.filter((row) => {
        for (const [colKey, vf] of Object.entries(valueFilters)) {
          if (!vf?.include) continue;
          const raw = row[colKey];
          const key = serializeValue(raw);
          if (!vf.include.has(key)) return false;
        }
        return true;
      });
    }

    const empty = !visibleRows.length
      ? createEmptyState({
          title: 'Строк нет',
          description: q
            ? `Под клиентский поиск «${rowSearch}» ничего не подходит на этой странице.`
            : 'На текущей странице нет совпадений.',
        })
      : null;

    const table = createDataTable({
      columns: tableColumns,
      rows: visibleRows,
      sort: orderBy ? { key: orderBy, dir: orderDir || 'asc' } : null,
      onColumnHeaderClick: (col) => handleHeaderClick(col, rows, orderBy, orderDir, valueFilters),
      columnTools: !!columnTools,
      cellMode: cellMode || 'fit',
      onRowClick,
      onActiveRowChange,
      activeRowKey: editingPk != null ? null : activePk,
      // Inline-edit в таблице больше не используем — редактирование в оверлее ниже.
      editingRowKey: null,
      rowKey: (row) => pkKey(detectPkValue(row, columns)),
      emptyState: empty,
    });

    wrap.append(table);

    // Оверлей редактирования (edit.jsx-стиль) поверх таблицы.
    if (editingPk != null) {
      const editRow = rows.find((r) => pkKey(detectPkValue(r, columns)) === editingPk);
      if (editRow) {
        wrap.append(buildRowEditBar({
          columns: tableColumns,
          row: editRow,
          onCommit: onRowEditCommit,
          onCancel: onRowEditCancel,
          onDelete: onRowDelete,
        }));
      }
    }
  }

  function handleHeaderClick(col, allRows, orderBy, orderDir, valueFilters) {
    const currentSort = orderBy === col.key ? { key: col.key, dir: orderDir || 'asc' } : null;
    const currentValueFilter = (valueFilters || {})[col.key] || null;
    openSortModal({
      column: col,
      currentSort,
      currentValueFilter,
      rows: allRows,
      onApply: ({ sortDir, valueFilter }) => {
        onSortChange?.(col.key, sortDir);
        onValueFilterChange?.(col.key, valueFilter);
      },
    });
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
  btn.className = 'fk-link data-table__cell-fk';
  btn.textContent = String(value);
  btn.title = `→ ${fk.references.schema}.${fk.references.table} (${fk.references.column}=${value})`;
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
  if (cat === 'enum') return 'enum';
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

function serializeValue(v) {
  if (v === null || v === undefined) return '__NULL__';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}
