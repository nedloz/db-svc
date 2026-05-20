// Карточка с именем выбранной таблицы, счётчиками и CRUD-действиями над всей таблицей.
// Кнопки: «Создать строку» (M5) и «Удалить выбранные» (активна, если есть выбор).
export function mountTableInfo({ container, store, onCreateRow, onDeleteSelected }) {
  const card = document.createElement('div');
  card.className = 'info-card';
  container.replaceChildren(card);

  const unsubscribe = store.subscribe(render);
  render();

  function render() {
    const { selection, columns, rowsTotal, filters, selectedPks, loading } = store.get();
    card.replaceChildren();

    if (!selection) {
      const hint = document.createElement('div');
      hint.className = 'empty-state';
      hint.textContent = 'Выберите таблицу слева';
      card.append(hint);
      return;
    }

    const title = document.createElement('div');
    title.className = 'info-card__title';
    const schemaSpan = document.createElement('span');
    schemaSpan.className = 'info-card__schema';
    schemaSpan.textContent = `${selection.schema}.`;
    const tableSpan = document.createElement('span');
    tableSpan.className = 'info-card__table';
    tableSpan.textContent = selection.table;
    title.append(schemaSpan, tableSpan);

    const stats = document.createElement('div');
    stats.className = 'info-card__stats';
    const colCount = loading.columns ? '…' : String(columns.length);
    const rowCount = rowsTotal === null
      ? (loading.rows ? '…' : '?')
      : String(rowsTotal);
    const filterPart = filters.length ? ` · Фильтров: ${filters.length}` : '';
    const selPart = selectedPks?.size ? ` · Выбрано: ${selectedPks.size}` : '';
    stats.textContent = `Колонок: ${colCount} · Строк: ${rowCount}${filterPart}${selPart}`;

    const actions = document.createElement('div');
    actions.className = 'info-card__actions';

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn btn--primary info-card__create';
    createBtn.textContent = '+ Создать строку';
    createBtn.disabled = !columns.length || loading.columns;
    createBtn.addEventListener('click', () => onCreateRow?.());
    actions.append(createBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--danger info-card__delete-selected';
    delBtn.textContent = `Удалить выбранные${selectedPks?.size ? ` (${selectedPks.size})` : ''}`;
    delBtn.disabled = !selectedPks?.size;
    delBtn.addEventListener('click', () => onDeleteSelected?.());
    actions.append(delBtn);

    card.append(title, stats, actions);
  }

  return () => unsubscribe();
}
