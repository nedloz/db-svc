// Реестр флагов USE_MOCK_*. Каждый связан с записью в docs/PROBLEMS.md.
// При появлении бэк-эндпоинта переключаем флаг в false — реальный fetch
// уже написан рядом с веткой мока в соответствующем модуле api/.

export const USE_MOCK_CRUD = true;       // P-001 — CRUD endpoints
export const USE_MOCK_FILTERS = true;    // P-002 — серверная фильтрация (where)
export const USE_MOCK_RELATIONS = true;  // P-003 — метаданные FK
export const USE_MOCK_CASCADE = true;    // P-004 — cascade preview
export const USE_MOCK_EXPORT = true;     // P-005 — экспорт CSV
