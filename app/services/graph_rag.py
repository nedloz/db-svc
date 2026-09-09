"""Клиент внутреннего API графа (`graph-rag-svc`, `/internal/graph/*`).

db-svc намеренно НЕ правит таблицы `graph.*` напрямую, хотя технически может: все правила
работы с графом (резолюция, алиасинг, upsert, устойчивость правок к пересборке) реализованы
в graph-rag-svc, и дублировать их здесь на SQL означало бы гарантированно с ними разъехаться.
Поэтому админка выступает клиентом HTTP-API. См. README graph-rag-svc, §13.3.

Проксирует именно бэкенд, а не браузер: межсервисный токен не должен попадать на фронтенд.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

GRAPH_RAG_URL = os.getenv("GRAPH_RAG_URL", "http://graph-rag-svc:8000")
SERVICE_NAME = os.getenv("SERVICE_NAME", "db-svc")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
INTERNAL_AUTH_HEADER_NAME = os.getenv("INTERNAL_AUTH_HEADER_NAME", "X-Service-Token")
INTERNAL_SERVICE_NAME_HEADER = os.getenv("INTERNAL_SERVICE_NAME_HEADER", "X-Service-Name")
REQUEST_TIMEOUT = float(os.getenv("GRAPH_RAG_TIMEOUT_SEC", "60"))


def _headers() -> dict[str, str]:
    return {
        INTERNAL_SERVICE_NAME_HEADER: SERVICE_NAME,
        INTERNAL_AUTH_HEADER_NAME: SERVICE_TOKEN,
    }


def call(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: Any = None,
) -> tuple[int, Any]:
    """Выполняет запрос к `/internal/graph/<path>` и возвращает (статус, тело).

    Ошибки транспорта превращаются в 502 с текстом — админке нужно показать причину,
    а не молча получить пустой экран.
    """
    url = f"{GRAPH_RAG_URL.rstrip('/')}/internal/graph/{path.lstrip('/')}"
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            response = client.request(method, url, params=params, json=json_body, headers=_headers())
    except httpx.HTTPError as exc:
        return 502, {"detail": f"graph-rag-svc недоступен: {exc}"}

    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {"detail": response.text}
