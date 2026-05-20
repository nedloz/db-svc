// FK-picker: контрол поля FK в формах. Показывает текущее значение и кнопку
// «Выбрать…». Клик → модал со списком строк связанной таблицы и поиском.
//
// Реализация лежит во views/db-explorer/, а не в components/, потому что
// напрямую дёргает api/db.js#listRows — components по нашим правилам не
// должны знать про эндпоинты.
//
// Когда P-002 (серверная фильтрация) подключится — picker автоматически
// заработает с реальным `?filter=contains(...)`; пока поиск работает только
// по первой странице (см. баннер в rows-panel).
import { openModal } from '../../components/modal.js';
import { createInput } from '../../components/form-controls.js';
import { listRows } from '../../api/db.js';
import { detectPkColumn } from '../../utils/pk.js';

const PICK_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 200;

export function createFkPicker({ value = null, references, nullable = true, onChange = () => {} }) {
  // references: { schema, table, column }
  let current = value;

  const wrap = document.createElement('div');
  wrap.className = 'fk-picker';

  const valueEl = document.createElement('span');
  valueEl.className = 'fk-picker__value';

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'btn fk-picker__pick';
  pickBtn.textContent = 'Выбрать…';
  pickBtn.addEventListener('click', openPicker);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn fk-picker__clear';
  clearBtn.textContent = '× NULL';
  clearBtn.title = 'Очистить значение (NULL)';
  clearBtn.addEventListener('click', () => setValue(null));

  const refLabel = document.createElement('span');
  refLabel.className = 'fk-picker__ref';
  refLabel.textContent = `→ ${references.schema}.${references.table}.${references.column}`;

  wrap.append(valueEl, pickBtn, clearBtn, refLabel);
  renderValue();

  function renderValue() {
    if (current == null || current === '') {
      valueEl.textContent = 'NULL';
      valueEl.classList.add('fk-picker__value--null');
    } else {
      valueEl.textContent = String(current);
      valueEl.classList.remove('fk-picker__value--null');
    }
    clearBtn.disabled = !nullable || current == null || current === '';
  }

  function setValue(v) {
    current = (v === '' ? null : v);
    renderValue();
    onChange(current);
  }

  function openPicker() {
    const body = document.createElement('div');
    body.className = 'fk-picker-modal';

    const note = document.createElement('div');
    note.className = 'fk-picker-modal__note';
    note.textContent = `Mock FK (P-003) + поиск через mock-фильтры (P-002): ` +
      `выводятся первые ${PICK_LIMIT} строк связанной таблицы. ` +
      `Точный поиск появится с серверным where.`;
    body.append(note);

    const search = createInput({ placeholder: `Поиск по строкам ${references.schema}.${references.table}…` });
    search.classList.add('fk-picker-modal__search');
    body.append(search);

    const list = document.createElement('div');
    list.className = 'fk-picker-modal__list';
    body.append(list);

    const status = document.createElement('div');
    status.className = 'fk-picker-modal__status';
    body.append(status);

    let modalCtl;
    let loadToken = 0;
    let debounceTimer = null;

    async function load(query) {
      const myToken = ++loadToken;
      status.textContent = 'Загрузка…';
      list.replaceChildren();
      try {
        const filters = query
          ? [{ column: references.column, op: 'contains', value: query }]
          : [];
        const data = await listRows(
          { schema: references.schema, table: references.table, limit: PICK_LIMIT, offset: 0, filters },
          { trackAs: `FK-выбор: ${references.schema}.${references.table}` },
        );
        if (myToken !== loadToken) return;
        const pkCol = detectPkColumn(data.columns) || references.column;
        if (!data.rows.length) {
          status.textContent = 'Совпадений нет';
          return;
        }
        for (const row of data.rows) {
          list.append(buildRowButton(row, pkCol, references.column, (pkValue) => {
            setValue(pkValue);
            modalCtl?.close();
          }));
        }
        const more = data.rows.length >= PICK_LIMIT ? '+' : '';
        status.textContent = `Показано: ${data.rows.length}${more}`;
      } catch (err) {
        if (myToken !== loadToken) return;
        status.textContent = `Ошибка: ${err?.message || err}`;
      }
    }

    search.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => load(q), SEARCH_DEBOUNCE_MS);
    });

    modalCtl = openModal({
      title: `Выбрать ${references.schema}.${references.table}.${references.column}`,
      body,
      actions: [{ label: 'Закрыть', onClick: (close) => close() }],
    });

    load('');
  }

  return {
    element: wrap,
    get value() { return current; },
    setValue,
  };
}

function buildRowButton(row, pkCol, refCol, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn fk-picker-modal__row';
  const pkValue = row[refCol] ?? row[pkCol];
  btn.textContent = formatRowLabel(row, pkValue);
  btn.addEventListener('click', () => onPick(pkValue));
  return btn;
}

function formatRowLabel(row, pk) {
  const display = row.name ?? row.title ?? row.short_name ?? row.email ?? row.slug ?? row.label ?? null;
  if (display) return `${pk} — ${display}`;
  return String(pk);
}
