// Настройки проекта (только чтение): GET /api/db/settings/project. Не трогает DOM.
import { request } from './client.js';

export function getProjectSettings(opts = {}) {
  return request('/api/db/settings/project', opts);
}
