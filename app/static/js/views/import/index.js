// Вкладка «Импорт». M7 — одиночный CSV. M8 — связанный датасет.
import { mountCsvImport } from './csv.js';
import { mountDatasetImport } from './dataset.js';

export const importView = {
  title: 'Импорт',
  hash: '#/import',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'import-view';
    container.replaceChildren(root);

    const csvSection = document.createElement('section');
    csvSection.className = 'import-view__section import-view__section--csv';
    const csvHeader = document.createElement('h3');
    csvHeader.className = 'import-view__section-title';
    csvHeader.textContent = 'CSV в существующую таблицу (M7)';
    csvSection.append(csvHeader);
    const csvHost = document.createElement('div');
    csvSection.append(csvHost);
    root.append(csvSection);

    const dsSection = document.createElement('section');
    dsSection.className = 'import-view__section import-view__section--dataset';
    const dsHeader = document.createElement('h3');
    dsHeader.className = 'import-view__section-title';
    dsHeader.textContent = 'Связанный датасет (M8)';
    dsSection.append(dsHeader);
    const dsHost = document.createElement('div');
    dsSection.append(dsHost);
    root.append(dsSection);

    const unmountCsv = mountCsvImport(csvHost);
    const unmountDs = mountDatasetImport(dsHost);

    return () => {
      try { unmountCsv?.(); } catch (_e) { /* swallow */ }
      try { unmountDs?.(); } catch (_e) { /* swallow */ }
    };
  },
};
