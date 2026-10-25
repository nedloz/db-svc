// Загрузка файлов в MinIO через db-svc: POST /api/minio/upload (multipart).
// Идём не через fetch, а через XMLHttpRequest — нужен прогресс (`upload.onprogress`),
// fetch его в браузерах не отдаёт.
//
// Раньше файл уходил в MinIO прямо из браузера по presigned PUT, но порт MinIO наружу не
// открыт (снаружи виден только nginx), и такая загрузка падала с ERR_CONNECTION_REFUSED.
// Теперь файл принимает db-svc и кладёт в MinIO по внутренней сети.
//
// Регистрация в operations-indicator (M4) идёт вручную через startOperation,
// потому что мы не дёргаем `request()` для самой загрузки.

import { createStore } from '../../state/store.js';
import { createInput, createFilePicker } from '../../components/form-controls.js';
import { toast } from '../../components/toast.js';
import { getToken, resolveUrl } from '../../api/client.js';
import { startOperation } from '../../state/operations.js';

const DEFAULT_PREFIX = 'uploads/';

export function mountMinioUpload(container, { onUploaded } = {}) {
  const store = createStore({
    prefix: DEFAULT_PREFIX,
    queue: [],            // [{ id, file, key, status, progress, error }]
    running: false,
  });

  const root = document.createElement('div');
  root.className = 'minio-upload';
  container.replaceChildren(root);

  const unsubscribe = store.subscribe(render);
  render();
  return () => unsubscribe();

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildForm(s));
    if (s.queue.length) root.append(buildQueue(s));
  }

  function buildForm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-upload__form';

    const prefixInput = createInput({
      value: s.prefix,
      placeholder: 'Префикс ключа в bucket',
      onInput: (val) => store.set({ prefix: val }),
    });
    prefixInput.classList.add('minio-upload__prefix');
    const prefixLbl = document.createElement('label');
    prefixLbl.className = 'minio-upload__field';
    const sp = document.createElement('span'); sp.textContent = 'Префикс ключа: ';
    prefixLbl.append(sp, prefixInput);
    wrap.append(prefixLbl);

    const filePicker = createFilePicker({
      multiple: true,
      label: 'Выберите файлы',
      onChange: (files) => enqueue(files || []),
    });
    filePicker.classList.add('minio-upload__file');
    wrap.append(filePicker);

    if (s.running) {
      const hint = document.createElement('div');
      hint.className = 'minio-upload__busy-hint';
      hint.textContent = 'Идёт загрузка — отмена через индикатор операций в шапке.';
      wrap.append(hint);
    }
    return wrap;
  }

  function buildQueue(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-upload__queue';

    const head = document.createElement('div');
    head.className = 'minio-upload__queue-head';
    const summary = summarize(s.queue);
    head.textContent =
      `Очередь: ${s.queue.length} файлов · ` +
      `готово ${summary.done} · ошибок ${summary.failed} · в работе ${summary.inflight}`;
    wrap.append(head);

    const list = document.createElement('ul');
    list.className = 'minio-upload__items';
    for (const item of s.queue) list.append(buildItem(item));
    wrap.append(list);

    if (summary.done + summary.failed === s.queue.length) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn minio-upload__clear';
      clearBtn.textContent = 'Очистить очередь';
      clearBtn.addEventListener('click', () => store.set({ queue: [] }));
      wrap.append(clearBtn);
    }
    return wrap;
  }

  function buildItem(item) {
    const li = document.createElement('li');
    li.className = `minio-upload__item minio-upload__item--${item.status}`;

    const meta = document.createElement('div');
    meta.className = 'minio-upload__item-meta';
    const name = document.createElement('span');
    name.className = 'minio-upload__item-name';
    name.textContent = item.file.name;
    const size = document.createElement('span');
    size.className = 'minio-upload__item-size';
    size.textContent = ` · ${formatBytes(item.file.size)} · key=${item.key}`;
    const status = document.createElement('span');
    status.className = `minio-upload__item-status minio-upload__item-status--${item.status}`;
    status.textContent = ` · ${statusLabel(item.status)}`;
    meta.append(name, size, status);
    li.append(meta);

    if (item.status === 'uploading' || item.status === 'presigning' || item.status === 'done') {
      const bar = document.createElement('div');
      bar.className = 'minio-upload__bar';
      const fill = document.createElement('div');
      fill.className = 'minio-upload__bar-fill';
      fill.style.width = `${item.progress}%`;
      const text = document.createElement('span');
      text.className = 'minio-upload__bar-text';
      text.textContent = `${item.progress}%`;
      bar.append(fill, text);
      li.append(bar);
    }
    if (item.error) {
      const err = document.createElement('div');
      err.className = 'minio-upload__item-error';
      err.textContent = item.error;
      li.append(err);
    }
    return li;
  }

  function enqueue(files) {
    if (!files.length) return;
    const { prefix } = store.get();
    const added = files.map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      file,
      key: buildKey(prefix, file.name),
      status: 'queued',
      progress: 0,
      error: null,
    }));
    store.set({ queue: [...store.get().queue, ...added] });
    runQueueIfIdle();
  }

  async function runQueueIfIdle() {
    if (store.get().running) return;
    store.set({ running: true });
    try {
      while (true) {
        const next = store.get().queue.find((q) => q.status === 'queued');
        if (!next) break;
        await uploadOne(next.id);
      }
    } finally {
      store.set({ running: false });
      const failed = store.get().queue.filter((q) => q.status === 'failed').length;
      const done = store.get().queue.filter((q) => q.status === 'done').length;
      if (done) toast.success(`Загружено: ${done}${failed ? `, ошибок: ${failed}` : ''}`);
      else if (failed) toast.error(`Загрузка завершилась с ${failed} ошибками`);
      onUploaded?.();
    }
  }

  async function uploadOne(id) {
    updateItem(id, { status: 'uploading', progress: 0, error: null });
    const item = getItem(id);
    if (!item) return;

    try {
      const result = await uploadWithProgress(id, item.key, item.file);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`HTTP ${result.status}: ${result.detail || result.statusText || 'upload failed'}`);
      }
      updateItem(id, { status: 'done', progress: 100, error: null });
    } catch (err) {
      updateItem(id, { status: 'failed', error: err?.message || String(err) });
    }
  }

  // Возвращает Promise<{status, statusText, detail}>. Reject — только сеть / abort.
  // Файл уходит в db-svc (POST /api/minio/upload), а не прямо в MinIO: порт MinIO наружу
  // не открыт, и presigned PUT из браузера упирался в ERR_CONNECTION_REFUSED.
  function uploadWithProgress(id, key, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const controller = new AbortController();
      const opHandle = startOperation({
        label: `Upload ${file.name}`,
        controller,
      });
      controller.signal.addEventListener('abort', () => { xhr.abort(); }, { once: true });

      xhr.open('POST', resolveUrl('api/minio/upload'));
      // Под /admin/ авторизует кука админ-сессии; при прямом доступе — Bearer-токен панели.
      const token = getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      const form = new FormData();
      form.append('key', key);
      form.append('file', file, file.name);

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        updateItem(id, { progress: pct });
      };
      xhr.onload = () => {
        opHandle?.finish();
        let detail = '';
        try { detail = JSON.parse(xhr.responseText)?.detail || ''; } catch (_e) { /* не JSON */ }
        resolve({ status: xhr.status, statusText: xhr.statusText, detail });
      };
      xhr.onerror = () => {
        opHandle?.finish();
        reject(new Error('Сетевая ошибка при загрузке'));
      };
      xhr.onabort = () => {
        opHandle?.finish();
        reject(new Error('Загрузка отменена'));
      };

      xhr.send(form);
    });
  }

  function getItem(id) { return store.get().queue.find((q) => q.id === id); }
  function updateItem(id, patch) {
    const queue = store.get().queue.map((q) => (q.id === id ? { ...q, ...patch } : q));
    store.set({ queue });
  }
}

// ===== helpers =====

function buildKey(prefix, name) {
  const safe = String(name).replace(/^\/+/, '');
  const p = (prefix || '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${safe}` : safe;
}

function statusLabel(status) {
  switch (status) {
    case 'queued':     return 'в очереди';
    case 'presigning': return 'подготовка…';
    case 'uploading':  return 'грузится';
    case 'done':       return '✓ загружено';
    case 'failed':     return '✗ ошибка';
    default:           return status;
  }
}

function summarize(queue) {
  const out = { done: 0, failed: 0, inflight: 0 };
  for (const q of queue) {
    if (q.status === 'done') out.done++;
    else if (q.status === 'failed') out.failed++;
    else if (q.status === 'uploading' || q.status === 'presigning') out.inflight++;
  }
  return out;
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ`;
}
