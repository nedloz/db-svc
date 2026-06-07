// Карточка «Текущая таблица»: заголовок + статы (Схема / Таблица / Колонок / Строк)
// + таблица колонок. CRUD-кнопки «+ Создать строку» / «Удалить выбранные»
// расположены под статами (пока без отдельного дизайна — следуем общему стилю).

import { shortPgType } from '../../utils/types.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';

export function mountTableInfo({ container, store, onCreateRow, onDeleteSelected, onRefresh }) {
  // ----- Шапка карточки -----
  const header = document.createElement('div');
  header.className = 'card__header';

  const title = document.createElement('h2');
  title.className = 'card__title';
  title.textContent = 'Текущая таблица';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn';
  refreshBtn.textContent = 'Обновить';
  refreshBtn.addEventListener('click', () => { onRefresh?.(); });

  header.append(title, refreshBtn);

  const subtitle = document.createElement('div');
  subtitle.className = 'card__subtitle';
  subtitle.textContent = 'Выбранная таблица и краткая информация';

  // ----- Пилюли статы -----
  const pills = document.createElement('div');
  pills.className = 'table-info__pills';
  const schemaPill = makePill('Схема: —');
  const tablePill = makePill('Таблица: —');
  const colCountPill = makePill('Колонок: —');
  const rowCountPill = makePill('Строк: —');
  pills.append(schemaPill, tablePill, colCountPill, rowCountPill);

  // ----- Действия (Создать / Удалить выбранные) -----
  // По дизайну на info-card нет CRUD-кнопок. Логика остаётся в коде —
  // когда дизайн добавит кнопки, раскомментировать actions.append ниже.
  const actions = document.createElement('div');
  actions.className = 'table-info__actions';

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'btn btn--primary';
  createBtn.textContent = '+ Создать строку';
  createBtn.disabled = true;
  createBtn.addEventListener('click', () => onCreateRow?.());

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--danger';
  delBtn.textContent = 'Удалить выбранные';
  delBtn.disabled = true;
  delBtn.addEventListener('click', () => onDeleteSelected?.());
  // actions.append(createBtn, delBtn);  // скрыто по дизайну

  // ----- Слот под таблицу колонок -----
  const columnsSlot = document.createElement('div');
  columnsSlot.className = 'table-info__columns';

  container.replaceChildren(header, subtitle, pills, columnsSlot);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const { selection, columns, rowsTotal, selectedPks, loading, errors } = store.get();

    if (!selection) {
      schemaPill.textContent = 'Схема: —';
      tablePill.textContent = 'Таблица: —';
      colCountPill.textContent = 'Колонок: —';
      rowCountPill.textContent = 'Строк: —';
      createBtn.disabled = true;
      delBtn.disabled = true;
      delBtn.textContent = 'Удалить выбранные';
      columnsSlot.replaceChildren(makeEmpty('Сначала выбери таблицу'));
      return;
    }

    schemaPill.textContent = `Схема: ${selection.schema}`;
    tablePill.textContent = `Таблица: ${selection.table}`;
    const colCount = loading.columns ? '…' : String(columns.length);
    const rowCount = rowsTotal === null ? (loading.rows ? '…' : '—') : String(rowsTotal);
    colCountPill.textContent = `Колонок: ${colCount}`;
    rowCountPill.textContent = `Строк: ${rowCount}`;

    createBtn.disabled = !columns.length || loading.columns;
    delBtn.disabled = !selectedPks?.size;
    delBtn.textContent = `Удалить выбранные${selectedPks?.size ? ` (${selectedPks.size})` : ''}`;

    // Tабличка колонок
    columnsSlot.replaceChildren();
    if (loading.columns) {
      columnsSlot.append(createLoader({ label: 'Загружаю колонки…' }));
      return;
    }
    if (errors.columns) {
      columnsSlot.append(createErrorView(errors.columns));
      return;
    }
    if (!columns.length) {
      columnsSlot.append(makeEmpty('Нет колонок'));
      return;
    }
    columnsSlot.append(buildColumnsTable(columns));
  }

  return () => unsubscribe();
}

function makePill(text) {
  const el = document.createElement('div');
  el.className = 'stat-pill';
  el.textContent = text;
  return el;
}

function makeEmpty(text) {
  const el = document.createElement('div');
  el.className = 'card__empty';
  el.textContent = text;
  return el;
}

function buildColumnsTable(columns) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';

  const table = document.createElement('table');
  table.className = 'table table--info';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Имя колонки', 'Тип', 'Ключ', 'Null']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const col of columns) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = col.name;
    const td2 = document.createElement('td'); td2.textContent = shortPgType(col.type);
    const td3 = document.createElement('td'); td3.textContent = keyLabel(col);
    const td4 = document.createElement('td'); td4.textContent = col.nullable ? 'nullable' : 'not null';
    tr.append(td1, td2, td3, td4);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function keyLabel(col) {
  if (col.is_pk) return 'PK';
  if (col.is_fk) return 'FK';
  return '—';
}
