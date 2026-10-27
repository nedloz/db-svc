"""DISABLED: GraphRAG отключён (спецификация 2026-10-27-notebook-pipeline-design). Код не поддерживается и не вызывается.

`/api/graph/*` — прокси к внутреннему API курирования графа в graph-rag-svc.

Прокси сделан сквозным по пути намеренно: набор операций курирования живёт в graph-rag-svc и
будет меняться вместе с графом, а дублировать здесь сигнатуру каждого эндпоинта значило бы
ломать админку при каждом их изменении. Авторизация при этом никуда не девается: весь
`/api/*` в db-svc уже закрыт админским Bearer-токеном (см. app/main.py), а наружу запрос
уходит только на префикс `/internal/graph/`.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.services import audit
from app.services.graph_rag import call

router = APIRouter()

_ALLOWED_METHODS = ("GET", "POST", "PATCH", "DELETE")


@router.api_route("/{path:path}", methods=list(_ALLOWED_METHODS))
async def proxy_graph_api(path: str, request: Request):
    json_body = None
    if request.method in ("POST", "PATCH"):
        raw = await request.body()
        if raw:
            try:
                json_body = await request.json()
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "тело запроса не является JSON"})

    status, payload = call(
        request.method,
        path,
        params=dict(request.query_params),
        json_body=json_body,
    )
    # Чтение журнала не засоряет; изменения графа фиксируются вместе с ответом graph-rag-svc.
    if request.method != "GET":
        audit.record_standalone(
            f"graph.{request.method.lower()}",
            success=status < 400,
            details={"path": path, "params": dict(request.query_params), "body": json_body, "status": status},
        )
    return JSONResponse(status_code=status, content=payload)
