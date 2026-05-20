// Toast-уведомления с агрегацией дубликатов (одинаковые тексты подряд → счётчик ×N).
let container = null;
const active = new Map(); // key -> { el, count, countEl, timer }

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.append(container);
  return container;
}

export function showToast({ type = 'info', message, duration = 3500 }) {
  const root = ensureContainer();
  const key = `${type}::${message}`;
  if (active.has(key)) {
    const entry = active.get(key);
    entry.count += 1;
    entry.countEl.textContent = `×${entry.count}`;
    entry.countEl.hidden = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => dismiss(key), duration);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  const msg = document.createElement('div');
  msg.className = 'toast__message';
  msg.textContent = message;
  const countEl = document.createElement('span');
  countEl.className = 'toast__count';
  countEl.hidden = true;
  const close = document.createElement('button');
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(key));
  el.append(msg, countEl, close);
  root.append(el);
  const timer = setTimeout(() => dismiss(key), duration);
  active.set(key, { el, count: 1, countEl, timer });
}

function dismiss(key) {
  const entry = active.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.el.remove();
  active.delete(key);
}

export const toast = {
  info:    (message, opts = {}) => showToast({ type: 'info',    message, ...opts }),
  success: (message, opts = {}) => showToast({ type: 'success', message, ...opts }),
  warn:    (message, opts = {}) => showToast({ type: 'warn',    message, ...opts }),
  error:   (message, opts = {}) => showToast({ type: 'error',   message, ...opts }),
};
