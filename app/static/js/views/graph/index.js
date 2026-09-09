// Вкладка «Граф» — курирование графа сущностей.
//
// Граф наполняет graph-rag-svc, а правится он здесь. Все операции идут через
// /api/graph/* (прокси к /internal/graph/* сервиса graph-rag-svc), а НЕ прямым CRUD по
// таблицам graph.*: построение графа работает через upsert, поэтому правка, сделанная
// в обход правил сервиса, была бы отменена ближайшей пересборкой.
//
// Две главные операции: склейка дубликатов («Учебный офис» / «учебный офис» / «УО») и
// исправление entity_type у сущностей с типом unknown.

import { mountGraphStats } from './stats.js';
import { mountEntityBrowser } from './entities.js';

export const graphView = {
  title: 'Граф',
  hash: '#/graph',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'graph-view';
    container.replaceChildren(root);

    const statsCard = buildCard(
      'Состояние графа',
      'Сущности по типам, связи, последние прогоны построения.',
    );
    const browserCard = buildCard(
      'Сущности',
      'Поиск, карточка сущности, склейка дубликатов и правка типа. Удаление со стоп-листом переживает пересборку графа.',
    );
    root.append(statsCard.card, browserCard.card);

    const stats = mountGraphStats(statsCard.host);
    const browser = mountEntityBrowser(browserCard.host, {
      onChanged: () => { try { stats?.refresh?.(); } catch (_e) { /* swallow */ } },
    });

    return () => {
      try { stats?.unmount?.(); } catch (_e) { /* swallow */ }
      try { browser?.unmount?.(); } catch (_e) { /* swallow */ }
    };
  },
};

function buildCard(title, subtitle) {
  const card = document.createElement('section');
  card.className = 'card graph-view__card';

  const header = document.createElement('div');
  header.className = 'card__header';
  const h = document.createElement('h2');
  h.className = 'card__title';
  h.textContent = title;
  header.append(h);
  card.append(header);

  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'card__subtitle';
    sub.textContent = subtitle;
    card.append(sub);
  }

  const host = document.createElement('div');
  host.className = 'graph-view__host';
  card.append(host);

  return { card, host };
}
