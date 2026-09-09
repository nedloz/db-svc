// Обёртки над /api/graph/* — прокси db-svc к внутреннему API графа в graph-rag-svc.
// Не трогают DOM. Все ошибки идут как ApiError.
//
// Важно: правки графа НЕ идут в таблицы graph.* напрямую. Все правила (резолюция,
// алиасинг, устойчивость правок к пересборке) живут в graph-rag-svc, здесь только вызовы.

import { request } from './client.js';

const enc = encodeURIComponent;

export function getGraphStats(opts = {}) {
  return request('/api/graph/stats', opts);
}

// Запуск пересборки графа. Сервис отвечает сразу — сборка идёт фоновой задачей, за ходом
// следят через getGraphStats().recent_runs. Ответ 409 означает, что прогон уже идёт,
// 403 — что запуск через API выключен флагом GRAPH_BUILD_API_ENABLED (так его гасят в проде).
// Без documentIds выполняется полная пересборка, со списком — только по этим документам.
export function startGraphBuild(documentIds = null, opts = {}) {
  return request('/api/graph/build', {
    ...opts,
    method: 'POST',
    body: documentIds && documentIds.length ? { document_ids: documentIds } : {},
  });
}

export function searchEntities({ q = '', entityType = '', limit = 50, offset = 0 } = {}, opts = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (entityType) params.set('entity_type', entityType);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request(`/api/graph/entities?${params.toString()}`, opts);
}

export function getEntity(entityId, opts = {}) {
  return request(`/api/graph/entities/${enc(entityId)}`, opts);
}

export function patchEntity(entityId, payload, opts = {}) {
  return request(`/api/graph/entities/${enc(entityId)}`, { ...opts, method: 'PATCH', body: payload });
}

// Склейка дубликатов — главная операция курирования. Имя исходной сущности становится
// алиасом целевой, поэтому следующая пересборка графа не создаст дубликат заново.
export function mergeEntity(sourceId, targetId, opts = {}) {
  return request(`/api/graph/entities/${enc(sourceId)}/merge`, {
    ...opts,
    method: 'POST',
    body: { target_id: targetId },
  });
}

export function addAlias(entityId, alias, opts = {}) {
  return request(`/api/graph/entities/${enc(entityId)}/aliases`, { ...opts, method: 'POST', body: { alias } });
}

export function deleteAlias(entityId, aliasId, opts = {}) {
  return request(`/api/graph/entities/${enc(entityId)}/aliases/${enc(aliasId)}`, { ...opts, method: 'DELETE' });
}

// blocklist=true заносит имена сущности в стоп-лист: без этого пересборка графа
// извлечёт то же имя и создаст запись снова.
export function deleteEntity(entityId, { blocklist = false, reason = '' } = {}, opts = {}) {
  const params = new URLSearchParams();
  params.set('blocklist', String(blocklist));
  if (reason) params.set('reason', reason);
  return request(`/api/graph/entities/${enc(entityId)}?${params.toString()}`, { ...opts, method: 'DELETE' });
}

export function deleteRelation(relationId, opts = {}) {
  return request(`/api/graph/relations/${enc(relationId)}`, { ...opts, method: 'DELETE' });
}

export function patchRelation(relationId, payload, opts = {}) {
  return request(`/api/graph/relations/${enc(relationId)}`, { ...opts, method: 'PATCH', body: payload });
}

export function getOrphans(limit = 200, opts = {}) {
  return request(`/api/graph/orphans?limit=${limit}`, opts);
}

export function getBlocklist(limit = 200, opts = {}) {
  return request(`/api/graph/blocklist?limit=${limit}`, opts);
}

export function removeBlocklistEntry(entryId, opts = {}) {
  return request(`/api/graph/blocklist/${enc(entryId)}`, { ...opts, method: 'DELETE' });
}
