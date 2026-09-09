from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager

import logging
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.core.auth import auth_is_disabled, require_auth, verify_auth_configuration
from app.routes.db import router as db_router
from app.routes.export import router as export_router
from app.routes.graph import router as graph_router
from app.routes.jobs import router as jobs_router
from app.routes.minio import router as minio_router
from app.services.jobs import ensure_jobs_table
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
        try:
            ensure_jobs_table()
        except Exception as exc:
            # Уровень ERROR, а не WARNING: без этой таблицы не работает весь раздел импорта.
            logger.error("Не удалось создать таблицу журнала задач public.dbsvc_jobs: %s", exc)
    else:
        logger.error(
            "PostgreSQL недоступен после %s попыток: %s. Раздел импорта работать не будет.",
            DB_WAIT_ATTEMPTS,
            db_status.get("error"),
        )
    yield


app = FastAPI(title=APP_NAME, lifespan=lifespan)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/static") or path in ("/health",):
        return await call_next(request)

    if path in ("/", "/index.html"):
        return await call_next(request)

    if path.startswith("/api/"):
        require_auth(request)

    return await call_next(request)


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
app.include_router(graph_router, prefix="/api/graph", tags=["graph"])
app.include_router(export_router, prefix="/api/export", tags=["export"])
