from __future__ import annotations

import os
from contextlib import asynccontextmanager

import logging
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.core.auth import require_auth
from app.routes.db import router as db_router
from app.routes.jobs import router as jobs_router
from app.routes.minio import router as minio_router
from app.services.jobs import ensure_jobs_table
from app.services.pg import check_db_connection

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

APP_NAME = os.getenv("APP_NAME", "dbservice")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_status = check_db_connection()
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
            logger.warning("Could not ensure jobs table yet: %s", exc)
    else:
        logger.error("PostgreSQL connection failed: %s", db_status.get("error"))
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
