from __future__ import annotations

import io
from typing import Any, Optional

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.services.pg import get_conn, validate_ident, qident
from app.services.import_pipeline import dataset_status, run_dataset_import
import logging
from psycopg import Error as PsycopgError

from app.services.pg import get_conn, validate_ident, qident, check_db_connection

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/schemas")
async def list_schemas() -> dict[str, Any]:
    def _work():
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT nspname
                    FROM pg_namespace
                    WHERE nspname NOT LIKE 'pg_%'
                      AND nspname <> 'information_schema'
                    ORDER BY nspname;
                    """
                )
                return [r[0] for r in cur.fetchall()]

    schemas = await run_in_threadpool(_work)
    return {"schemas": schemas}

@router.get("/connection/status")
async def db_connection_status() -> dict[str, Any]:
    def _work():
        return check_db_connection()

    return await run_in_threadpool(_work)

@router.get("/{schema}/tables")
async def list_tables(schema: str) -> dict[str, Any]:
    try:
        validate_ident(schema, "schema")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def _work():
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = %s
                      AND table_type = 'BASE TABLE'
                    ORDER BY table_name;
                    """,
                    (schema,),
                )
                return [r[0] for r in cur.fetchall()]

    tables = await run_in_threadpool(_work)
    return {"schema": schema, "tables": tables}


@router.get("/{schema}/{table}/columns")
async def list_columns(schema: str, table: str) -> dict[str, Any]:
    try:
        validate_ident(schema, "schema")
        validate_ident(table, "table")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def _work():
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_schema = %s AND table_name = %s
                    ORDER BY ordinal_position;
                    """,
                    (schema, table),
                )
                return [
                    {"name": r[0], "type": r[1], "nullable": (r[2] == 'YES')}
                    for r in cur.fetchall()
                ]

    cols = await run_in_threadpool(_work)
    return {"schema": schema, "table": table, "columns": cols}


@router.get("/{schema}/{table}/rows")
async def get_rows(
    schema: str,
    table: str,
    limit: int = 50,
    offset: int = 0,
    order_by: Optional[str] = None,
) -> dict[str, Any]:
    try:
        validate_ident(schema, "schema")
        validate_ident(table, "table")
        if order_by:
            validate_ident(order_by, "order_by")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    def _work():
        with get_conn() as conn:
            with conn.cursor() as cur:
                # Get columns
                cur.execute(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = %s AND table_name = %s
                    ORDER BY ordinal_position;
                    """,
                    (schema, table),
                )
                columns = [r[0] for r in cur.fetchall()]
                if not columns:
                    raise HTTPException(status_code=404, detail="Table not found or has no columns")

                order_sql = ""
                if order_by:
                    order_sql = f" ORDER BY {qident(order_by)} "

                sql = (
                    f"SELECT * FROM {qident(schema)}.{qident(table)}"
                    f"{order_sql} LIMIT %s OFFSET %s"
                )
                cur.execute(sql, (limit, offset))
                rows = cur.fetchall()

                # JSON-friendly
                out_rows = []
                for row in rows:
                    out_rows.append({columns[i]: row[i] for i in range(len(columns))})

                # total count (cheap-ish; ok for admin tool)
                cur.execute(
                    f"SELECT COUNT(*) FROM {qident(schema)}.{qident(table)}"
                )
                total = int(cur.fetchone()[0])

                return columns, out_rows, total

    columns, rows, total = await run_in_threadpool(_work)
    return {
        "schema": schema,
        "table": table,
        "columns": columns,
        "rows": rows,
        "limit": limit,
        "offset": offset,
        "total": total,
    }




@router.get("/import/dataset/status")
async def get_dataset_status() -> dict[str, Any]:
    return dataset_status()


@router.post("/import/dataset")
async def import_dataset(
    universities: UploadFile = File(...),
    campuses: UploadFile = File(...),
    faculties: UploadFile = File(...),
    buildings: UploadFile = File(...),
    programs: UploadFile = File(...),
    topics: UploadFile = File(...),
    documents: UploadFile = File(...),
    document_relations: UploadFile = File(...),
    replace_mode: bool = Form(False),
    dry_run: bool = Form(False),
) -> dict[str, Any]:
    try:
        file_map = {
            "universities": (universities.filename or "core - universities.csv", await universities.read()),
            "campuses": (campuses.filename or "core - campuses.csv", await campuses.read()),
            "faculties": (faculties.filename or "core - faculties.csv", await faculties.read()),
            "buildings": (buildings.filename or "core - buildings.csv", await buildings.read()),
            "programs": (programs.filename or "core - programs.csv", await programs.read()),
            "topics": (topics.filename or "library - topics.csv", await topics.read()),
            "documents": (documents.filename or "library - documents.csv", await documents.read()),
            "document_relations": (document_relations.filename or "library - document relations.csv", await document_relations.read()),
        }

        def _work():
            return run_dataset_import(file_map, dry_run=dry_run, replace_mode=replace_mode)

        return await run_in_threadpool(_work)

    except PsycopgError as e:
        logger.exception("Dataset import DB error")
        raise HTTPException(status_code=500, detail=f"Ошибка PostgreSQL во время импорта: {str(e)}")
    except Exception as e:
        logger.exception("Dataset import failed")
        raise HTTPException(status_code=500, detail=f"Ошибка импорта: {str(e)}")

@router.post("/import/csv")
async def import_csv(
    file: UploadFile = File(...),
    schema_name: str = Form(..., alias="schema"),
    table: str = Form(...),
    mode: str = Form("append"),
    delimiter: str = Form(","),
    encoding: str = Form("utf-8"),
) -> dict[str, Any]:
    """Import CSV into existing table using COPY FROM STDIN.

    Expects CSV header matching table columns (order can differ if you pass columns in future).
    For simplicity: we COPY into table (all columns) and rely on header order matching table order.

    For production you'd map header->columns explicitly.
    """
    try:
        validate_ident(schema_name, "schema")
        validate_ident(table, "table")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if mode not in ("append", "replace"):
        raise HTTPException(status_code=400, detail="mode must be append|replace")

    if len(delimiter) != 1:
        raise HTTPException(status_code=400, detail="delimiter must be a single character")

    content = await file.read()

    def _work():
        text = content.decode(encoding, errors="strict")
        bio = io.StringIO(text)

        with get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute(f"TRUNCATE TABLE {qident(schema_name)}.{qident(table)}")

                copy_sql = (
                    f"COPY {qident(schema_name)}.{qident(table)} FROM STDIN "
                    f"WITH (FORMAT csv, HEADER true, DELIMITER '{delimiter}')"
                )

                with cur.copy(copy_sql) as copy:
                    for line in bio:
                        copy.write(line)

                conn.commit()

        return {"imported": True}

    try:
        await run_in_threadpool(_work)
        return {
            "ok": True,
            "schema": schema_name,
            "table": table,
            "mode": mode,
            "filename": file.filename,
        }
    except PsycopgError as e:
        logger.exception("CSV import DB error")
        raise HTTPException(status_code=500, detail=f"Ошибка PostgreSQL во время CSV импорта: {str(e)}")
    except Exception as e:
        logger.exception("CSV import failed")
        raise HTTPException(status_code=500, detail=f"Ошибка CSV импорта: {str(e)}")