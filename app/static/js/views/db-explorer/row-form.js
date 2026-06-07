// Универсальная форма строки: создание (mode='create') или редактирование (mode='edit').
// Поля генерируются по columns. Валидация — по nullable / type. JSON парсится на сабмите.
//
// Auto-managed колонки (id / created_at / updated_at):
//   - в create-режиме скрываются (бэк-мок их сам генерирует);
//   - в edit-режиме показываются readonly.
//
// PK при edit-режиме нельзя править через эту форму (он readonly).
//
// FK-колонки (M6, P-003) рендерятся через fk-picker — выпадающий выбор из
// связанной таблицы. Карта FK берётся из `relations` (передаётся снаружи).
import { openModal } from '../../components/modal.js';
import { categorizePgType } from '../../utils/types.js';
import { toast } from '../../components/toast.js';
import { createInput, createTextarea, createCheckbox, createSelect } from '../../components/form-controls.js';
import { createFkPicker } from './fk-picker.js';
import { getColumnEnum } from '../../mocks/db-enums.js';
import { USE_MOCK_CRUD } from '../../mocks/index.js';

const AUTO_MANAGED = new Set(['id', 'created_at', 'updated_at']);

export function openRowForm({ mode, columns, row = null, selection, relations = [], enums = {}, onSubmit }) {
  const fkByColumn = new Map();
  for (const rel of relations) fkByColumn.set(rel.column, rel);
  const body = document.createElement('div');
  body.className = 'row-form';

  if (USE_MOCK_CRUD) {
    const banner = document.createElement('div');
    banner.className = 'row-form__notice';
    banner.textContent = 'Mock CRUD (P-001): изменения живут в памяти текущей сессии браузера.';
    body.append(banner);
  }

  const fields = new Map();
  for (const col of columns) {
    if (mode === 'create' && AUTO_MANAGED.has(col.name)) continue;
    const rel = fkByColumn.get(col.name) || null;
    const field = buildField(col, row?.[col.name], mode, rel, selection, enums);
    fields.set(col.name, field);
    body.append(field.element);
  }

  let busy = false;

  return openModal({
    title: mode === 'create'
      ? `Создать строку: ${selection.schema}.${selection.table}`
      : `Редактировать: ${selection.schema}.${selection.table}`,
    body,
    actions: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: mode === 'create' ? 'Создать' : 'Сохранить',
        variant: 'primary',
        onClick: async (close) => {
          if (busy) return;
          const data = {};
          let hasError = false;
          for (const [name, field] of fields) {
            field.clearError();
            try {
              data[name] = field.read();
            } catch (err) {
              field.showError(err.message);
              hasError = true;
            }
          }
          if (hasError) return;
          // Для edit перенесём auto-managed поля как есть из исходной строки —
          // мок сам обновит updated_at, но id и created_at пользователь видеть в форме не должен.
          if (mode === 'edit' && row) {
            for (const col of columns) {
              if (AUTO_MANAGED.has(col.name) && !(col.name in data)) {
                data[col.name] = row[col.name];
              }
            }
          }
          busy = true;
          try {
            await onSubmit(data);
            close();
          } catch (err) {
            toast.error(err.message || 'Ошибка сохранения');
          } finally {
            busy = false;
          }
        },
      },
    ],
  });
}

function buildField(col, value, mode, relation, selection, enums = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'row-form__field';

  const labelEl = document.createElement('div');
  labelEl.className = 'row-form__label';
  const fkSuffix = relation ? ` → ${relation.references.schema}.${relation.references.table}.${relation.references.column}` : '';
  labelEl.textContent = `${col.name} (${col.type}${col.nullable ? '' : ' NOT NULL'})${fkSuffix}`;
  wrap.append(labelEl);

  const cat = categorizePgType(col.type);
  const isAutoManaged = mode === 'edit' && AUTO_MANAGED.has(col.name);
  const isPk = mode === 'edit' && col.name === 'id';
  const readonly = isAutoManaged || isPk;
  const enumValues = (enums && enums[col.name])
    || (selection ? getColumnEnum(selection.schema, selection.table, col.name) : null);

  let input;
  let read;

  if (enumValues && !readonly) {
    // Колонка с CHECK (col IN (...)) → выпадающий список допустимых значений.
    const opts = [];
    if (col.nullable) opts.push({ value: '', label: '—' });
    const cur = value == null ? '' : String(value);
    if (cur && !enumValues.includes(cur)) opts.push({ value: cur, label: cur });
    for (const v of enumValues) opts.push({ value: v, label: v });
    const sel = createSelect({ value: cur, options: opts });
    input = sel;
    read = () => {
      const v = sel.value;
      if (v === '' || v === null) {
        if (!col.nullable && mode === 'create') throw new Error('Обязательное поле');
        return null;
      }
      return v;
    };
  } else if (relation && !readonly) {
    // FK-колонка → выпадающий выбор из связанной таблицы.
    const picker = createFkPicker({
      value,
      references: relation.references,
      nullable: !!relation.is_nullable || !!col.nullable,
    });
    input = picker.element;
    read = () => {
      const v = picker.value;
      if (v === null || v === '') {
        if (!col.nullable && mode === 'create') throw new Error('Обязательное FK-поле');
        return null;
      }
      return v;
    };
  } else if (cat === 'bool') {
    const cb = createCheckbox({ checked: !!value });
    input = cb.element;
    if (readonly) cb.input.disabled = true;
    read = () => cb.input.checked;
  } else {
    const useTextarea = cat === 'text' || cat === 'json';
    const initial = formatInitial(value, cat);
    if (useTextarea) {
      input = createTextarea({ value: initial, rows: cat === 'json' ? 5 : 3 });
    } else {
      input = createInput({
        value: initial,
        type: cat === 'number' ? 'number' : (cat === 'datetime' ? 'datetime-local' : 'text'),
      });
    }
    if (readonly) input.readOnly = true;
    read = () => parseValue(input.value, col, cat, mode, readonly);
  }

  wrap.append(input);

  const errorEl = document.createElement('div');
  errorEl.className = 'row-form__error';
  errorEl.hidden = true;
  wrap.append(errorEl);

  return {
    element: wrap,
    read,
    showError: (msg) => { errorEl.textContent = msg; errorEl.hidden = false; },
    clearError: () => { errorEl.textContent = ''; errorEl.hidden = true; },
  };
}

function formatInitial(value, cat) {
  if (value === null || value === undefined) return '';
  if (cat === 'json') {
    try {
      const obj = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(obj, null, 2);
    } catch (_e) { return String(value); }
  }
  if (cat === 'datetime') return toLocalDate(value);
  return String(value);
}

function parseValue(raw, col, cat, mode, readonly) {
  if (readonly) return raw === '' ? null : raw;
  if (raw === '' || raw === null) {
    if (!col.nullable && mode === 'create') {
      throw new Error('Обязательное поле');
    }
    return null;
  }
  if (cat === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error('Должно быть число');
    return n;
  }
  if (cat === 'json') {
    try { return JSON.parse(raw); }
    catch (_e) { throw new Error('Невалидный JSON'); }
  }
  if (cat === 'datetime') {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error('Невалидная дата');
    return d.toISOString();
  }
  return raw;
}

function toLocalDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
