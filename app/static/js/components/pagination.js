// Пагинация: Prev / Next + индикатор страницы + селектор размера страницы +
// "advanced" аккордеон с сырыми Limit / Offset.

const DEFAULT_PAGE_SIZES = [25, 50, 100, 200, 500];

export function createPagination({
  page = 1,
  pageSize = 50,
  total = null,                // null → общее число строк неизвестно
  pageSizes = DEFAULT_PAGE_SIZES,
  onChange = () => {},
  showAdvanced = true,
} = {}) {
  const el = document.createElement('div');
  el.className = 'pagination';

  const lastPage = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  const prev = makeBtn('← Назад', { disabled: page <= 1, onClick: () => onChange({ page: page - 1, pageSize }) });
  const info = makeSpan(lastPage !== null ? `Стр. ${page}/${lastPage}` : `Стр. ${page}`, 'pagination__info');
  const next = makeBtn('Вперёд →', {
    disabled: lastPage !== null && page >= lastPage,
    onClick: () => onChange({ page: page + 1, pageSize }),
  });

  const sizeLabel = makeSpan('· строк:', 'pagination__label');
  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'select pagination__size';
  for (const s of pageSizes) {
    const o = document.createElement('option');
    o.value = String(s);
    o.textContent = String(s);
    sizeSelect.append(o);
  }
  sizeSelect.value = String(pageSize);
  sizeSelect.addEventListener('change', () => onChange({ page: 1, pageSize: Number(sizeSelect.value) }));

  const totalEl = makeSpan(total !== null ? `· всего ${total}` : '', 'pagination__total');

  el.append(prev, info, next, sizeLabel, sizeSelect, totalEl);

  if (showAdvanced) el.append(buildAdvanced({ page, pageSize, onChange }));
  return el;
}

function makeBtn(label, { disabled = false, onClick } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = label;
  btn.disabled = disabled;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function makeSpan(text, className) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function buildAdvanced({ page, pageSize, onChange }) {
  const adv = document.createElement('details');
  adv.className = 'pagination__advanced';
  const summary = document.createElement('summary');
  summary.textContent = 'Limit / Offset';
  adv.append(summary);

  const offsetInput = makeNumber({ value: (page - 1) * pageSize, min: 0, className: 'pagination__offset' });
  const limitInput = makeNumber({ value: pageSize, min: 1, max: 500, className: 'pagination__limit' });

  const apply = makeBtn('Применить', {
    onClick: () => {
      const newLimit = Math.max(1, Math.min(500, Number(limitInput.value) || pageSize));
      const newOffset = Math.max(0, Number(offsetInput.value) || 0);
      const newPage = Math.floor(newOffset / newLimit) + 1;
      onChange({ page: newPage, pageSize: newLimit });
    },
  });

  const body = document.createElement('div');
  body.className = 'pagination__advanced-body';
  body.append(field('offset', offsetInput), field('limit', limitInput), apply);
  adv.append(body);
  return adv;
}

function makeNumber({ value, min, max, className }) {
  const i = document.createElement('input');
  i.type = 'number';
  i.className = `input ${className}`;
  if (min !== undefined) i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.value = String(value);
  return i;
}

function field(label, input) {
  const wrap = document.createElement('label');
  wrap.className = 'pagination__field';
  const lbl = document.createElement('span');
  lbl.textContent = `${label}:`;
  wrap.append(lbl, input);
  return wrap;
}
