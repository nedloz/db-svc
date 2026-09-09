// HTTP-клиент для всех запросов фронта. Единственное место, где живёт работа
// с админ-токеном (Authorization: Bearer ...). Не трогает DOM.
//
// Опция `trackAs` регистрирует запрос в глобальном operations-tracker, чтобы
// он отобразился в индикаторе шапки и пользователь мог отменить его кнопкой.

import { startOperation } from '../state/operations.js';

const TOKEN_KEY = 'dbsvc_token';

// Панель монтируется в двух местах: в корне (прямой доступ к db-svc с 127.0.0.1) и под
// /admin/ (через nginx, после проверки админ-сессии). Поэтому все запросы строятся
// ОТНОСИТЕЛЬНО каталога документа, а не от корня сайта — иначе под /admin/ они уходили бы
// на /api/... и не попадали бы в панель.
// Роутинг в приложении хэшевый, так что pathname не меняется при навигации.
const APP_BASE = new URL('.', window.location.href);

export function resolveUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), APP_BASE).toString();
}
const DEFAULT_TIMEOUT = 30000;

export class ApiError extends Error {
  constructor({ status, payload, message }) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeout = DEFAULT_TIMEOUT,
    trackAs = null,
  } = options;

  const finalHeaders = { ...headers };
  const token = getToken();
  if (token) finalHeaders['Authorization'] = `Bearer ${token}`;

  let payload = body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const opHandle = trackAs ? startOperation({ label: trackAs, controller }) : null;

  try {
    let response;
    try {
      response = await fetch(resolveUrl(path), {
        method,
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError({ status: 0, payload: null, message: 'Запрос отменён или таймаут' });
      }
      throw new ApiError({ status: 0, payload: null, message: `Сетевая ошибка: ${err.message}` });
    }

    const contentType = response.headers.get('content-type') || '';
    let parsed = null;
    try {
      if (contentType.includes('application/json')) parsed = await response.json();
      else if (response.status !== 204) parsed = await response.text();
    } catch (_e) {
      parsed = null;
    }

    if (!response.ok) {
      throw new ApiError({
        status: response.status,
        payload: parsed,
        message: extractMessage(parsed) || `HTTP ${response.status}`,
      });
    }
    return parsed;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    opHandle?.finish();
  }
}

// Скачивание файла. Через fetch, а не обычной ссылкой: под /admin/ авторизует кука, а при
// прямом доступе к db-svc — заголовок Authorization из localStorage, и навигация браузера
// этот заголовок не несёт. Ответ забираем целиком в blob, поэтому годится для выгрузок
// разумного размера; для очень больших архивов понадобится потоковое сохранение.
export async function downloadFile(path, { filename = null, timeout = 300000, trackAs = null } = {}) {
  const finalHeaders = {};
  const token = getToken();
  if (token) finalHeaders['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  const opHandle = trackAs ? startOperation({ label: trackAs, controller }) : null;

  try {
    let response;
    try {
      response = await fetch(resolveUrl(path), { headers: finalHeaders, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError({ status: 0, payload: null, message: 'Скачивание отменено или таймаут' });
      }
      throw new ApiError({ status: 0, payload: null, message: `Сетевая ошибка: ${err.message}` });
    }

    if (!response.ok) {
      // Ошибку сервер отдаёт JSON'ом, а не архивом — разбираем её, чтобы показать причину.
      let parsed = null;
      try { parsed = await response.json(); } catch (_e) { parsed = null; }
      throw new ApiError({
        status: response.status,
        payload: parsed,
        message: extractMessage(parsed) || `HTTP ${response.status}`,
      });
    }

    // Имя берём из Content-Disposition, если сервер его задал: там дата выгрузки.
    let name = filename;
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    if (match) name = match[1];

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    // Освобождаем сразу после клика: браузер уже забрал данные.
    setTimeout(() => URL.revokeObjectURL(url), 0);

    return { filename: name, size: blob.size, rows: response.headers.get('x-export-rows') };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    opHandle?.finish();
  }
}

function extractMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    return payload.detail || payload.error || payload.message || null;
  }
  return null;
}

// ----- Liveness / connection helpers (используются M0 для индикаторов в шапке) -----

export async function getHealth(opts = {}) {
  return request('/health', opts);
}

export async function getDbConnectionStatus(opts = {}) {
  return request('/api/db/connection/status', opts);
}
