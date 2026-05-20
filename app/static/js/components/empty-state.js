// Пустое состояние: заголовок + описание + опциональная кнопка действия.
export function createEmptyState({ title = 'Ничего нет', description = '', action = null } = {}) {
  const el = document.createElement('div');
  el.className = 'empty-state';

  const titleEl = document.createElement('div');
  titleEl.className = 'empty-state__title';
  titleEl.textContent = title;
  el.append(titleEl);

  if (description) {
    const desc = document.createElement('div');
    desc.textContent = description;
    el.append(desc);
  }

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'btn empty-state__action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.append(btn);
  }
  return el;
}
