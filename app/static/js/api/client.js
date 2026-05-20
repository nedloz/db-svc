// HTTP-клиент для всех запросов фронта. Единственное место, где живёт работа
// с админ-токеном (Authorization: Bearer ...). Не трогает DOM.
//
// Опция `trackAs` регистрирует запрос в глобальном operations-tracker, чтобы
// он отобразился в индикаторе шапки и пользователь мог отменить его кнопкой.

import { startOperation } from '../state/operations.js';

const TOKEN_KEY = 'dbsvc_token';
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
      response = await fetch(path, {
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
