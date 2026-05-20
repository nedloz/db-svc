// Вкладка MinIO (M9). Четыре секции:
//  1) Объекты bucket — list.js (фильтры, скачать, удалить).
//  2) Загрузка — upload.js (presigned PUT через XHR + прогресс + retry на 403).
//  3) Импорт файлов в БД — import-files.js (мэтчинг title → library.documents).
//  4) Импорт HTML из documents.origin_url — import-html.js (bulk-загрузка).
//
// После загрузки upload-секции или импорта дёргаем list.refresh(), чтобы
// пользователь сразу видел изменения в bucket.

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

    const sections = [
      ['Объекты bucket',                                'minio-view__section--list'],
      ['Загрузка',                                      'minio-view__section--upload'],
      ['Импорт файлов с привязкой к library.documents', 'minio-view__section--import-files'],
      ['Импорт HTML из library.documents.origin_url',   'minio-view__section--import-html'],
    ].map(([title, cls]) => {
      const section = document.createElement('section');
      section.className = `minio-view__section ${cls}`;
      const h = document.createElement('h3');
      h.className = 'minio-view__section-title';
      h.textContent = title;
      const host = document.createElement('div');
      section.append(h, host);
      root.append(section);
      return host;
    });

    const [listHost, uploadHost, impFilesHost, impHtmlHost] = sections;

    const list = mountMinioList(listHost);
    const refreshList = () => { try { list?.refresh?.(); } catch (_e) { /* swallow */ } };

    const unmountUpload   = mountMinioUpload(uploadHost,        { onUploaded: refreshList });
    const unmountImpFiles = mountMinioImportFiles(impFilesHost, { onImported: refreshList });
    const unmountImpHtml  = mountMinioImportHtml(impHtmlHost,   { onImported: refreshList });

    return () => {
      try { list?.unmount?.(); }   catch (_e) { /* swallow */ }
      try { unmountUpload?.(); }   catch (_e) { /* swallow */ }
      try { unmountImpFiles?.(); } catch (_e) { /* swallow */ }
      try { unmountImpHtml?.(); }  catch (_e) { /* swallow */ }
    };
  },
};
