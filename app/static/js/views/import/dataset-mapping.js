// Декларативное описание полей связанного импорта (M8).
//
// Добавление новой таблицы в датасет = одна запись в массиве ниже + правка
// бэка (`app/services/import_pipeline.py` REQUIRED_FILES + pipeline +
// `app/routes/db.py` сигнатура `import_dataset`). Фронт без бэка не сможет
// слать новые поля multipart'ом.
//
// Порядок записей в массиве определяет порядок полей в UI и порядок секций
// в отчёте. Соответствует REQUIRED_FILES в [import_pipeline.py](../../../../app/services/import_pipeline.py).

export const DATASET_FIELDS = [
  { field: 'universities',       schema: 'core',    table: 'universities',        required: true, defaultFilename: 'core - universities.csv' },
  { field: 'campuses',           schema: 'core',    table: 'campuses',            required: true, defaultFilename: 'core - campuses.csv' },
  { field: 'faculties',          schema: 'core',    table: 'faculties',           required: true, defaultFilename: 'core - faculties.csv' },
  { field: 'buildings',          schema: 'core',    table: 'buildings',           required: true, defaultFilename: 'core - buildings.csv' },
  { field: 'programs',           schema: 'core',    table: 'programs',            required: true, defaultFilename: 'core - programs.csv' },
  { field: 'topics',             schema: 'library', table: 'topics',              required: true, defaultFilename: 'library - topics.csv' },
  { field: 'documents',          schema: 'library', table: 'documents',           required: true, defaultFilename: 'library - documents.csv' },
  { field: 'document_relations', schema: 'library', table: 'document_relations',  required: true, defaultFilename: 'library - document relations.csv' },
];
