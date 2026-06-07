// Вкладка «Импорт»: две карточки в стиле страницы «База данных».
//  - CSV в существующую таблицу (csv.js)
//  - Связанный датасет с UUID-ремаппингом (dataset.js)
import { mountCsvImport } from './csv.js';
import { mountDatasetImport } from './dataset.js';

export const importView = {
  title: 'Импорт',
  hash: '#/import',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'import-view';
    container.replaceChildren(root);

    const csv = buildCard(
      'Импорт CSV в таблицу',
      'Залить CSV-файл в существующую таблицу через COPY. Режим append или replace.',
    );
    const ds = buildCard(
      'Связанный датасет',
      'Импорт 8 связанных CSV с автоматическим UUID-ремаппингом. Сначала dry-run, затем «Применить».',
    );
    root.append(csv.card, ds.card);

    const unmountCsv = mountCsvImport(csv.host);
    const unmountDs = mountDatasetImport(ds.host);

    return () => {
      try { unmountCsv?.(); } catch (_e) { /* swallow */ }
      try { unmountDs?.(); } catch (_e) { /* swallow */ }
    };
  },
};

function buildCard(title, subtitle) {
  const card = document.createElement('section');
  card.className = 'card import-view__card';

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
  host.className = 'import-view__host';
  card.append(host);

  return { card, host };
}
