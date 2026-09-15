// Список объектов bucket с фильтрами и действиями (download / delete).
//
// Список свёрнут по умолчанию и раскрывается по клику: в bucket'е лежат все файлы всех
// документов, и развёрнутой таблицей он занимал всю страницу, вытесняя загрузку и импорт.
// В раскрытом виде показывается одна страница с ограничением по высоте.
//
// Пагинация курсорная, как её отдаёт MinIO: continuation_token ведёт только вперёд,
// прыгнуть на произвольную страницу нельзя. Назад возвращаемся по стеку уже пройденных
// токенов (tokenStack). Раньше фронт брал ровно одну страницу в 200 объектов и показывал
// предупреждение, что дальше не видно, хотя бэк умел отдавать продолжение.
//
// Search — клиентский подстроковый по key в пределах текущей страницы, prefix — серверный
// (re-fetch с первой страницы). Download использует presigned URL; на 403 (истекла подпись)
// делаем new presign прозрачно (см. openObject).

import { createStore } from '../../state/store.js';
import { createInput } from '../../components/form-controls.js';
import { createLoader } from '../../components/loader.js';
import { createErrorView } from '../../components/error-view.js';
import { createEmptyState } from '../../components/empty-state.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import {
  listObjects,
  presignDownload,
  deleteObject,
} from '../../api/minio.js';

const PREFIX_DEBOUNCE_MS = 250;
const PAGE_SIZES = [10, 25, 50, 100];

