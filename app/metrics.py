"""Метрики Prometheus: HTTP-метрики приложения и бизнес-метрики сервиса.

/metrics отдаёт только prometheus (политика прокси, infra/mtls/*.conf); наружу через шлюз его
нет. HTTP-метрики группируются по шаблону маршрута, а не по реальному пути, поэтому число
значений метки handler ограничено числом маршрутов.
"""

from fastapi import FastAPI
from prometheus_client import Counter, Gauge
from prometheus_fastapi_instrumentator import Instrumentator


def setup_metrics(app: FastAPI) -> None:
    """Подключает сбор HTTP-метрик и маршрут GET /metrics."""
    instrumentator = Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        should_instrument_requests_inprogress=True,
        excluded_handlers=["/metrics"],
    )
    instrumentator.instrument(app).expose(app, include_in_schema=False, should_gzip=False)


ADMIN_ACTIONS = Counter(
    "pochemuchnik_admin_actions_total",
    "Действия администраторов из журнала audit.db_actions",
    ["action", "result"],  # action: row.insert | row.update | row.delete | import.* | minio.* | graph.*; result: success | failure
)
IMPORTS = Counter(
    "pochemuchnik_imports_total",
    "Импорты данных по виду и результату",
    ["kind", "result"],  # kind: csv | dataset; result: success | failure
)
CORPUS_OBJECTS = Gauge(
    "pochemuchnik_corpus_objects",
    "Размер корпуса и графа",
    ["kind"],  # documents | chunks | graph_nodes | graph_edges
)
