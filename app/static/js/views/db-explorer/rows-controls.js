// Контролы над таблицей строк, по дизайну: 2 ряда.
// Верхний ряд: поиск + Найти | Limit pill | Offset pill | Загрузить + Очистить.
// Нижний ряд: иконки (filter / sort / edit) + Export | "1 of N" с < >.

export function buildRowsControls({
  onSearch,
  onLoad,
  onClear,
  getLimit,
  getOffset,
  onLimitChange,
  onOffsetChange,
  getPagination,
  onPrev,
  onNext,
  onToggleFilters,
  onExport,
  onToggleEdit,           // переключатель edit-режима для активной строки
  getEditState,           // () => { hasActive: bool, isEditing: bool }
  onToggleColumnTools,    // переключатель треугольников-инструментов в шапке
  getColumnToolsState,    // () => bool
  onCycleCellMode,        // циклит режим отображения ячеек (fit/ellipsis/wrap)
  getCellMode,            // () => 'fit' | 'ellipsis' | 'wrap'
}) {
  const root = document.createElement('div');
  root.className = 'rows-controls';

  // ====== Верхний ряд ======
  const top = document.createElement('div');
  top.className = 'rows-controls__top';

  // Поиск + Найти
  const searchGroup = document.createElement('div');
  searchGroup.className = 'rows-controls__search-group';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input';
  searchInput.placeholder = 'Поиск по таблице';
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearch?.(searchInput.value);
  });
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'btn btn--primary';
  searchBtn.textContent = 'Найти';
  searchBtn.addEventListener('click', () => onSearch?.(searchInput.value));
  searchGroup.append(searchInput, searchBtn);

  // Limit / Offset pills (clickable, открывают inline-edit)
  const limitPill = makeEditablePill('Limit', () => getLimit(), (v) => {
    if (v >= 1 && v <= 500) onLimitChange?.(v);
  });
  const offsetPill = makeEditablePill('Offset', () => getOffset(), (v) => {
    if (v >= 0) onOffsetChange?.(v);
  });

  const pillsGroup = document.createElement('div');
  pillsGroup.className = 'rows-controls__pills';
  pillsGroup.append(limitPill.el, offsetPill.el);

  // Загрузить + Очистить
  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'rows-controls__actions';
  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'btn btn--primary';
  loadBtn.textContent = 'Загрузить';
  loadBtn.addEventListener('click', () => onLoad?.());
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn';
  clearBtn.textContent = 'Очистить';
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    onClear?.();
  });
  actionsGroup.append(loadBtn, clearBtn);

  top.append(searchGroup, pillsGroup, actionsGroup);

  // ====== Нижний ряд ======
  const bottom = document.createElement('div');
  bottom.className = 'rows-controls__bottom';

  // Иконки: фильтр / сортировка / редактирование + Export
  const iconsGroup = document.createElement('div');
  iconsGroup.className = 'rows-controls__icons';
  const filterIcon = makeIconButton('▼', 'Фильтры', () => onToggleFilters?.());
  const sortIcon = makeIconButton('⇅', 'Инструменты колонок: сортировка и фильтр по значениям', () => onToggleColumnTools?.());
  const editIcon = makeIconButton('✎', 'Редактировать выбранную строку', () => onToggleEdit?.());
  const wrapIcon = makeIconButton('☰', 'Режим отображения ячеек (клик — следующий)', () => onCycleCellMode?.());
  iconsGroup.append(filterIcon, sortIcon, editIcon, wrapIcon);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'rows-controls__export';
  exportBtn.innerHTML = `<span class="rows-controls__export-icon">⇩</span> Export`;
  exportBtn.addEventListener('click', () => onExport?.());

  const leftGroup = document.createElement('div');
  leftGroup.className = 'rows-controls__bottom-left';
  leftGroup.append(iconsGroup, exportBtn);

  // Pagination: 1 of N + < >
  const pagGroup = document.createElement('div');
  pagGroup.className = 'rows-controls__pagination';
  const pagText = document.createElement('span');
  pagText.className = 'rows-controls__pagination-text';
  const prevBtn = makeIconButton('‹', 'Предыдущая страница', () => onPrev?.());
  prevBtn.classList.add('rows-controls__pag-arrow');
  const nextBtn = makeIconButton('›', 'Следующая страница', () => onNext?.());
  nextBtn.classList.add('rows-controls__pag-arrow');
  pagGroup.append(pagText, prevBtn, nextBtn);

  bottom.append(leftGroup, pagGroup);

  root.append(top, bottom);

  function update() {
    limitPill.refresh();
    offsetPill.refresh();
    const { page, totalPages } = getPagination();
    pagText.textContent = totalPages ? `${page} of ${totalPages}` : `${page}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = !!totalPages && page >= totalPages;

    // Edit-кнопка: disabled если нет активной строки.
    const editState = getEditState ? getEditState() : { hasActive: false, isEditing: false };
    editIcon.disabled = !editState.hasActive && !editState.isEditing;
    editIcon.classList.toggle('rows-controls__icon-btn--active', editState.isEditing);
    editIcon.title = editState.isEditing
      ? 'Идёт редактирование — сохраните или отмените изменения'
      : editState.hasActive
        ? 'Редактировать выбранную строку'
        : 'Сначала выберите строку (клик)';

    // Кнопка ⇅: подсвечена когда режим инструментов колонок включён.
    const toolsOn = getColumnToolsState ? getColumnToolsState() : false;
    sortIcon.classList.toggle('rows-controls__icon-btn--active', toolsOn);

    // Кнопка ☰ статична (символ не меняем). Обновляем только подсказку.
    const mode = getCellMode ? getCellMode() : 'fit';
    const label = {
      fit: 'компактный (вся таблица помещается)',
      ellipsis: 'одна строка + «…» (шире, со скроллом)',
      wrap: 'перенос текста',
    }[mode] || mode;
    wrapIcon.title = `Режим ячеек: ${label} — клик для следующего`;
  }

  update();

  return { el: root, update };
}

function makeEditablePill(label, getter, onCommit) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'stat-pill rows-controls__pill';
  let editing = false;

  function refresh() {
    if (!editing) el.textContent = `${label}: ${getter() ?? '—'}`;
  }

  el.addEventListener('click', () => {
    if (editing) return;
    editing = true;
    el.textContent = '';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'rows-controls__pill-input';
    input.value = String(getter() ?? 0);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { editing = false; refresh(); }
    });
    el.append(input);
    input.focus();
    input.select();
    function commit() {
      const v = Number(input.value);
      editing = false;
      if (Number.isFinite(v)) onCommit?.(v);
      refresh();
    }
  });

  refresh();
  return { el, refresh };
}

function makeIconButton(symbol, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rows-controls__icon-btn';
  btn.textContent = symbol;
  btn.title = title;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}
