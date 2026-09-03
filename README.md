# db-svc (Postgres + MinIO admin microservice)

Админ-панель на `localhost:3401` (порт настраивается) для:
- просмотра и **редактирования** (CRUD) строк Postgres: фильтры, сортировка, составные PK, выпадающие списки из CHECK/enum
- импорта CSV в существующую таблицу (построчно, с превью и построчным отчётом об ошибках) и связанного датасета из 8 файлов с UUID-ремаппингом
- загрузки/просмотра/скачивания/удаления файлов в MinIO через presigned URL, импорта файлов по title и HTML по `origin_url` (с конвертацией HTML→Markdown)
- отслеживания прогресса длительных операций через `/api/jobs/{id}`

## 1) .env

Используются два файла.

Корневой `.env` проекта — задаёт порт наружу и токен, docker-compose прокидывает их в контейнер:

```env
DBSVC_PUBLIC_PORT=3401
DBSVC_ADMIN_TOKEN=123456
```

`services/db-svc/.env` — креды подключения к Postgres/MinIO (см. [.env.example](.env.example)):

```env
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=app_db
POSTGRES_USER=app_user
POSTGRES_PASSWORD=app_pass

MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=documents
MINIO_REGION=us-east-1
MINIO_SECURE=false

DBSVC_ADMIN_TOKEN=123456  # если пусто — токен не требуется; токен хранится в localStorage браузера!
```

`123456`/`minioadmin`/`app_pass` — дев-значения. Перед прод-деплоем заменить на реальные секреты.

## 2) docker-compose фрагмент

```yaml
  db-svc:
    build: ./services/db-svc
    env_file:
      - ./services/db-svc/.env
    environment:
      POSTGRES_HOST: ${POSTGRES_HOST}
      POSTGRES_PORT: ${POSTGRES_PORT}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_ADMIN_USER}
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      MINIO_BUCKET: ${MINIO_BUCKET}
      MINIO_REGION: ${MINIO_REGION}
      MINIO_SECURE: ${MINIO_SECURE}
      DBSVC_ADMIN_TOKEN: ${DBSVC_ADMIN_TOKEN}
    ports:
      - "${DBSVC_PUBLIC_PORT}:8000"   # контейнер слушает 8000 (uvicorn)
    depends_on:
      - postgres
      - minio
    restart: unless-stopped
```

## 3) Запуск

```bash
cd pochemuchnic-miem-prj

# Первый раз (поднять зависимости):
docker compose up -d postgres minio

# Собрать и поднять db-svc:
docker compose up -d --build db-svc

# Если кэш мешает (например, после правок в app/static/ всё ещё старый файл):
docker compose build --no-cache db-svc
docker compose up -d db-svc

# Посмотреть логи:
docker compose logs -f db-svc

# Остановить:
docker compose stop db-svc
docker compose down
docker compose down -v       # со стиранием данных
```

Открыть: http://localhost:3401 (или другой `DBSVC_PUBLIC_PORT`)

Если задан `DBSVC_ADMIN_TOKEN`, вставь его в поле вверху и нажми «Сохранить».

## 4) Ограничения (осознанно упрощено)

- Имена схем/таблиц/колонок разрешены только в формате `[A-Za-z_][A-Za-z0-9_]*`.
- CSV импорт: строки вставляются по одной (`INSERT` + `SAVEPOINT` на строку) — не bulk `COPY`, зато отчёт по каждой упавшей строке. `HEADER` обязателен, порядок колонок значения не имеет (матчинг по имени); неизвестные или отсутствующие обязательные колонки — импорт отклоняется целиком до начала вставки.
- MinIO `GET /objects` — не больше 1000 объектов за раз (по умолчанию 200), пагинация через `continuation_token`.
- Presigned URL живут 10 минут, refresh-эндпоинта нет.
