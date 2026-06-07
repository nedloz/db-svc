// Модал предпросмотра каскадного удаления (P-004).
// Показывает дерево затрагиваемых записей: по каждой inbound-таблице
// счётчик и тип on_delete (CASCADE / SET NULL / NO ACTION / RESTRICT).
// Кнопка «Удалить» disabled пока пользователь не подтвердит чекбоксом —
// чтобы не удалить случайно из-за того, что список не прочитан.
//
// previewCascade — асинхронный. Пока он грузится, в теле модала «Загружаю…».
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { USE_MOCK_CRUD, USE_MOCK_CASCADE } from '../../mocks/index.js';

export function openCascadeModal({ schema, table, pkValue, previewPromise, onConfirm }) {
  const body = document.createElement('div');
  body.className = 'cascade-modal';

  const head = document.createElement('p');
  head.className = 'cascade-modal__head';
  head.textContent = `Удалить ${schema}.${table} с pk=${formatPk(pkValue)}?`;
  body.append(head);

  const status = document.createElement('div');
  status.className = 'cascade-modal__status';
  status.textContent = 'Считаю зависимости…';
  body.append(status);

  const listEl = document.createElement('div');
  listEl.className = 'cascade-modal__list';
  listEl.hidden = true;
  body.append(listEl);

  const ack = document.createElement('label');
  ack.className = 'cascade-modal__ack';
  const ackCb = document.createElement('input');
  ackCb.type = 'checkbox';
  const ackText = document.createElement('span');
  ackText.textContent = ' Я прочитал список зависимостей и понимаю последствия';
  ack.append(ackCb, ackText);
  ack.hidden = true;
  body.append(ack);

  if (USE_MOCK_CRUD || USE_MOCK_CASCADE) {
    const warn = document.createElement('p');
    warn.className = 'cascade-modal__warning';
    warn.textContent = 'Mock CRUD (P-001) + Mock cascade (P-004): удаление применится ' +
      'только к памяти браузера; список зависимостей синтезирован из FK-карты ' +
      'init.sql и in-memory строк — может быть неполным.';
    body.append(warn);
  }

  let busy = false;
  let confirmBtn;

  const modalCtl = openModal({
    title: 'Каскадное удаление',
    body,
    actions: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Удалить',
        variant: 'danger',
        onClick: async (close) => {
          if (busy) return;
          if (!ackCb.checked) {
            toast.warn('Отметьте, что вы прочитали список зависимостей');
            return;
          }
          busy = true;
          try {
            await onConfirm();
            close();
          } catch (err) {
            toast.error(err?.message || 'Ошибка удаления');
          } finally {
            busy = false;
          }
        },
      },
    ],
  });

  // Кнопка «Удалить» — последняя кнопка в footer'е.
  confirmBtn = modalCtl.overlay.querySelector('.modal__footer .btn--danger');
  if (confirmBtn) confirmBtn.disabled = true;
  ackCb.addEventListener('change', () => {
    if (confirmBtn) confirmBtn.disabled = !ackCb.checked;
  });

  previewPromise
    .then((preview) => {
      status.hidden = true;
      ack.hidden = false;
      listEl.hidden = false;
      renderPreview(listEl, preview);
      if (preview.total === 0) {
        // Зависимостей нет — подтверждение не требуется.
        ack.hidden = true;
        ackCb.checked = true;
        if (confirmBtn) confirmBtn.disabled = false;
      }
    })
    .catch((err) => {
      status.textContent = `Не удалось получить preview: ${err?.message || err}. Удаление всё равно возможно.`;
      ack.hidden = false;
    });

  return modalCtl;
}

function renderPreview(listEl, preview) {
  listEl.replaceChildren();
  const total = document.createElement('div');
  total.className = 'cascade-modal__total';
  total.textContent = preview.total === 0
    ? 'Связанных записей не обнаружено.'
    : `Будет затронуто связанных записей: ${preview.total}${preview.approximate ? '+' : ''}.`;
  listEl.append(total);

  if (!preview.by_table?.length) return;

  const ul = document.createElement('ul');
  ul.className = 'cascade-modal__tables';
  for (const entry of preview.by_table) {
    const li = document.createElement('li');
    li.className = 'cascade-modal__entry';

    const head = document.createElement('div');
    head.className = 'cascade-modal__entry-head';
    const name = document.createElement('span');
    name.className = 'cascade-modal__entry-name';
    name.textContent = `${entry.schema}.${entry.table}`;
    const col = document.createElement('span');
    col.className = 'cascade-modal__entry-col';
    col.textContent = ` · через колонку ${entry.column}`;
    const od = document.createElement('span');
    od.className = `cascade-modal__entry-ondelete cascade-modal__entry-ondelete--${slug(entry.on_delete)}`;
    od.textContent = ` · ON DELETE ${entry.on_delete}`;
    const cnt = document.createElement('span');
    cnt.className = 'cascade-modal__entry-count';
    cnt.textContent = ` — ${entry.count}${entry.truncated ? '+' : ''}`;
    head.append(name, col, od, cnt);
    li.append(head);

    if (entry.on_delete === 'NO ACTION' || entry.on_delete === 'RESTRICT') {
      if (entry.count > 0) {
        const block = document.createElement('div');
        block.className = 'cascade-modal__entry-block';
        block.textContent = '⛔ Бэк не позволит удалить, пока ссылающиеся записи существуют.';
        li.append(block);
      }
    }
    if (entry.error) {
      const errEl = document.createElement('div');
      errEl.className = 'cascade-modal__entry-error';
      errEl.textContent = `Ошибка подсчёта: ${entry.error}`;
      li.append(errEl);
    }
    ul.append(li);
  }
  listEl.append(ul);
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function formatPk(pk) {
  if (pk == null) return 'NULL';
  if (typeof pk === 'object') return JSON.stringify(pk);
  return String(pk);
}
