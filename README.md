# dbservice (Postgres + MinIO admin microservice)

Мини-проект: вебка на `localhost:3401` для:
- просмотра схем/таблиц Postgres и чтения данных (пагинация)
- импорта CSV в существующую таблицу через `COPY FROM STDIN`
- загрузки/просмотра/скачивания/удаления файлов в MinIO через presigned URL

## 1) .env (docker-compose общий)

Пример:

```env
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=appdb
POSTGRES_USER=appuser
POSTGRES_PASSWORD=apppass

MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=documents
MINIO_REGION=us-east-1
MINIO_SECURE=false

DBSVC_PORT=3401
DBSVC_ADMIN_TOKEN=change_me  # если пусто — токен не требуется, токен хранится в localStorage браузера!
```

## 2) docker-compose фрагмент

```yaml
  dbservice:
    build: ./dbservice
    env_file: .env
    ports:
      - "3401:3401"
    depends_on:
      - postgres
      - minio
    restart: unless-stopped
```

## 3) Запуск

```bash
docker compose up -d --build dbservice # ???
```
---
```bash
cd pochemuchnic-miem-prj

Первый раз (поднять зависимости):

docker compose up -d postgres minio

Cобрать db-svc:

docker compose up -d db-svc

Если кэш мешает (например, после правок в app/static/ всё ещё старый файл):

docker compose build --no-cache db-svc
docker compose up -d db-svc

Посмотреть логи:
docker compose logs -f db-svc

Остановить:
docker compose stop db-svc
docker compose down
docker compose down -v       # со стиранием данных
```

Открыть: http://localhost:3401

Если задан `DBSVC_ADMIN_TOKEN`, вставь его в поле вверху и нажми «Сохранить».

## 4) Ограничения (осознанно упрощено)

- Имена схем/таблиц/колонок разрешены только в формате `[A-Za-z_][A-Za-z0-9_]*`.
- CSV импорт: ожидается `HEADER` и **порядок колонок как в таблице**.
  (Можно расширить: парсить header и делать `COPY table(col1,col2,...)`.)
