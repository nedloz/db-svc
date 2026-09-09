// Выгрузка данных архивом. Отдельный префикс /api/export/, а не /api/graph/export:
// под /api/graph/ в db-svc висит сквозной прокси в graph-rag-svc, и такой путь ушёл бы туда.
//
// TODO: импорт архива обратно. Нужен для переноса между стендами и для отката графа к
// прежнему состоянию. Продумать отдельно — см. TODO в app/services/export.py.

import { downloadFile } from './client.js';

export function downloadGraphArchive(opts = {}) {
  return downloadFile('/api/export/graph', { trackAs: 'Выгрузка графа', ...opts });
}

export function downloadChunksArchive({ embeddings = true } = {}, opts = {}) {
  const query = embeddings ? '' : '?embeddings=false';
  return downloadFile(`/api/export/chunks${query}`, { trackAs: 'Выгрузка чанков', ...opts });
}
