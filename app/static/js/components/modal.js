// Модальное окно. Возвращает { close, overlay, body } для управления извне.
export function openModal({ title = '', body = null, actions = [], onClose = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'modal__header';
  const titleEl = document.createElement('h3');
  titleEl.className = 'modal__title';
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  header.append(titleEl, closeBtn);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal__body';
  if (body instanceof Node) bodyEl.append(body);
  else if (typeof body === 'string') bodyEl.textContent = body;

  modal.append(header, bodyEl);

  if (actions.length) {
    const footer = document.createElement('div');
    footer.className = 'modal__footer';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${action.variant ? `btn--${action.variant}` : ''}`.trim();
      btn.textContent = action.label;
      btn.addEventListener('click', () => action.onClick?.(close));
      footer.append(btn);
    }
    modal.append(footer);
  }

  overlay.append(modal);
  document.body.append(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  return { close, overlay, body: bodyEl };
}
