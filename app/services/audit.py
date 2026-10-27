"""Журнал действий администратора (`audit.db_actions`).

Админка может удалить строку, поправить роль пользователя или стереть файл в MinIO, и без
следа установить, кто это сделал, было нельзя. Здесь фиксируется каждое изменяющее действие.

Два способа записи:

- `record(conn, ...)` — в том же соединении и транзакции, что и само изменение. Если запись в
  журнал не удалась, откатывается и изменение: действие без следа не происходит.
- `record_standalone(...)` — отдельной транзакцией, для действий вне БД (файлы в MinIO,
  запросы в graph-rag-svc, импорты, которые сами управляют транзакциями). Если запись не
  удалась, полный текст записи уходит в лог на уровне ERROR, а вызывающему возвращается 500.

Таблица доступна роли db-svc только на INSERT и SELECT (infra/db/init/roles/grants.sql),
поэтому стереть или поправить запись через сервис нельзя.
"""

from __future__ import annotations

import json
import logging
from contextvars import ContextVar, Token
from typing import Any

from fastapi import HTTPException
from psycopg.types.json import Json

from app.core.auth import Actor
from app.metrics import ADMIN_ACTIONS, IMPORTS
from app.services.pg import get_conn

logger = logging.getLogger(__name__)

# Кто сейчас выполняет запрос. Выставляется middleware (app/main.py); copy-контекст
# run_in_threadpool переносит значение в рабочие потоки, поэтому сервисным функциям
# (catalog.py) не нужно передавать актёра параметром через все слои.
_current_actor: ContextVar[Actor | None] = ContextVar("dbsvc_actor", default=None)

# Значения длиннее обрезаются: в журнал попадают целые строки таблиц, а среди них бывают
# тексты документов и эмбеддинги в тысячи символов. Важно «что менялось», а не весь объём.
MAX_VALUE_CHARS = 1000


def set_actor(actor: Actor) -> Token:
    return _current_actor.set(actor)


def reset_actor(token: Token) -> None:
    _current_actor.reset(token)


def current_actor() -> Actor:
    return _current_actor.get() or Actor(kind="anonymous")


def clip(value: Any) -> Any:
    """Обрезает длинные строки (рекурсивно по словарям и спискам)."""
    if isinstance(value, str):
        if len(value) > MAX_VALUE_CHARS:
            return f"{value[:MAX_VALUE_CHARS]}…[обрезано, всего {len(value)} симв.]"
        return value
    if isinstance(value, dict):
        return {str(k): clip(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clip(v) for v in value]
    return value


def summarize(result: Any, *, max_items: int = 40) -> dict[str, Any]:
    """Короткая сводка результата операции для журнала: скаляры и небольшие словари
    (например, счётчики по таблицам) как есть, списки — только длиной. Построчные
    отчёты и длинные перечни нарушений в журнал не нужны, они остаются в журнале задач."""
    if not isinstance(result, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in result.items():
        if value is None or isinstance(value, (bool, int, float, str)):
            out[str(key)] = value
        elif isinstance(value, dict) and len(value) <= max_items and all(
            v is None or isinstance(v, (bool, int, float, str)) for v in value.values()
        ):
            out[str(key)] = value
        elif isinstance(value, (list, tuple)):
            out[f"{key}_count"] = len(value)
    return out


def pk_text(pk: Any) -> str | None:
    """Строковая запись первичного ключа: значение как есть, составной — JSON."""
    if pk is None:
        return None
    if isinstance(pk, dict):
        return json.dumps(pk, ensure_ascii=False, sort_keys=True, default=str)
    return str(pk)


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


_INSERT_SQL = """
INSERT INTO audit.db_actions (
    actor_type, actor_user_id, actor_role, client_ip, action, success,
    target_schema, target_table, target_pk, object_key, details
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""


def _params(
    actor: Actor,
    action: str,
    *,
    success: bool,
    schema: str | None,
    table: str | None,
    pk: Any,
    object_key: str | None,
    details: dict[str, Any] | None,
) -> tuple[Any, ...]:
    return (
        actor.kind,
        actor.user_id,
        actor.role,
        actor.ip,
        action,
        success,
        schema,
        table,
        pk_text(pk),
        object_key,
        Json(clip(details or {}), dumps=_dumps),
    )


def _count(action: str, success: bool) -> None:
    result = "success" if success else "failure"
    ADMIN_ACTIONS.labels(action=action, result=result).inc()
    if action.startswith("import."):
        IMPORTS.labels(kind=action.split(".", 1)[1], result=result).inc()


def record(
    conn,
    action: str,
    *,
    success: bool = True,
    schema: str | None = None,
    table: str | None = None,
    pk: Any = None,
    object_key: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Запись в уже открытой транзакции. Коммит выполняет вызывающий вместе с изменением."""
    params = _params(
        current_actor(), action,
        success=success, schema=schema, table=table, pk=pk, object_key=object_key, details=details,
    )
    with conn.cursor() as cur:
        cur.execute(_INSERT_SQL, params)
    _count(action, success)


def record_standalone(
    action: str,
    *,
    success: bool = True,
    schema: str | None = None,
    table: str | None = None,
    pk: Any = None,
    object_key: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Запись отдельной транзакцией. Не удалась — 500 и полный текст записи в лог."""
    actor = current_actor()
    params = _params(
        actor, action,
        success=success, schema=schema, table=table, pk=pk, object_key=object_key, details=details,
    )
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_INSERT_SQL, params)
            conn.commit()
        _count(action, success)
    except Exception as exc:
        logger.error(
            "НЕ ЗАПИСАНО В ЖУРНАЛ ДЕЙСТВИЙ (%s): %s",
            exc,
            _dumps({
                "actor": actor.__dict__, "action": action, "success": success,
                "schema": schema, "table": table, "pk": pk_text(pk),
                "object_key": object_key, "details": clip(details or {}),
            }),
        )
        raise HTTPException(status_code=500, detail="Не удалось записать действие в журнал") from exc


def record_failure(
    action: str,
    *,
    schema: str | None = None,
    table: str | None = None,
    pk: Any = None,
    object_key: str | None = None,
    error: str,
    details: dict[str, Any] | None = None,
) -> None:
    """Запись о неудавшейся попытке. Сбой самой записи только логируется: ответ клиенту
    уже определяется исходной ошибкой, подменять её второй не нужно."""
    try:
        record_standalone(
            action, success=False, schema=schema, table=table, pk=pk, object_key=object_key,
            details={**(details or {}), "error": error},
        )
    except HTTPException:
        pass


def check_audit_table() -> bool:
    """Есть ли таблица журнала. Проверка при старте: без неё любое изменение вернёт 500."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('audit.db_actions') IS NOT NULL")
                return bool(cur.fetchone()[0])
    except Exception:
        logger.exception("Не удалось проверить наличие audit.db_actions")
        return False
