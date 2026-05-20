// Индикатор активных операций в шапке.
// Бейдж с количеством + popover со списком и кнопками «Отменить» по каждой.
import { subscribeOperations, cancelOperation, listOperations } from '../state/operations.js';

const TICK_INTERVAL_MS = 1000;

export function createOperationsIndicator() {
  const wrap = document.createElement('div');
  wrap.className = 'operations-indicator';

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'operations-indicator__badge';

  const popover = document.createElement('div');
  popover.className = 'operations-indicator__popover';
  popover.hidden = true;

  let isOpen = false;
  badge.addEventListener('click', () => {
    isOpen = !isOpen;
    popover.hidden = !isOpen;
    renderList(listOperations());
  });

  wrap.append(badge, popover);

  renderBadge(listOperations());
  const unsubscribe = subscribeOperations((ops) => {
    renderBadge(ops);
    if (isOpen) renderList(ops);
  });

  const tick = setInterval(() => {
    if (isOpen) renderList(listOperations());
  }, TICK_INTERVAL_MS);

  function renderBadge(ops) {
    badge.textContent = `Операции: ${ops.length}`;
  }

  function renderList(ops) {
    popover.replaceChildren();
    if (!ops.length) {
      const empty = document.createElement('div');
      empty.className = 'operations-indicator__empty';
      empty.textContent = 'Нет активных операций';
      popover.append(empty);
      return;
    }
    for (const op of ops) popover.append(renderRow(op));
  }

  wrap.unmount = () => {
    unsubscribe();
    clearInterval(tick);
  };
  return wrap;
}

function renderRow(op) {
  const row = document.createElement('div');
  row.className = 'operations-indicator__row';

  const label = document.createElement('span');
  label.className = 'operations-indicator__label';
  label.textContent = op.label;

  const elapsed = document.createElement('span');
  elapsed.className = 'operations-indicator__elapsed';
  const seconds = Math.max(0, Math.round((Date.now() - op.startedAt) / 1000));
  elapsed.textContent = `${seconds}s`;

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn operations-indicator__cancel';
  cancel.textContent = 'Отменить';
  cancel.disabled = !op.controller;
  cancel.addEventListener('click', () => cancelOperation(op.id));

  row.append(label, elapsed, cancel);
  return row;
}
