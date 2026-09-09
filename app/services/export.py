"""Выгрузка графа и чанков одним архивом.

Зачем отдельный модуль, а не `pg_dump`: выгрузка должна быть переносимой между стендами и
читаемой без Postgres — соседняя команда поднимает свой экземпляр и работает с теми же
данными. Поэтому JSONL по файлу на таблицу плюс manifest.json с версией схемы, моделью
эмбеддингов и числом строк: по нему будущий импорт сможет проверить совместимость, не
разбирая сами данные.

Архив собирается в SpooledTemporaryFile: до порога он живёт в памяти, дальше уходит на
диск. Выгрузка эмбеддингов — это 1024 float на чанк, и держать её целиком в оперативной
памяти нельзя.

TODO: импорт архива обратно (загрузка на другой стенд, откат к прежнему состоянию графа).
Продумать отдельно: нужны проверка manifest на совпадение размерности и модели эмбеддингов,
решение о слиянии или замене, и порядок вставки с учётом внешних ключей.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any, Iterator

from app.services.pg import get_conn

SCHEMA_VERSION = 1

# Порядок важен для будущего импорта: родительские таблицы идут раньше подчинённых.
GRAPH_TABLES: tuple[str, ...] = (
    "graph.extraction_runs",
    "graph.entities",
    "graph.entity_aliases",
    "graph.relations",
    "graph.entity_source_chunks",
    "graph.curation_blocklist",
)

# Документы кладём вместе с чанками намеренно: сам по себе чанк бесполезен — по нему нельзя
# понять, из какого документа он взят и можно ли его показывать пользователю.
CHUNK_TABLES: tuple[str, ...] = (
    "library.documents",
    "library.chunks",
)

# Колонки с типом vector psycopg отдаёт как объект pgvector; приводим к тексту в SQL и
# храним строкой '[0.1,0.2,...]' — это лоссless и не требует расширения на читающей стороне.
VECTOR_COLUMNS: dict[str, tuple[str, ...]] = {
    "graph.entities": ("name_embedding",),
    "library.chunk_embeddings": ("embedding",),
}


def _columns(cur, schema: str, table: str) -> list[str]:
    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (schema, table),
    )
    return [r[0] for r in cur.fetchall()]


def _select_list(qualified: str, columns: list[str]) -> str:
    vectors = VECTOR_COLUMNS.get(qualified, ())
    parts = []
    for col in columns:
        if col in vectors:
            parts.append(f'{col}::text AS {col}')
        else:
            parts.append(col)
    return ", ".join(parts)


def _jsonl_rows(cur, qualified: str) -> Iterator[bytes]:
    """Строки таблицы как JSONL. Курсор читается порциями, чтобы не поднимать всю таблицу."""
    schema, table = qualified.split(".", 1)
    columns = _columns(cur, schema, table)
    if not columns:
        return
    cur.execute(f"SELECT {_select_list(qualified, columns)} FROM {qualified}")
    while True:
        batch = cur.fetchmany(500)
        if not batch:
            break
        for row in batch:
            record = {col: _jsonable(val) for col, val in zip(columns, row)}
            yield (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
        return value
    return str(value)


def _row_count(cur, qualified: str) -> int:
    cur.execute(f"SELECT count(*) FROM {qualified}")
    return int(cur.fetchone()[0])


def _embedding_info(cur) -> dict[str, Any]:
    """Модель и размерность — по ним импорт поймёт, совместимы ли векторы с его стендом."""
    cur.execute("SELECT DISTINCT embedding_model FROM library.chunk_embeddings")
    models = sorted(r[0] for r in cur.fetchall() if r[0])
    cur.execute(
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = to_regclass('library.chunk_embeddings') "
        "AND attname = 'embedding' AND NOT attisdropped"
    )
    row = cur.fetchone()
    declared = row[0] if row else None
    return {"models": models, "column_type": declared}


def build_archive(kind: str, with_embeddings: bool = True):
    """Собирает zip и возвращает открытый файловый объект, спозиционированный на начало.

    kind: 'graph' — таблицы схемы graph; 'chunks' — документы, чанки и (по флагу) эмбеддинги.
    """
    if kind == "graph":
        tables = list(GRAPH_TABLES)
    elif kind == "chunks":
        tables = list(CHUNK_TABLES)
        if with_embeddings:
            tables.append("library.chunk_embeddings")
    else:
        raise ValueError(f"неизвестный вид выгрузки: {kind}")

    buffer = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "kind": kind,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "tables": {},
        "with_embeddings": with_embeddings if kind == "chunks" else None,
    }

    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        with get_conn() as conn:
            with conn.cursor() as cur:
                for qualified in tables:
                    manifest["tables"][qualified] = _row_count(cur, qualified)
                    name = qualified.replace(".", "__") + ".jsonl"
                    # Пишем потоком в член архива, а не собираем файл в памяти целиком.
                    with archive.open(name, "w") as member:
                        for line in _jsonl_rows(cur, qualified):
                            member.write(line)
                if kind == "chunks":
                    manifest["embeddings"] = _embedding_info(cur)

        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    buffer.seek(0)
    return buffer, manifest
