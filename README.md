# db-svc — Микросервис администрирования БД и Хранилища

Синхронный микросервис на базе **FastAPI**, **psycopg 3** и **MinIO S3 (boto3)**, предназначенный для просмотра и редактирования каталога общей PostgreSQL-базы (схемы `core`, `auth`, `chat`, `library`), импорта CSV/датасетов и управления файлами документов в MinIO.

Является инструментом контент-менеджера в экосистеме **«ИИ-помощник студента» (НИУ ВШЭ МИЭМ)**: сам данных не хранит, а администрирует базу, которой питается RAG-чат. db-svc не предоставляет пользовательских функций чата — только служебный CRUD над базой знаний.

---

## Роль в архитектуре системы

db-svc ходит напрямую в общий Postgres и в MinIO — не через другие сервисы экосистемы (`rag-svc`, `llm-svc`, `chat-svc` и т.д. не задействованы).
Загрузка/скачивание самих файлов идёт по presigned URL напрямую между браузером и MinIO — db-svc лишь выдаёт подписанную ссылку, байты через него не проходят.

---

## Возможности и особенности

- CRUD строк любой таблицы любой схемы: модалка и inline-редактирование, составные первичные ключи, выпадающие списки значений из CHECK-constraint/enum, серверные фильтры и сортировка.
- CSV-импорт в существующую таблицу: построчная вставка (`INSERT` + `SAVEPOINT` на строку, не bulk `COPY`) с отчётом по каждой упавшей строке; колонки матчатся по имени из `HEADER`, порядок не важен.
- Связанный dataset-импорт: 8 CSV-файлов (университеты, кампусы, факультеты, корпуса, программы, темы, документы, document_relations), UUID для новых записей генерируются и связываются автоматически; есть `dry_run`.
- Управление файлами в MinIO: список, presigned upload/download, удаление; импорт файлов с мэтчингом по title к `library.documents`; импорт HTML по `origin_url` с конвертацией HTML → Markdown для RAG.
- Прогресс длительных операций через `/api/jobs/{id}` (создаётся при импорте, поддерживает отмену).
- Bearer-авторизация (`DBSVC_ADMIN_TOKEN`) на всех `/api/*`; без токена — dev-режим без авторизации.
- Строгая валидация идентификаторов схем/таблиц/колонок регэкспом, без ORM — чистый SQL через psycopg.
- Фронтенд — vanilla HTML/CSS/JS (ES-модули), без сборщиков и фреймворков, дизайн по макетам Figma.

---

## Данные, с которыми работает сервис

В отличие от сервисов-владельцев своих таблиц, db-svc — клиент общей базы `app_db` и своей схемы не имеет (кроме служебной таблицы задач):

- **`core`** — справочники вуза: universities, campuses, faculties, buildings, programs.
- **`auth`** — пользователи и токены (владелец `auth-svc`, здесь только читаются/редактируются вручную).
- **`chat`** — история переписок и фидбек (владелец `chat-svc`).
- **`library`** — база знаний: documents, chunks, chunk_embeddings (`VECTOR(1024)`), document_files, document_relations, contacts, places. Основная зона редактирования через db-svc.
- **`public.dbsvc_jobs`** — служебная таблица самого db-svc для отслеживания прогресса импортов (создаётся автоматически при старте).

Полная схема — `infra/db/init/init.sql` в корне проекта.

---

## Переменные окружения

| Переменная | Файл | Обязательна | По умолчанию | Описание |
| :--- | :--- | :---: | :--- | :--- |
| `DBSVC_PUBLIC_PORT` | корневой `.env` | Да | — | Внешний порт, проброс на 8000 внутри контейнера. |
| `DBSVC_ADMIN_TOKEN` | оба `.env` | Нет | пусто (auth выкл.) | Bearer-токен для всех `/api/*`. |
| `POSTGRES_HOST` | `services/db-svc/.env` | Нет | `postgres` | Хост PostgreSQL. |
| `POSTGRES_PORT` | `services/db-svc/.env` | Нет | `5432` | Порт PostgreSQL. |
| `POSTGRES_DB` | `services/db-svc/.env` | Нет | `app_db` | Имя базы данных. |
| `POSTGRES_USER` | `services/db-svc/.env` | Нет | `app_user` | Пользователь БД. |
| `POSTGRES_PASSWORD` | `services/db-svc/.env` | Нет | `app_password` | Пароль пользователя БД. |
| `MINIO_ENDPOINT` | `services/db-svc/.env` | Нет | `minio:9000` | Внутренний адрес MinIO (для запросов из контейнера). |
| `MINIO_ACCESS_KEY` | `services/db-svc/.env` | Нет | `minioadmin` | Access key MinIO. |
| `MINIO_SECRET_KEY` | `services/db-svc/.env` | Нет | `minioadmin` | Secret key MinIO. |
| `MINIO_BUCKET` | `services/db-svc/.env` | Нет | `documents` | Имя бакета с файлами. |
| `MINIO_REGION` | `services/db-svc/.env` | Нет | `us-east-1` | Регион S3-подписи. |
| `MINIO_SECURE` | `services/db-svc/.env` | Нет | `false` | HTTPS для внутренних запросов к MinIO. |
| `MINIO_PUBLIC_ENDPOINT` | `services/db-svc/.env` | Нет | `localhost:9000` | Хост MinIO для presigned URL — должен резолвиться из браузера, а не из контейнера. |
| `MINIO_PUBLIC_SECURE` | `services/db-svc/.env` | Нет | значение `MINIO_SECURE` | HTTPS для presigned URL. |

