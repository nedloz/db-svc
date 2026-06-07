// Модалка «Сортировка / Фильтр по значениям» — открывается по клику на
// заголовок колонки. Дизайн см. в figma: две секции, кнопки Очистить + ок.
//
// Сортировка применяется через onApply({ sortDir, valueFilter }):
//   - sortDir: 'asc' | 'desc' | null
//   - valueFilter: { include: Set<string|null> | null } — null = «все значения»
//
// Значения для чекбоксов собираются из rows текущей страницы (best effort).
// Полноценный список разрешённых значений придёт с P-011 (см. PROBLEMS.md).
import { openModal } from '../../components/modal.js';

export function openSortModal({ column, currentSort, currentValueFilter, rows, onApply }) {
  const body = document.createElement('div');
  body.className = 'sort-modal';

  // ----- Секция «Сортировка» -----
  const sortSection = document.createElement('div');
  sortSection.className = 'sort-modal__section';
  const sortTitle = document.createElement('div');
  sortTitle.className = 'sort-modal__section-title';
  sortTitle.textContent = 'Сортировка';
  sortSection.append(sortTitle);

  const sortButtons = document.createElement('div');
  sortButtons.className = 'sort-modal__sort-buttons';

  let sortDir = currentSort?.key === column.key ? (currentSort.dir || 'asc') : null;

  const ascBtn = document.createElement('button');
  ascBtn.type = 'button';
  ascBtn.className = 'sort-modal__sort-btn';
  ascBtn.innerHTML = '<span class="sort-modal__arrow">↑</span> От А до Я';
  ascBtn.addEventListener('click', () => {
    sortDir = sortDir === 'asc' ? null : 'asc';
    updateSortButtons();
  });

  const descBtn = document.createElement('button');
  descBtn.type = 'button';
  descBtn.className = 'sort-modal__sort-btn';
  descBtn.innerHTML = '<span class="sort-modal__arrow">↓</span> От Я до А';
  descBtn.addEventListener('click', () => {
    sortDir = sortDir === 'desc' ? null : 'desc';
    updateSortButtons();
  });

  sortButtons.append(ascBtn, descBtn);
  sortSection.append(sortButtons);
  body.append(sortSection);

  function updateSortButtons() {
    ascBtn.classList.toggle('sort-modal__sort-btn--active', sortDir === 'asc');
    descBtn.classList.toggle('sort-modal__sort-btn--active', sortDir === 'desc');
  }
  updateSortButtons();

  // ----- Секция «Фильтр по значениям» -----
  const filterSection = document.createElement('div');
  filterSection.className = 'sort-modal__section';
  const filterTitle = document.createElement('div');
  filterTitle.className = 'sort-modal__section-title';
  filterTitle.textContent = 'Фильтр по значениям';
  filterSection.append(filterTitle);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input sort-modal__search';
  searchInput.placeholder = 'Поиск значения';
  filterSection.append(searchInput);

  const distinctValues = collectDistinct(rows, column.key);

  // Текущее состояние: какие значения выбраны (включены).
  // Если currentValueFilter == null → все выбраны.
  const includeSet = new Set(
    currentValueFilter?.include
      ? Array.from(currentValueFilter.include)
      : distinctValues.map((v) => v.raw)
  );

  const allBox = document.createElement('label');
  allBox.className = 'sort-modal__option sort-modal__option--all';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  const allLabel = document.createElement('span');
  allLabel.textContent = 'Выделить всё';
  allBox.append(allCb, allLabel);
  filterSection.append(allBox);

  const listEl = document.createElement('div');
  listEl.className = 'sort-modal__list';
  filterSection.append(listEl);

  function renderList() {
    listEl.replaceChildren();
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q
      ? distinctValues.filter((v) => v.label.toLowerCase().includes(q))
      : distinctValues;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'sort-modal__empty';
      empty.textContent = q ? 'Ничего не найдено' : 'Нет значений на странице';
      listEl.append(empty);
    } else {
      for (const v of filtered) {
        const label = document.createElement('label');
        label.className = 'sort-modal__option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = includeSet.has(v.raw);
        cb.addEventListener('change', () => {
          if (cb.checked) includeSet.add(v.raw);
          else includeSet.delete(v.raw);
          updateAllCheckbox();
        });
        const text = document.createElement('span');
        text.className = 'sort-modal__option-label';
        text.textContent = v.label;
        text.title = v.label;
        label.append(cb, text);
        listEl.append(label);
      }
    }
    updateAllCheckbox();
  }

  function updateAllCheckbox() {
    const total = distinctValues.length;
    const selected = distinctValues.filter((v) => includeSet.has(v.raw)).length;
    allCb.checked = total > 0 && selected === total;
    allCb.indeterminate = selected > 0 && selected < total;
  }

  allCb.addEventListener('change', () => {
    if (allCb.checked) {
      for (const v of distinctValues) includeSet.add(v.raw);
    } else {
      includeSet.clear();
    }
    renderList();
  });

  searchInput.addEventListener('input', renderList);

  body.append(filterSection);
  renderList();

  // ----- Открытие модалки -----
  const ctl = openModal({
    title: `Колонка: ${column.label || column.key}`,
    body,
    actions: [
      { label: 'Очистить', onClick: (close) => {
          sortDir = null;
          for (const v of distinctValues) includeSet.add(v.raw);
          updateSortButtons();
          renderList();
          onApply?.({ sortDir: null, valueFilter: null });
          close();
        },
      },
      { label: 'ок', variant: 'primary', onClick: (close) => {
          const total = distinctValues.length;
          const selectedCount = distinctValues.filter((v) => includeSet.has(v.raw)).length;
          // Если выбраны все — фильтра нет.
          const valueFilter = (total > 0 && selectedCount === total) || !total
            ? null
            : { include: new Set(includeSet) };
          onApply?.({ sortDir, valueFilter });
          close();
        },
      },
    ],
  });

  return ctl;
}

function collectDistinct(rows, columnKey) {
  const seen = new Map(); // raw -> label
  for (const row of rows) {
    const raw = row[columnKey];
    const key = serialize(raw);
    if (!seen.has(key)) seen.set(key, displayLabel(raw));
  }
  return [...seen.entries()].map(([raw, label]) => ({ raw, label }));
}

function serialize(v) {
  if (v === null || v === undefined) return '__NULL__';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function displayLabel(v) {
  if (v === null || v === undefined) return '(NULL)';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
