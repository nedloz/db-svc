// Список объектов bucket с фильтрами и действиями (download / delete).
// Бэк отдаёт максимум 200 объектов; для пагинации поверх 200 нужен P-008
// (не блокирует, но в UI висит warning).
//
// Search — клиентский подстроковый по key, prefix — серверный (re-fetch).
// Download использует presigned URL; на 403 (истекла подпись) делаем new presign
// прозрачно (см. openObject) — пользователь не видит обновления URL.

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
  });

  const root = document.createElement('div');
  root.className = 'minio-list';
  container.replaceChildren(root);

  let prefixTimer = null;
  const unsubscribe = store.subscribe(render);
  load();
  render();
  return {
    unmount: () => { if (prefixTimer) clearTimeout(prefixTimer); unsubscribe(); },
    refresh: load,
  };

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildToolbar(s));
    if (s.error) { root.append(createErrorView(s.error)); return; }
    if (s.loading && !s.items.length) { root.append(createLoader({ label: 'Загружаю объекты…' })); return; }
    root.append(buildList(s));
  }

  function buildToolbar(s) {
    const bar = document.createElement('div');
    bar.className = 'minio-list__toolbar';

    const prefixInput = createInput({
      value: s.prefix,
      placeholder: 'Префикс (серверный фильтр)',
      onInput: (val) => {
        store.set({ prefix: val });
        if (prefixTimer) clearTimeout(prefixTimer);
        prefixTimer = setTimeout(load, PREFIX_DEBOUNCE_MS);
      },
    });
    prefixInput.classList.add('minio-list__prefix');

    const searchInput = createInput({
      value: s.search,
      placeholder: 'Поиск по key (клиентский)',
      onInput: (val) => store.set({ search: val }),
    });
    searchInput.classList.add('minio-list__search');

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn minio-list__refresh';
    refreshBtn.textContent = '↻ Обновить';
    refreshBtn.disabled = s.loading;
    refreshBtn.addEventListener('click', load);

    const bulkBtn = document.createElement('button');
    bulkBtn.type = 'button';
    bulkBtn.className = 'btn btn--danger minio-list__bulk-delete';
    bulkBtn.textContent = `Удалить выбранные${s.selected.size ? ` (${s.selected.size})` : ''}`;
    bulkBtn.disabled = !s.selected.size;
    bulkBtn.addEventListener('click', bulkDelete);

    bar.append(prefixInput, searchInput, refreshBtn, bulkBtn);
    return bar;
  }

  function buildList(s) {
    const visible = s.search
      ? s.items.filter((it) => it.key.toLowerCase().includes(s.search.toLowerCase()))
      : s.items;

    const wrap = document.createElement('div');
    wrap.className = 'minio-list__list';

    const summary = document.createElement('div');
    summary.className = 'minio-list__summary';
    let summaryText = `Bucket: ${s.bucket || '—'} · показано: ${visible.length} из ${s.items.length}`;
    // TODO(backend): P-009 — pagination via continuation_token (бэк хардкодит MaxKeys=200).
    if (s.items.length >= 200) summaryText += ' · лимит API (200) — уточните prefix, чтобы увидеть больше';
    summary.textContent = summaryText;
    wrap.append(summary);

    if (!visible.length) {
      wrap.append(createEmptyState({
        title: 'Объектов нет',
        description: s.search ? 'Под текущий поиск ничего не подходит на текущей странице.' : 'Bucket пуст или prefix ничего не сматчил.',
      }));
      return wrap;
    }

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
    wrap.append(table);
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

  // ----- data ops -----

  async function load() {
    const { prefix } = store.get();
    store.set({ loading: true, error: null });
    try {
      const { bucket, items } = await listObjects(prefix, { trackAs: 'MinIO: объекты' });
      // Чистим selected от уже несуществующих ключей.
      const presentKeys = new Set(items.map((i) => i.key));
      const selected = new Set([...store.get().selected].filter((k) => presentKeys.has(k)));
      store.set({ bucket, items, selected, loading: false });
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
      await load();
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
    await load();
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
