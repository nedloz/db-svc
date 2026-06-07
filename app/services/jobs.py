from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from psycopg.types.json import Json

from app.services.pg import get_conn

JOBS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS public.dbsvc_jobs (
    id UUID PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    message TEXT,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
)
"""


def ensure_jobs_table() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(JOBS_TABLE_SQL)
        conn.commit()



def create_job(job_type: str, *, payload: dict[str, Any] | None = None, progress_total: int = 0, stage: str | None = None, message: str | None = None) -> str:
    job_id = str(uuid.uuid4())
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.dbsvc_jobs (
                    id, job_type, status, stage, message, progress_current, progress_total,
                    cancel_requested, payload, created_at, updated_at
                )
                VALUES (%s, %s, 'queued', %s, %s, 0, %s, FALSE, %s, now(), now())
                """,
                (job_id, job_type, stage, message, progress_total, Json(payload or {})),
            )
        conn.commit()
    return job_id



def get_job(job_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, job_type, status, stage, message, progress_current, progress_total,
                       cancel_requested, payload, result, error, created_at, updated_at, finished_at, cancelled_at
                FROM public.dbsvc_jobs
                WHERE id = %s
                """,
                (job_id,),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return {
        'id': str(row[0]),
        'job_type': row[1],
        'status': row[2],
        'stage': row[3],
        'message': row[4],
        'progress_current': int(row[5] or 0),
        'progress_total': int(row[6] or 0),
        'cancel_requested': bool(row[7]),
        'payload': row[8] or {},
        'result': row[9],
        'error': row[10],
        'created_at': row[11].isoformat() if row[11] else None,
        'updated_at': row[12].isoformat() if row[12] else None,
        'finished_at': row[13].isoformat() if row[13] else None,
        'cancelled_at': row[14].isoformat() if row[14] else None,
    }



def update_job(
    job_id: str,
    *,
    status: str | None = None,
    stage: str | None = None,
    message: str | None = None,
    progress_current: int | None = None,
    progress_total: int | None = None,
    cancel_requested: bool | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    finished: bool = False,
    cancelled: bool = False,
) -> None:
    sets: list[str] = ['updated_at = now()']
    params: list[Any] = []
    if status is not None:
        sets.append('status = %s')
        params.append(status)
    if stage is not None:
        sets.append('stage = %s')
        params.append(stage)
    if message is not None:
        sets.append('message = %s')
        params.append(message)
    if progress_current is not None:
        sets.append('progress_current = %s')
        params.append(progress_current)
    if progress_total is not None:
        sets.append('progress_total = %s')
        params.append(progress_total)
    if cancel_requested is not None:
        sets.append('cancel_requested = %s')
        params.append(cancel_requested)
    if result is not None:
        sets.append('result = %s')
        params.append(Json(result))
    if error is not None:
        sets.append('error = %s')
        params.append(error)
    if finished:
        sets.append('finished_at = COALESCE(finished_at, now())')
    if cancelled:
        sets.append('cancelled_at = COALESCE(cancelled_at, now())')

    params.append(job_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE public.dbsvc_jobs SET {', '.join(sets)} WHERE id = %s", params)
        conn.commit()



def mark_running(job_id: str, *, stage: str | None = None, message: str | None = None, progress_total: int | None = None) -> None:
    update_job(job_id, status='running', stage=stage, message=message, progress_total=progress_total)



def mark_done(job_id: str, *, result: dict[str, Any]) -> None:
    update_job(job_id, status='done', result=result, progress_current=get_job(job_id)['progress_total'], finished=True)



def mark_failed(job_id: str, *, error: str) -> None:
    update_job(job_id, status='failed', error=error, finished=True)



def request_cancel(job_id: str) -> dict[str, Any] | None:
    job = get_job(job_id)
    if job is None:
        return None

    # If not yet running, mark immediately cancelled. If running, set the flag and let the worker stop.
    if job['status'] in {'queued', 'pending'}:
        update_job(job_id, status='cancelled', cancel_requested=True, cancelled=True, finished=True, message='Cancelled before start')
    else:
        update_job(job_id, cancel_requested=True, message='Cancellation requested')
    return get_job(job_id)



def is_cancelled(job_id: str) -> bool:
    job = get_job(job_id)
    if not job:
        return True
    return job['status'] == 'cancelled' or bool(job['cancel_requested'])



def progress_callback(job_id: str):
    def _cb(current: int, total: int, stage: str | None = None, message: str | None = None) -> None:
        update_job(job_id, progress_current=current, progress_total=total, stage=stage, message=message)
    return _cb
