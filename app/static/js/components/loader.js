// Лоадер: inline-спиннер или блок с подписью.
export function createLoader({ inline = false, label = 'Загрузка…' } = {}) {
  if (inline) {
    const el = document.createElement('span');
    el.className = 'loader';
    el.setAttribute('aria-label', label);
    return el;
  }
  const wrap = document.createElement('div');
  wrap.className = 'loader--block';
  wrap.setAttribute('role', 'status');
  const spinner = document.createElement('span');
  spinner.className = 'loader';
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(spinner, text);
  return wrap;
}
