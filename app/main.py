from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager

import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.metrics import setup_metrics
from app.services.corpus_stats import refresh_corpus_counts
from app.core.auth import auth_is_disabled, require_auth, verify_auth_configuration
from app.routes.db import router as db_router
from app.routes.export import router as export_router
# GraphRAG отключён, см. спецификацию 2026-10-27
# from app.routes.graph import router as graph_router
from app.routes.jobs import router as jobs_router
from app.routes.minio import router as minio_router
from app.services import audit
from app.services.jobs import jobs_table_exists
from app.services.pg import check_db_connection

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

APP_NAME = os.getenv("APP_NAME", "dbservice")


DB_WAIT_ATTEMPTS = int(os.getenv("DBSVC_DB_WAIT_ATTEMPTS", "30"))
DB_WAIT_DELAY_SEC = float(os.getenv("DBSVC_DB_WAIT_DELAY_SEC", "2"))


def _wait_for_db() -> dict:
    """Ждёт готовности postgres, возвращая последний результат проверки."""
    status: dict = {}
    for attempt in range(1, DB_WAIT_ATTEMPTS + 1):
        status = check_db_connection()
        if status.get("ok"):
            return status
        if attempt < DB_WAIT_ATTEMPTS:
            logger.info(
                "Ожидаем PostgreSQL (%s/%s): %s", attempt, DB_WAIT_ATTEMPTS, status.get("error")
            )
            time.sleep(DB_WAIT_DELAY_SEC)
    return status


CORPUS_COUNTS_INTERVAL_SEC = int(os.getenv("CORPUS_COUNTS_INTERVAL_SEC", "60"))


async def _corpus_counts_loop() -> None:
    """Периодически обновляет размер корпуса и графа для метрик, не нагружая БД на каждый сбор."""
    while True:
        try:
            await asyncio.to_thread(refresh_corpus_counts)
        except Exception:
            logger.warning("Не удалось обновить размер корпуса для метрик", exc_info=True)
        await asyncio.sleep(CORPUS_COUNTS_INTERVAL_SEC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Проверяем конфигурацию доступа до всего остального: сервис даёт полный доступ к базе,
    # и подниматься с выключенной авторизацией по недосмотру он не должен.
    verify_auth_configuration()
    if auth_is_disabled():
        logger.warning(
            "АВТОРИЗАЦИЯ ОТКЛЮЧЕНА (DBSVC_ALLOW_NO_AUTH). Полный доступ к базе и файлам "
            "открыт всем, кто дотянется до порта. Допустимо только локально."
        )

    # База ожидается с повторами, а не одной попыткой. Прежняя версия проверяла соединение
    # ровно раз: при старте раньше postgres она получала "Connection refused", писала ошибку
    # и продолжала работу без таблицы журнала задач. Обычные запросы при этом работали
    # (каждый открывает соединение заново), и отсутствие таблицы всплывало гораздо позже —
    # пятисоткой при импорте, где связь с первыми строками лога уже не очевидна.
    db_status = _wait_for_db()

    if db_status.get("ok"):
        logger.info(
            "PostgreSQL connected: db=%s user=%s host=%s port=%s",
            db_status.get("database"),
            db_status.get("user"),
            db_status.get("host"),
            db_status.get("port"),
        )
        # Таблицы создаются init.sql / migrations/008, а не сервисом: у его роли нет прав на DDL.
        # Уровень ERROR: без журнала задач не работает раздел импорта, а без журнала действий
        # любое изменение данных отвечает 500 (запись о нём и само изменение неразделимы).
        try:
            if not jobs_table_exists():
                logger.error(
                    "Нет таблицы public.dbsvc_jobs: раздел импорта работать не будет. "
                    "Примените infra/db/migrations/008_roles_and_audit.sql."
                )
        except Exception as exc:
            logger.error("Не удалось проверить таблицу журнала задач public.dbsvc_jobs: %s", exc)
        if not audit.check_audit_table():
            logger.error(
                "Нет таблицы audit.db_actions: изменения данных будут отклоняться. "
                "Примените infra/db/migrations/008_roles_and_audit.sql."
            )
    else:
        logger.error(
            "PostgreSQL недоступен после %s попыток: %s. Раздел импорта работать не будет.",
            DB_WAIT_ATTEMPTS,
            db_status.get("error"),
        )
    corpus_task = asyncio.create_task(_corpus_counts_loop())
    yield
    corpus_task.cancel()


app = FastAPI(title=APP_NAME, lifespan=lifespan)
setup_metrics(app)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/static") or path in ("/health",):
        return await call_next(request)

    if path in ("/", "/index.html"):
        return await call_next(request)

    if path.startswith("/api/"):
        # HTTPException, поднятое прямо в middleware, до обработчиков ошибок FastAPI не
        # доходит, поэтому ответ собирается здесь.
        try:
            actor = require_auth(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        # Актёр нужен журналу действий; запрос выполняется в копии контекста, куда это
        # значение попадает (в том числе в рабочие потоки run_in_threadpool).
        token = audit.set_actor(actor)
        try:
            return await call_next(request)
        finally:
            audit.reset_actor(token)

    return await call_next(request)


@app.middleware("http")
async def revalidate_panel_assets(request: Request, call_next):
    """Страница и скрипты панели проверяются на актуальность при каждой загрузке.

    Без Cache-Control браузер кэширует их по Last-Modified на неопределённый срок: после
    обновления образа в панели оставались старые main.js и список вкладок. С no-cache он
    всё равно использует кэш, но сначала спрашивает по ETag, не изменился ли файл.
    """
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/index.html") or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html"), "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")

app.include_router(db_router, prefix="/api/db", tags=["db"])
app.include_router(minio_router, prefix="/api/minio", tags=["minio"])
app.include_router(jobs_router, prefix="/api/jobs", tags=["jobs"])
# GraphRAG отключён, см. спецификацию 2026-10-27
# app.include_router(graph_router, prefix="/api/graph", tags=["graph"])
app.include_router(export_router, prefix="/api/export", tags=["export"])
