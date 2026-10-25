// Обёртки над /api/minio/*. Не трогают DOM. Загрузка в bucket идёт двумя шагами:
//  1) `presignUpload(key)` — фронт получает PUT-URL (живёт 10 минут);
//  2) сырой XHR PUT по этому URL с file body — см. views/minio/upload.js
//     (там же progress и retry на 403).
//
// Здесь только request-обёртки. trackAs (M4) — опционально.

import { request, getToken, resolveUrl } from './client.js';

const enc = encodeURIComponent;

// Постраничный листинг. MinIO отдаёт страницы курсором (continuation_token), а не
// offset'ом: прыгнуть на произвольную страницу нельзя, только идти вперёд от токена.
// Назад ходим по стеку уже виденных токенов — его держит вызывающий код.
export async function listObjects(prefix = '', { maxKeys, continuationToken, ...opts } = {}) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  if (maxKeys) params.set('max_keys', String(maxKeys));
  if (continuationToken) params.set('continuation_token', continuationToken);
  const qs = params.toString();

  const data = await request(`/api/minio/objects${qs ? `?${qs}` : ''}`, opts);
  return {
    bucket: data?.bucket || '',
    items: data?.items || [],
    isTruncated: Boolean(data?.is_truncated),
    nextToken: data?.next_continuation_token || null,
  };
}

// Скачивание через db-svc, а не по presigned URL: порт MinIO наружу не открыт. Читаем ответ
// через fetch, чтобы ушёл тот же Authorization/кука, что и у остальных запросов панели, и отдаём
// браузеру как файл.
export async function downloadObject(key) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(resolveUrl(`api/minio/download?key=${enc(key)}`), { headers, credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = key.split('/').pop() || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function presignUpload(key, contentType = 'application/octet-stream', opts = {}) {
  // Параметры идут query-string'ом (FastAPI без body-аннотации = query).
  return request(
    `/api/minio/presign/upload?key=${enc(key)}&content_type=${enc(contentType)}`,
    { method: 'POST', ...opts },
  );
}

export async function presignDownload(key, opts = {}) {
  return request(`/api/minio/presign/download?key=${enc(key)}`, opts);
}

export async function deleteObject(key, opts = {}) {
  return request(`/api/minio/object?key=${enc(key)}`, { method: 'DELETE', ...opts });
}

export async function getImportPlan(opts = {}) {
  return request('/api/minio/import-plan', opts);
}

export async function importFilesToMinio({ files, dryRun = false }, opts = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('dry_run', String(!!dryRun));
  return request('/api/minio/import/files', {
    method: 'POST',
    body: fd,
    timeout: 0,
    ...opts,
  });
}

export async function getHtmlImportPlan(opts = {}) {
  return request('/api/minio/import/html-plan', opts);
}

export async function importHtmlFromDocuments({ dryRun = false, force = false, limit = null }, opts = {}) {
  const fd = new FormData();
  fd.append('dry_run', String(!!dryRun));
  fd.append('force', String(!!force));
  if (limit != null && limit !== '') fd.append('limit', String(limit));
  return request('/api/minio/import/html-from-documents', {
    method: 'POST',
    body: fd,
    timeout: 0,
    ...opts,
  });
}
