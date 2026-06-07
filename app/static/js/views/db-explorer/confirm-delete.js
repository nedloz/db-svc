// Confirm-модал для удаления (одной строки или нескольких).
// M6 заменит текст про cascade, когда P-004 (cascade preview) появится:
// вместо «зависимости неизвестны» будет полноценный список затрагиваемых записей.
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { USE_MOCK_CRUD } from '../../mocks/index.js';

export function openConfirmDelete({ pkValue, bulk = false, onConfirm }) {
  const body = document.createElement('div');
  body.className = 'confirm-delete';

  const text = document.createElement('p');
  text.textContent = bulk
    ? `Удалить ${formatPk(pkValue)}?`
    : `Удалить строку с pk=${formatPk(pkValue)}?`;
  body.append(text);

  if (USE_MOCK_CRUD) {
    const warn = document.createElement('p');
    warn.className = 'confirm-delete__warning';
    warn.textContent = 'Mock CRUD (P-001): операция применится только в памяти браузера.';
    body.append(warn);
  }

  let busy = false;
  return openModal({
    title: bulk ? 'Подтверждение массового удаления' : 'Подтверждение удаления',
    body,
    actions: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: bulk ? 'Удалить все' : 'Удалить',
        variant: 'danger',
        onClick: async (close) => {
          if (busy) return;
          busy = true;
          try {
            await onConfirm();
            close();
          } catch (err) {
            toast.error(err.message || 'Ошибка удаления');
          } finally {
            busy = false;
          }
        },
      },
    ],
  });
}

function formatPk(pk) {
  if (pk === null || pk === undefined) return 'NULL';
  if (typeof pk === 'object') return JSON.stringify(pk);
  return String(pk);
}