Дев-значения (`123456`, `minioadmin`, `app_pass`) заменить на реальные секреты перед прод-деплоем.

---

## Быстрый запуск

### Вариант 1: через общий docker-compose

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

```bash
cd pochemuchnic-miem-prj

# Первый раз (поднять зависимости):
docker compose up -d postgres minio

# Собрать и поднять db-svc:
docker compose up -d --build db-svc

# Если кэш мешает (например, после правок в app/static/ всё ещё старый файл):
docker compose build --no-cache db-svc
docker compose up -d db-svc

# Логи:
docker compose logs -f db-svc

# Остановить:
docker compose stop db-svc
docker compose down
docker compose down -v       # со стиранием данных
```

Открыть: `http://localhost:3401` (или другой `DBSVC_PUBLIC_PORT`). Если задан `DBSVC_ADMIN_TOKEN` — вставить его в поле вверху страницы и нажать «Сохранить» (сохранится в `localStorage`).

### Вариант 2: локальный запуск (Python)

Postgres и MinIO должны быть доступны отдельно (например, `docker compose up -d postgres minio` с проброшенными портами).

```bash
cd services/db-svc

python -m venv venv
# Windows: venv\Scripts\activate
# Linux/macOS: source venv/bin/activate

pip install -r requirements.txt

cp .env.example .env   # и поправить хосты/порты под локальный запуск

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Документация API

Все `/api/*` требуют `Authorization: Bearer <DBSVC_ADMIN_TOKEN>`. `/`, `/static/*`, `/health` — без токена.

## root

| METHOD | PATH |
|---|---|
| GET | `/health` |
| GET | `/` |
| GET | `/static/*` |

## db — `/api/db/*` ([app/routes/db.py](app/routes/db.py))

| METHOD | PATH |
|---|---|
| GET | `/schemas` |
| GET | `/connection/status` |
| GET | `/import/dataset/status` |
| POST | `/import/dataset` |
| POST | `/import/csv` |
| GET | `/{schema}/tables` |
| GET | `/{schema}/{table}/columns` |
| GET | `/{schema}/{table}/enums` |
| GET | `/{schema}/{table}/rows` |
| POST | `/{schema}/{table}/query` |
| POST | `/{schema}/{table}` |
| PATCH | `/{schema}/{table}/{pk}` |
| DELETE | `/{schema}/{table}/{pk}` |
| GET | `/{schema}/{table}/relations` |
| GET | `/{schema}/{table}/relations/inbound` |
| GET | `/{schema}/{table}/{pk}/dependencies` |
| GET | `/{schema}/{table}/export.csv` |

## minio — `/api/minio/*` ([app/routes/minio.py](app/routes/minio.py))

| METHOD | PATH |
|---|---|
| GET | `/objects` |
| POST | `/presign/upload` |
| GET | `/presign/download` |
| DELETE | `/object` |
| GET | `/import-plan` |
| POST | `/import/files` |
| GET | `/import/html-plan` |
| POST | `/import/html-from-documents` |

## jobs — `/api/jobs/*` ([app/routes/jobs.py](app/routes/jobs.py))

| METHOD | PATH |
|---|---|
| GET | `/{job_id}` |
| DELETE | `/{job_id}` |

---

## Структура репозитория

```
services/db-svc/
├── Dockerfile              # python:3.12-slim, uvicorn на порту 8000
├── requirements.txt        # FastAPI, psycopg[binary], boto3, html2text, beautifulsoup4
├── .env.example            # шаблон переменных окружения сервиса
├── README.md            # этот файл
├── API_quick.md         # краткий список всех эндпоинтов
└── app/
    ├── main.py             # точка входа, auth-middleware, монтирование /static
    ├── core/
    │   └── auth.py         # require_auth(): проверка Bearer DBSVC_ADMIN_TOKEN
    ├── routes/             # /api/db/*, /api/minio/*, /api/jobs/*
    ├── services/           # psycopg-запросы, boto3, импорт-пайплайны, jobs
    ├── legacy/             # read-only референс предыдущей MVP-админки
    └── static/             # текущий фронтенд
        ├── index.html
        ├── css/
        └── js/
            ├── api/        # fetch-обёртки (client.js, db.js, minio.js)
            ├── state/      # store.js — pub/sub состояние
            ├── components/ # переиспользуемые UI-блоки
            ├── views/      # db-explorer/, import/, minio/
            └── utils/
```
