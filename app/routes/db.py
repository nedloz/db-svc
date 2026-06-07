from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.services.catalog import (
    delete_row,
    export_csv_text,
    get_dependencies,
    get_inbound_relations,
    get_column_allowed_values,
    get_primary_key_columns,
    get_relations,
    get_table_columns,
    get_table_column_map,
    insert_row,
    list_rows,
    update_row,
)
from app.services.csv_import import import_csv_with_report
from app.services.import_pipeline import dataset_status, run_dataset_import
from app.services.jobs import create_job, get_job, is_cancelled, mark_running, update_job
from app.services.pg import check_db_connection, get_conn

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_pk(pk: str):
    # Составной PK приходит как URL-encoded JSON-объект {col: val, ...} (P-010).
    # Одиночный — как голое значение (UUID/число/строка). JSON-объект → dict,
    # иначе оставляем строку как есть.
    try:
        value = json.loads(pk)
    except (ValueError, TypeError):
        return pk
    return value if isinstance(value, dict) else pk


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
    return await run_in_threadpool(check_db_connection)


# ВНИМАНИЕ (P-012): эти три /import/* роута должны быть объявлены ВЫШЕ generic
# /{schema}/{table} и /{schema}/{table}/... — иначе FastAPI матчит, например,
# POST /api/db/import/csv как POST /{schema}/{table} с schema='import', table='csv'
# и пытается распарсить multipart body как JSON dict → 422 dict_type.
# Не переноси их вниз файла без перетряхивания generic-роутов.

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
    job_id = create_job(
        "dataset_import",
        payload={"replace_mode": replace_mode, "dry_run": dry_run},
        progress_total=0,
        stage="queued",
        message="Dataset import queued",
    )
    mark_running(job_id, stage="reading", message="Reading CSV files", progress_total=12)

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

        def _progress(current: int, total: int, stage: str, message: str | None = None) -> None:
            update_job(job_id, progress_current=current, progress_total=total, stage=stage, message=message)

        def _cancelled() -> bool:
            return is_cancelled(job_id)

        def _work():
            return run_dataset_import(
                file_map,
                dry_run=dry_run,
                replace_mode=replace_mode,
                progress_cb=_progress,
                cancel_check=_cancelled,
            )

        result = await run_in_threadpool(_work)
        final_status = "done" if result.get("ok", True) else "failed"
        job = get_job(job_id)
        progress_total = job["progress_total"] if job else 0
        error_text = None if result.get("ok", True) else (result.get("detail") or (result.get("errors") or ["Import failed"])[0])
        update_job(job_id, status=final_status, result=result, progress_current=progress_total, finished=True, error=error_text)
        return {**result, "job_id": job_id}
    except RuntimeError as exc:
        if "cancelled" in str(exc).lower():
            update_job(job_id, status="cancelled", error=str(exc), cancelled=True, finished=True)
            raise HTTPException(status_code=499, detail="Job cancelled")
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=f"Ошибка импорта: {str(exc)}")
    except Exception as exc:
        logger.exception("Dataset import failed")
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=f"Ошибка импорта: {str(exc)}")


@router.post("/import/csv")
async def import_csv(
    file: UploadFile = File(...),
    schema_name: str = Form(..., alias="schema"),
    table: str = Form(...),
    mode: str = Form("append"),
    delimiter: str = Form(","),
    encoding: str = Form("utf-8"),
) -> dict[str, Any]:
    job_id = create_job(
        "csv_import",
        payload={"schema": schema_name, "table": table, "mode": mode, "delimiter": delimiter, "encoding": encoding},
        progress_total=0,
        stage="queued",
        message="CSV import queued",
    )
    try:
        content = await file.read()

        def _progress(current: int, total: int, stage: str, message: str | None = None) -> None:
            update_job(job_id, progress_current=current, progress_total=total, stage=stage, message=message)

        def _cancelled() -> bool:
            return is_cancelled(job_id)

        def _work():
            return import_csv_with_report(
                file_bytes=content,
                schema=schema_name,
                table=table,
                mode=mode,
                delimiter=delimiter,
                encoding=encoding,
                filename=file.filename,
                progress_cb=_progress,
                cancel_check=_cancelled,
            )

        mark_running(job_id, stage="parse", message="Parsing CSV", progress_total=1)
        result = await run_in_threadpool(_work)
        if result.get("ok"):
            update_job(job_id, status="done", result=result, progress_current=max(result.get("rows_inserted", 0), result.get("rows_inserted_before_failure", 0)), progress_total=max(result.get("rows_inserted", 0), 1), finished=True)
            return {**result, "job_id": job_id}
        update_job(job_id, status="failed", result=result, error=result.get("detail", "CSV import failed"), finished=True)
        raise HTTPException(status_code=400, detail=result)
    except HTTPException:
        raise
    except RuntimeError as exc:
        if "cancelled" in str(exc).lower():
            update_job(job_id, status="cancelled", error=str(exc), cancelled=True, finished=True)
            raise HTTPException(status_code=499, detail="Job cancelled")
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=f"Ошибка CSV импорта: {str(exc)}")
    except Exception as exc:
        logger.exception("CSV import failed")
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=f"Ошибка CSV импорта: {str(exc)}")


