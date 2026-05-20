// Список колонок выбранной таблицы. Раскрывается через <details>.
import { shortPgType } from '../../utils/types.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';

export function mountColumnsPanel({ container, store }) {
  const wrap = document.createElement('details');
  wrap.className = 'columns-panel';
  wrap.open = false;

  const summary = document.createElement('summary');
  summary.className = 'columns-panel__summary';
  summary.textContent = 'Колонки';
  wrap.append(summary);

  const body = document.createElement('div');
  body.className = 'columns-panel__body';
  wrap.append(body);

  container.replaceChildren(wrap);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const { selection, columns, loading, errors } = store.get();
    body.replaceChildren();
    summary.textContent = selection && columns.length
      ? `Колонки (${columns.length})`
      : 'Колонки';

    if (!selection) return;
    if (loading.columns) {
      body.append(createLoader({ label: 'Загружаю колонки…' }));
      return;
    }
    if (errors.columns) {
      body.append(createErrorView(errors.columns));
      return;
    }
    if (!columns.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Нет колонок';
      body.append(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'columns-list';
    for (const col of columns) list.append(renderColumn(col));
    body.append(list);
  }

  function renderColumn(col) {
    const row = document.createElement('div');
    row.className = 'columns-list__row';

    const name = document.createElement('span');
    name.className = 'columns-list__name';
    name.textContent = col.name;

    const type = document.createElement('span');
    type.className = 'columns-list__type';
    type.textContent = shortPgType(col.type);

    const flag = document.createElement('span');
    if (col.nullable) {
      flag.className = 'columns-list__nullable';
      flag.textContent = 'NULL';
    } else {
      flag.className = 'columns-list__nn';
      flag.textContent = 'NOT NULL';
    }

    row.append(name, type, flag);
    return row;
  }

  return () => unsubscribe();
}