export function mountMinioList(container) {
  // Возвращает { unmount, refresh } — index.js дёргает refresh после upload'ов.
  const store = createStore({
    prefix: '',
    search: '',
    items: [],
    bucket: '',
    selected: new Set(),
    loading: false,
    error: null,
    expanded: false,
    pageSize: 25,
    pageIndex: 1,
    tokenStack: [],      // токены предыдущих страниц, для кнопки «Назад»
    currentToken: null,
    nextToken: null,
  });

  const root = document.createElement('div');
  root.className = 'minio-list';
  container.replaceChildren(root);

  let prefixTimer = null;
  const unsubscribe = store.subscribe(render);
  loadPage(null);
  render();
  return {
    unmount: () => { if (prefixTimer) clearTimeout(prefixTimer); unsubscribe(); },
    // index.js зовёт это после загрузки и импорта — раскрываем список, иначе результат
    // операции оказывается спрятан за свёрнутым блоком.
    refresh: () => { store.set({ expanded: true }); return reload(); },
  };

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildDisclosure(s));
  }

  // ----- разметка -----

  function buildDisclosure(s) {
    const details = document.createElement('details');
    details.className = 'minio-list__disclosure';
    details.open = s.expanded;
    details.addEventListener('toggle', () => {
      if (details.open !== store.get().expanded) store.set({ expanded: details.open });
    });

    const summary = document.createElement('summary');
    summary.className = 'minio-list__summary';

    const title = document.createElement('span');
    title.className = 'minio-list__summary-title';
    title.textContent = 'Объекты bucket';
    summary.append(title);

    const meta = document.createElement('span');
    meta.className = 'minio-list__summary-meta';
    meta.textContent = s.loading
      ? 'загрузка…'
      : `${s.bucket || '—'} · стр. ${s.pageIndex} · на странице: ${s.items.length}`;
    summary.append(meta);

    if (s.selected.size) {
      const chosen = document.createElement('span');
      chosen.className = 'minio-list__summary-selected';
      chosen.textContent = `выбрано: ${s.selected.size}`;
      summary.append(chosen);
    }

    details.append(summary);

    const body = document.createElement('div');
    body.className = 'minio-list__body';
    body.append(buildToolbar(s));
    if (s.error) body.append(createErrorView(s.error));
    else if (s.loading && !s.items.length) body.append(createLoader({ label: 'Загружаю объекты…' }));
    else body.append(buildList(s));
    body.append(buildPager(s));
    details.append(body);

    return details;
  }

  function buildToolbar(s) {
    const bar = document.createElement('div');
    bar.className = 'minio-list__toolbar';

    const prefixInput = createInput({
      value: s.prefix,
      placeholder: 'Префикс (серверный фильтр)',
      onInput: (val) => {
        // Смена префикса — это другой набор объектов: сбрасываем и страницы, и выбор.
        store.set({ prefix: val, selected: new Set() });
        if (prefixTimer) clearTimeout(prefixTimer);
        prefixTimer = setTimeout(() => resetToFirstPage(), PREFIX_DEBOUNCE_MS);
      },
    });
    prefixInput.classList.add('minio-list__prefix');

    const searchInput = createInput({
      value: s.search,
      placeholder: 'Поиск по key (в пределах страницы)',
      onInput: (val) => store.set({ search: val }),
    });
    searchInput.classList.add('minio-list__search');

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn minio-list__refresh';
    refreshBtn.textContent = '↻ Обновить';
    refreshBtn.disabled = s.loading;
    refreshBtn.addEventListener('click', () => reload());

    const bulkBtn = document.createElement('button');
    bulkBtn.type = 'button';
    bulkBtn.className = 'btn btn--danger minio-list__bulk-delete';
    bulkBtn.textContent = `Удалить выбранные${s.selected.size ? ` (${s.selected.size})` : ''}`;
    bulkBtn.disabled = !s.selected.size;
    bulkBtn.addEventListener('click', bulkDelete);

    bar.append(prefixInput, searchInput, refreshBtn, bulkBtn);
    return bar;
  }

  function buildPager(s) {
    const bar = document.createElement('div');
    bar.className = 'minio-list__pager';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn';
    prev.textContent = '← Назад';
    prev.disabled = s.loading || !s.tokenStack.length;
    prev.addEventListener('click', goPrev);

    const info = document.createElement('span');
    info.className = 'minio-list__pager-info';
    info.textContent = `Стр. ${s.pageIndex}`;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn';
    next.textContent = 'Вперёд →';
    next.disabled = s.loading || !s.nextToken;
    next.addEventListener('click', goNext);

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'minio-list__pager-label';
    sizeLabel.textContent = '· на странице:';

    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'select minio-list__pager-size';
    for (const size of PAGE_SIZES) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      sizeSelect.append(option);
    }
    sizeSelect.value = String(s.pageSize);
    sizeSelect.disabled = s.loading;
    // Размер страницы меняет нарезку курсором — начинаем заново с первой.
    sizeSelect.addEventListener('change', () => {
      store.set({ pageSize: Number(sizeSelect.value) });
      resetToFirstPage();
    });

    bar.append(prev, info, next, sizeLabel, sizeSelect);

    if (!s.nextToken && s.pageIndex === 1 && !s.loading) {
      const all = document.createElement('span');
      all.className = 'minio-list__pager-note';
      all.textContent = '· это все объекты';
      bar.append(all);
    }
    return bar;
  }

  function buildList(s) {
    const visible = s.search
      ? s.items.filter((it) => it.key.toLowerCase().includes(s.search.toLowerCase()))
      : s.items;

    const wrap = document.createElement('div');
    wrap.className = 'minio-list__list';

    if (!visible.length) {
      wrap.append(createEmptyState({
        title: 'Объектов нет',
        description: s.search
          ? 'Под текущий поиск ничего не подходит на этой странице — поиск работает только по загруженной странице.'
          : 'Bucket пуст или prefix ничего не сматчил.',
      }));
      return wrap;
    }

    const scroller = document.createElement('div');
    scroller.className = 'minio-list__scroller';

    const table = document.createElement('table');
    table.className = 'minio-list__table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const thSel = document.createElement('th');
    thSel.className = 'minio-list__th--select';
    const headCb = document.createElement('input');
    headCb.type = 'checkbox';
    const visibleKeys = visible.map((v) => v.key);
    const allChecked = visibleKeys.length > 0 && visibleKeys.every((k) => s.selected.has(k));
    const someChecked = !allChecked && visibleKeys.some((k) => s.selected.has(k));
    headCb.checked = allChecked;
    headCb.indeterminate = someChecked;
    headCb.title = 'Выбрать всё на этой странице';
    headCb.addEventListener('change', () => {
      const next = new Set(s.selected);
      if (headCb.checked) for (const k of visibleKeys) next.add(k);
      else for (const k of visibleKeys) next.delete(k);
      store.set({ selected: next });
    });
    thSel.append(headCb);
    headRow.append(thSel);
    for (const h of ['key', 'размер', 'изменён', 'действия']) {
      const th = document.createElement('th'); th.textContent = h; headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const item of visible) tbody.append(buildRow(item, s.selected));
    table.append(tbody);
    scroller.append(table);
    wrap.append(scroller);

    if (s.search && visible.length !== s.items.length) {
      const note = document.createElement('div');
      note.className = 'minio-list__note';
      note.textContent = `Показано ${visible.length} из ${s.items.length} на этой странице. Поиск не уходит на другие страницы — сузьте префикс.`;
      wrap.append(note);
    }
    return wrap;
  }

  function buildRow(item, selected) {
    const tr = document.createElement('tr');
    if (selected.has(item.key)) tr.classList.add('minio-list__tr--selected');

    const tdCb = document.createElement('td');
    tdCb.className = 'minio-list__td--select';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(item.key);
    cb.addEventListener('change', () => {
      const next = new Set(store.get().selected);
      if (cb.checked) next.add(item.key); else next.delete(item.key);
      store.set({ selected: next });
    });
    tdCb.append(cb);
    tr.append(tdCb);

    const tdKey = document.createElement('td');
    tdKey.className = 'minio-list__td--key';
    tdKey.textContent = item.key;
    tdKey.title = item.key;
    tr.append(tdKey);

    const tdSize = document.createElement('td');
    tdSize.textContent = formatBytes(item.size);
    tr.append(tdSize);

    const tdMod = document.createElement('td');
    tdMod.textContent = item.last_modified || '—';
    tr.append(tdMod);

    const tdActions = document.createElement('td');
    tdActions.className = 'minio-list__td--actions';
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn minio-list__download';
    dlBtn.textContent = 'Скачать';
    dlBtn.addEventListener('click', () => openObject(item.key));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--danger minio-list__delete';
    delBtn.textContent = 'Удалить';
    delBtn.addEventListener('click', () => singleDelete(item.key));
    tdActions.append(dlBtn, delBtn);
    tr.append(tdActions);
    return tr;
  }

  // ----- пагинация -----

  function resetToFirstPage() {
    store.set({ tokenStack: [], currentToken: null, pageIndex: 1 });
    loadPage(null);
  }

  function reload() {
    // Перечитываем текущую страницу тем же токеном, не сбивая позицию.
    return loadPage(store.get().currentToken);
  }

  function goNext() {
    const s = store.get();
    if (!s.nextToken) return;
    store.set({
      tokenStack: [...s.tokenStack, s.currentToken],
      pageIndex: s.pageIndex + 1,
    });
    loadPage(s.nextToken);
  }

  function goPrev() {
    const s = store.get();
    if (!s.tokenStack.length) return;
    const stack = [...s.tokenStack];
    const token = stack.pop();
    store.set({ tokenStack: stack, pageIndex: Math.max(1, s.pageIndex - 1) });
    loadPage(token);
  }

  // ----- data ops -----

  async function loadPage(token) {
    const { prefix, pageSize } = store.get();
    store.set({ loading: true, error: null });
    try {
      const { bucket, items, nextToken } = await listObjects(prefix, {
        maxKeys: pageSize,
        continuationToken: token,
        trackAs: 'MinIO: объекты',
      });
      // selected намеренно не чистим по загруженной странице: выбор живёт между
      // страницами, а удаление несуществующего ключа MinIO принимает молча.
      store.set({ bucket, items, nextToken, currentToken: token, loading: false });
    } catch (err) {
      store.set({ loading: false, error: err });
    }
  }

  async function openObject(key) {
    try {
      const { url } = await presignDownload(key, { trackAs: `Скачать ${key}` });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(`Не удалось получить URL: ${err?.message || err}`);
    }
  }

  async function singleDelete(key) {
    const ok = await openConfirm({
      title: 'Удалить объект',
      body: `Удалить из bucket: ${key}?`,
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteObject(key, { trackAs: `MinIO delete ${key}` });
      toast.success('Объект удалён');
      const next = new Set(store.get().selected); next.delete(key);
      store.set({ selected: next });
      await reload();
    } catch (err) {
      toast.error(`Не удалось удалить: ${err?.message || err}`);
    }
  }

  async function bulkDelete() {
    const keys = [...store.get().selected];
    if (!keys.length) return;
    const ok = await openConfirm({
      title: `Удалить ${keys.length} объектов`,
      body: `Удалить ${keys.length} объектов из bucket? Это нельзя отменить.`,
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const key of keys) {
      try {
        await deleteObject(key, { trackAs: `MinIO delete ${key}` });
      } catch (_e) {
        failed++;
      }
    }
    toast[failed ? 'warn' : 'success'](`Удалено: ${keys.length - failed}${failed ? `, ошибок: ${failed}` : ''}`);
    store.set({ selected: new Set() });
    await reload();
  }
}

// ===== helpers =====

function openConfirm({ title, body, danger }) {
  return new Promise((resolve) => {
    const text = document.createElement('p');
    text.textContent = body;
    let resolved = false;
    const ctl = openModal({
      title,
      body: text,
      actions: [
        { label: 'Отмена', onClick: (close) => { if (!resolved) { resolved = true; resolve(false); } close(); } },
        {
          label: 'Удалить', variant: danger ? 'danger' : 'primary',
          onClick: (close) => { resolved = true; resolve(true); close(); },
        },
      ],
      onClose: () => { if (!resolved) { resolved = true; resolve(false); } },
    });
    void ctl;
  });
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ`;
}
