from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services.jobs import get_job, request_cancel

router = APIRouter()


@router.get('/{job_id}')
def read_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail='Job not found')
    return job


@router.delete('/{job_id}')
def cancel_job(job_id: str):
    job = request_cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail='Job not found')
    return job