@router.get("/{schema}/tables")
async def list_tables(schema: str) -> dict[str, Any]:
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
    cols = await run_in_threadpool(get_table_columns, schema, table)
    return {
        "schema": schema,
        "table": table,
        "columns": [
            {
                "name": c.name,
                "type": c.data_type,
                "udt_name": c.udt_name,
                "nullable": c.nullable,
                "default": c.default,
                "is_pk": c.is_pk,
                "is_identity": c.is_identity,
                "is_generated": c.is_generated,
            }
            for c in cols
        ],
    }


@router.get("/{schema}/{table}/enums")
async def list_column_enums(schema: str, table: str) -> dict[str, Any]:
    # P-011: допустимые значения колонок (enum-типы + CHECK col IN (...)).
    enums = await run_in_threadpool(get_column_allowed_values, schema, table)
    return {"schema": schema, "table": table, "enums": enums}


@router.get("/{schema}/{table}/rows")
async def get_rows(
    schema: str,
    table: str,
    limit: int = 50,
    offset: int = 0,
    order_by: str | None = None,
    direction: str | None = None,
    filter: str | None = Query(default=None, alias="filter"),
) -> dict[str, Any]:
    filters = None
    if filter:
        try:
            filters = json.loads(filter)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="filter must be valid JSON")
    return await run_in_threadpool(
        list_rows,
        schema,
        table,
        limit=limit,
        offset=offset,
        order_by=order_by,
        direction=direction,
        filters=filters,
    )


@router.post("/{schema}/{table}/query")
async def query_rows(schema: str, table: str, payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    payload = payload or {}
    filters = payload.get("filters") or payload.get("filter") or []
    return await run_in_threadpool(
        list_rows,
        schema,
        table,
        limit=int(payload.get("limit", 50)),
        offset=int(payload.get("offset", 0)),
        order_by=payload.get("order_by"),
        direction=payload.get("direction"),
        filters=filters,
    )


@router.post("/{schema}/{table}", status_code=201)
async def create_row(schema: str, table: str, payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    payload = payload or {}
    try:
        return await run_in_threadpool(insert_row, schema, table, payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Row insert failed")
        raise HTTPException(status_code=500, detail=str(exc))


@router.patch("/{schema}/{table}/{pk}")
async def patch_row(schema: str, table: str, pk: str, payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    payload = payload or {}
    try:
        row = await run_in_threadpool(update_row, schema, table, _parse_pk(pk), payload)
        if row is None:
            raise HTTPException(status_code=404, detail="Row not found")
        return row
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Row update failed")
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/{schema}/{table}/{pk}", status_code=204)
async def delete_table_row(schema: str, table: str, pk: str):
    try:
        deleted = await run_in_threadpool(delete_row, schema, table, _parse_pk(pk))
        if not deleted:
            raise HTTPException(status_code=404, detail="Row not found")
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Row delete failed")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{schema}/{table}/relations")
async def table_relations(schema: str, table: str) -> dict[str, Any]:
    outbound = await run_in_threadpool(get_relations, schema, table)
    return {"schema": schema, "table": table, "relations": outbound}


@router.get("/{schema}/{table}/relations/inbound")
async def table_relations_inbound(schema: str, table: str) -> dict[str, Any]:
    inbound = await run_in_threadpool(get_inbound_relations, schema, table)
    return {"schema": schema, "table": table, "relations": inbound}


@router.get("/{schema}/{table}/{pk}/dependencies")
async def table_dependencies(schema: str, table: str, pk: str, sample: int = 3) -> dict[str, Any]:
    return await run_in_threadpool(get_dependencies, schema, table, _parse_pk(pk), sample)


@router.get("/{schema}/{table}/export.csv")
async def export_table_csv(
    schema: str,
    table: str,
    limit: int = 50000,
    offset: int = 0,
    order_by: str | None = None,
    direction: str | None = None,
    filter: str | None = Query(default=None, alias="filter"),
) -> Response:
    filters = None
    if filter:
        try:
            filters = json.loads(filter)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="filter must be valid JSON")

    text, meta = await run_in_threadpool(
        export_csv_text,
        schema,
        table,
        limit=limit,
        offset=offset,
        order_by=order_by,
        direction=direction,
        filters=filters,
    )
    filename = f"{schema}_{table}.csv"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Export-Truncated": "true" if meta.get("truncated") else "false",
    }
    return Response(content=text, media_type="text/csv; charset=utf-8", headers=headers)


# Import-роуты были перенесены выше в файле — перед generic /{schema}/{table}.
# См. PROBLEMS.md → P-012 (route order matters in FastAPI).
