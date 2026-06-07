// Сайдбар db-explorer (карточка «Навигация по БД»).
// Дизайн: заголовок + Обновить, поиск + Найти, потом список схем-кнопок;
// раскрытая схема показывает таблицы как chip'ы в сетке 2 колонки.

import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { createEmptyState } from '../../components/empty-state.js';

const FILTER_DEBOUNCE_MS = 200;

export function mountSidebar({ container, store, api, onSelect, onRefresh }) {
  let filterText = '';
  let debounceTimer = null;
  const inflight = new Set();

  // ----- Шапка карточки -----
  const header = document.createElement('div');
  header.className = 'card__header';

  const title = document.createElement('h2');
  title.className = 'card__title';
  title.textContent = 'Навигация по БД';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn';
  refreshBtn.textContent = 'Обновить';
  refreshBtn.addEventListener('click', () => { onRefresh?.(); });

  header.append(title, refreshBtn);

  const subtitle = document.createElement('div');
  subtitle.className = 'card__subtitle';
  subtitle.textContent = 'Выбери схему и таблицу';

  // ----- Поиск -----
  const searchRow = document.createElement('div');
  searchRow.className = 'db-sidebar__search';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input';
  searchInput.placeholder = 'Поиск по схемам';
  searchInput.addEventListener('input', (e) => {
    filterText = e.target.value.trim().toLowerCase();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, FILTER_DEBOUNCE_MS);
  });

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'btn btn--primary';
  searchBtn.textContent = 'Найти';
  searchBtn.addEventListener('click', () => render());

  searchRow.append(searchInput, searchBtn);

  // ----- Список схем -----
  const list = document.createElement('div');
  list.className = 'db-sidebar__list';

  container.replaceChildren(header, subtitle, searchRow, list);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const { schemas, loading, errors } = store.get();
    list.replaceChildren();

    if (loading.schemas) {
      const hint = document.createElement('div');
      hint.className = 'db-sidebar__hint';
      hint.textContent = 'Загружаю схемы…';
      list.append(hint);
      return;
    }
    if (errors.schemas) {
      list.append(createErrorView(errors.schemas));
      return;
    }
    if (!schemas.length) {
      const hint = document.createElement('div');
      hint.className = 'db-sidebar__hint';
      hint.textContent = 'БД не подключена. Структура станет доступна после подключения к базе.';
      list.append(hint);
      return;
    }

    const filtered = filterSchemas(store.get(), filterText);
    if (!filtered.length) {
      list.append(createEmptyState({ title: 'Ничего не найдено' }));
      return;
    }
    for (const schema of filtered) list.append(renderSchema(schema));
  }

  function renderSchema(schema) {
    const { expandedSchemas, tables, selection, loading, errors } = store.get();
    const isExpanded = expandedSchemas.has(schema);

    const node = document.createElement('div');
    node.className = 'db-schema';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'db-schema__head';
    if (isExpanded) head.classList.add('db-schema__head--expanded');
    head.textContent = capitalize(schema);
    head.addEventListener('click', () => toggleSchema(schema));
    node.append(head);

    if (!isExpanded) return node;

    const ts = tables[schema];

    if (loading.tables === schema || inflight.has(schema)) {
      const loader = createLoader({ inline: true, label: 'Загружаю…' });
      node.append(loader);
      return node;
    }
    if (errors.tables && errors.tables.schema === schema) {
      node.append(createErrorView(errors.tables.error));
      return node;
    }
    if (!Array.isArray(ts)) return node;

    const visible = filterText
      ? ts.filter((t) => t.toLowerCase().includes(filterText) || schema.toLowerCase().includes(filterText))
      : ts;

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'db-sidebar__hint';
      empty.textContent = '— нет таблиц —';
      node.append(empty);
      return node;
    }

    const tablesGrid = document.createElement('div');
    tablesGrid.className = 'db-schema__tables';
    for (const t of visible) tablesGrid.append(renderTableChip(schema, t, selection));
    node.append(tablesGrid);
    return node;
  }

  function renderTableChip(schema, table, selection) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'db-table-chip';
    if (selection && selection.schema === schema && selection.table === table) {
      btn.classList.add('db-table-chip--active');
    }
    btn.textContent = table;
    btn.title = `${schema}.${table}`;
    btn.addEventListener('click', () => onSelect(schema, table));
    return btn;
  }

  function toggleSchema(schema) {
    const { expandedSchemas, tables } = store.get();
    const next = new Set(expandedSchemas);
    if (next.has(schema)) {
      next.delete(schema);
      store.set({ expandedSchemas: next });
      return;
    }
    next.add(schema);
    store.set({ expandedSchemas: next });
    if (tables[schema] || inflight.has(schema)) return;
    inflight.add(schema);
    store.set({
      loading: { ...store.get().loading, tables: schema },
      errors:  { ...store.get().errors,  tables: null },
    });
    api.getTables(schema)
      .then((listed) => {
        inflight.delete(schema);
        const cur = store.get();
        store.set({
          tables: { ...cur.tables, [schema]: listed },
          loading: { ...cur.loading, tables: cur.loading.tables === schema ? null : cur.loading.tables },
        });
      })
      .catch((err) => {
        inflight.delete(schema);
        const cur = store.get();
        store.set({
          loading: { ...cur.loading, tables: cur.loading.tables === schema ? null : cur.loading.tables },
          errors:  { ...cur.errors,  tables: { schema, error: err } },
        });
      });
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unsubscribe();
  };
}

function filterSchemas({ schemas, tables }, filterText) {
  if (!filterText) return schemas;
  return schemas.filter((s) => {
    if (s.toLowerCase().includes(filterText)) return true;
    const ts = tables[s];
    return Array.isArray(ts) && ts.some((t) => t.toLowerCase().includes(filterText));
  });
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
