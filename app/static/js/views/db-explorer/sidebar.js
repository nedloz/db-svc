// Сайдбар db-explorer: список схем с lazy-load таблиц + дебаунс-фильтр.
import { createInput } from '../../components/form-controls.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { createEmptyState } from '../../components/empty-state.js';

const FILTER_DEBOUNCE_MS = 200;

export function mountSidebar({ container, store, api, onSelect }) {
  let filterText = '';
  let debounceTimer = null;
  const inflight = new Set();

  const wrap = document.createElement('div');
  wrap.className = 'sidebar';

  const filter = createInput({
    placeholder: 'Поиск схемы или таблицы…',
    onInput: (val) => {
      filterText = val.trim().toLowerCase();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(render, FILTER_DEBOUNCE_MS);
    },
  });
  filter.classList.add('sidebar__filter');

  const list = document.createElement('div');
  list.className = 'sidebar__list';

  wrap.append(filter, list);
  container.replaceChildren(wrap);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const { schemas, loading, errors } = store.get();
    list.replaceChildren();

    if (loading.schemas) {
      list.append(createLoader({ label: 'Загружаю схемы…' }));
      return;
    }
    if (errors.schemas) {
      list.append(createErrorView(errors.schemas));
      return;
    }
    if (!schemas.length) {
      list.append(createEmptyState({ title: 'Нет схем' }));
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
    const { expandedSchemas, tables, selection, loading } = store.get();
    const isExpanded = expandedSchemas.has(schema);

    const node = document.createElement('div');
    node.className = 'sidebar__schema';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'sidebar__schema-head';
    head.textContent = `${isExpanded ? '▾' : '▸'} ${schema}`;
    head.addEventListener('click', () => toggleSchema(schema));
    node.append(head);

    if (!isExpanded) return node;

    const tableList = document.createElement('div');
    tableList.className = 'sidebar__tables';
    const ts = tables[schema];

    const { errors } = store.get();
    if (loading.tables === schema || inflight.has(schema)) {
      tableList.append(createLoader({ inline: true, label: '' }));
    } else if (errors.tables && errors.tables.schema === schema) {
      tableList.append(createErrorView(errors.tables.error));
    } else if (Array.isArray(ts)) {
      const visible = filterText
        ? ts.filter((t) => t.toLowerCase().includes(filterText) || schema.toLowerCase().includes(filterText))
        : ts;
      if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'sidebar__empty';
        empty.textContent = '— нет таблиц —';
        tableList.append(empty);
      } else {
        for (const t of visible) tableList.append(renderTable(schema, t, selection));
      }
    }
    node.append(tableList);
    return node;
  }

  function renderTable(schema, table, selection) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar__table';
    if (selection && selection.schema === schema && selection.table === table) {
      btn.classList.add('sidebar__table--active');
    }
    btn.textContent = table;
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
