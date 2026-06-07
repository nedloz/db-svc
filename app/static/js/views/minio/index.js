// Вкладка MinIO: четыре карточки в стиле страницы «База данных».
//  1) Объекты bucket — list.js (фильтры, скачать, удалить).
//  2) Загрузка — upload.js (presigned PUT через XHR + прогресс + retry на 403).
//  3) Импорт файлов в БД — import-files.js (мэтчинг title → library.documents).
//  4) Импорт HTML из documents.origin_url — import-html.js (bulk-загрузка).
//
// После загрузки/импорта дёргаем list.refresh(), чтобы пользователь сразу
// видел изменения в bucket.

import { mountMinioList } from './list.js';
import { mountMinioUpload } from './upload.js';
import { mountMinioImportFiles } from './import-files.js';
import { mountMinioImportHtml } from './import-html.js';

export const minioView = {
  title: 'MinIO',
  hash: '#/minio',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'minio-view';
    container.replaceChildren(root);

    const listCard = buildCard(
      'Объекты bucket',
      'Файлы в MinIO. Префикс — серверный фильтр, поиск — по текущей странице.',
    );
    const uploadCard = buildCard(
      'Загрузка файлов',
      'Загрузка по presigned URL с прогрессом. Можно выбрать несколько файлов сразу.',
    );
    const impFilesCard = buildCard(
      'Импорт файлов в documents',
      'Матч по имени файла (без расширения) ↔ library.documents.title. Сначала dry-run.',
    );
    const impHtmlCard = buildCard(
      'Импорт HTML из origin_url',
      'Скачать HTML по library.documents.origin_url и положить в MinIO. Сначала dry-run.',
    );
    root.append(listCard.card, uploadCard.card, impFilesCard.card, impHtmlCard.card);

    const list = mountMinioList(listCard.host);
    const refreshList = () => { try { list?.refresh?.(); } catch (_e) { /* swallow */ } };

    const unmountUpload   = mountMinioUpload(uploadCard.host,        { onUploaded: refreshList });
    const unmountImpFiles = mountMinioImportFiles(impFilesCard.host, { onImported: refreshList });
    const unmountImpHtml  = mountMinioImportHtml(impHtmlCard.host,   { onImported: refreshList });

    return () => {
      try { list?.unmount?.(); }   catch (_e) { /* swallow */ }
      try { unmountUpload?.(); }   catch (_e) { /* swallow */ }
      try { unmountImpFiles?.(); } catch (_e) { /* swallow */ }
      try { unmountImpHtml?.(); }  catch (_e) { /* swallow */ }
    };
  },
};

function buildCard(title, subtitle) {
  const card = document.createElement('section');
  card.className = 'card minio-view__card';

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
  host.className = 'minio-view__host';
  card.append(host);

  return { card, host };
}
