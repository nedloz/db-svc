"""DISABLED: GraphRAG отключён (спецификация 2026-10-27-notebook-pipeline-design). Код не поддерживается и не вызывается.

Клиент внутреннего API графа (`graph-rag-svc`, `/internal/graph/*`).

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

from app.mtls import httpx_kwargs

GRAPH_RAG_URL = os.getenv("GRAPH_RAG_URL", "http://graph-rag-svc:8000")
REQUEST_TIMEOUT = float(os.getenv("GRAPH_RAG_TIMEOUT_SEC", "60"))


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
        with httpx.Client(timeout=REQUEST_TIMEOUT, **httpx_kwargs()) as client:
            response = client.request(method, url, params=params, json=json_body)
    except httpx.HTTPError as exc:
        return 502, {"detail": f"graph-rag-svc недоступен: {exc}"}

    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {"detail": response.text}
