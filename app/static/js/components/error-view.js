// Единый разбор ошибок API/сетевых. Принимает Error / ApiError, возвращает DOM.
import { ApiError } from '../api/client.js';

export function createErrorView(error) {
  const el = document.createElement('div');
  el.className = 'error-view';
  el.setAttribute('role', 'alert');

  const title = document.createElement('div');
  title.className = 'error-view__title';
  title.textContent = humanTitle(error);
  el.append(title);

  const message = document.createElement('div');
  message.textContent = humanMessage(error);
  el.append(message);

  const detailsText = formatDetails(error);
  if (detailsText) {
    const details = document.createElement('details');
    details.className = 'error-view__details';
    const summary = document.createElement('summary');
    summary.textContent = 'Технические детали';
    const pre = document.createElement('pre');
    pre.textContent = detailsText;
    details.append(summary, pre);
    el.append(details);
  }
  return el;
}

function humanTitle(error) {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Сетевая ошибка';
    if (error.status === 401) return 'Требуется авторизация';
    if (error.status === 403) return 'Неверный токен';
    if (error.status === 404) return 'Не найдено';
    if (error.status >= 500) return 'Ошибка сервера';
    return `Ошибка ${error.status}`;
  }
  return 'Ошибка';
}

function humanMessage(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Вставьте админ-токен в поле в шапке.';
    if (error.status === 403) return 'Токен не подходит. Проверьте значение DBSVC_ADMIN_TOKEN.';
  }
  return error?.message || String(error);
}

function formatDetails(error) {
  if (error instanceof ApiError && error.payload) {
    try {
      return JSON.stringify(error.payload, null, 2);
    } catch (_e) {
      return String(error.payload);
    }
  }
  if (error?.stack) return error.stack;
  return null;
}
