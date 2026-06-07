from __future__ import annotations

import os
from typing import Any, Optional

import boto3
from botocore.config import Config
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.services.jobs import create_job, is_cancelled, mark_running, update_job
from app.services.minio_import_placeholder import (
    get_minio_import_plan,
    get_remote_html_import_plan,
    import_files_to_minio,
    import_remote_html_to_minio,
)

router = APIRouter()


def _make_client(endpoint: str, secure: bool):
    scheme = "https" if secure else "http"
    return boto3.client(
        "s3",
        endpoint_url=f"{scheme}://{endpoint}",
        aws_access_key_id=os.getenv("MINIO_ACCESS_KEY", "minioadmin"),
        aws_secret_access_key=os.getenv("MINIO_SECRET_KEY", "minioadmin"),
        region_name=os.getenv("MINIO_REGION", "us-east-1"),
        config=Config(signature_version="s3v4"),
    )


def s3_client():
    # Внутренний клиент: ходит к MinIO по сети Docker (minio:9000).
    endpoint = os.getenv("MINIO_ENDPOINT", "minio:9000")
    secure = os.getenv("MINIO_SECURE", "false").lower() in ("1", "true", "yes")
    return _make_client(endpoint, secure)


def presign_s3_client():
    # Клиент ТОЛЬКО для presigned URL: хост должен быть доступен из БРАУЗЕРА,
    # а не из контейнера. Внутренний minio:9000 браузер не резолвит → сетевая
    # ошибка при PUT/GET. Поэтому берём публичный адрес (по умолчанию
    # localhost:9000 — проброшенный порт; переопределяется MINIO_PUBLIC_ENDPOINT).
    # generate_presigned_url не делает сетевых запросов, так что этот клиент
    # никуда не подключается — он лишь «зашивает» нужный хост в подпись.
    endpoint = os.getenv("MINIO_PUBLIC_ENDPOINT", "localhost:9000")
    secure = os.getenv(
        "MINIO_PUBLIC_SECURE", os.getenv("MINIO_SECURE", "false")
    ).lower() in ("1", "true", "yes")
    return _make_client(endpoint, secure)



def ensure_bucket(client) -> str:
    bucket = os.getenv("MINIO_BUCKET", "documents")
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
        except Exception:
            pass
    return bucket


@router.get("/objects")
def list_objects(
    prefix: Optional[str] = None,
    continuation_token: Optional[str] = None,
    max_keys: int = 200,
) -> dict[str, Any]:
    client = s3_client()
    bucket = ensure_bucket(client)

    max_keys = max(1, min(int(max_keys), 1000))
    kwargs: dict[str, Any] = {"Bucket": bucket, "MaxKeys": max_keys}
    if prefix:
        kwargs["Prefix"] = prefix
    if continuation_token:
        kwargs["ContinuationToken"] = continuation_token

    resp = client.list_objects_v2(**kwargs)
    items = []
    for obj in resp.get("Contents", []) or []:
        items.append(
            {
                "key": obj.get("Key"),
                "size": int(obj.get("Size", 0)),
                "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
            }
        )

    return {
        "bucket": bucket,
        "items": items,
        "is_truncated": bool(resp.get("IsTruncated", False)),
        "next_continuation_token": resp.get("NextContinuationToken"),
        "prefix": prefix,
        "continuation_token": continuation_token,
        "max_keys": max_keys,
    }


@router.post("/presign/upload")
def presign_upload(key: str, content_type: str = "application/octet-stream") -> dict[str, Any]:
    if not key or key.startswith("/") or ".." in key:
        raise HTTPException(status_code=400, detail="Bad key")

    bucket = ensure_bucket(s3_client())

    url = presign_s3_client().generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=60 * 10,
    )

    return {"bucket": bucket, "key": key, "method": "PUT", "url": url}


@router.get("/presign/download")
def presign_download(key: str) -> dict[str, Any]:
    if not key or key.startswith("/") or ".." in key:
        raise HTTPException(status_code=400, detail="Bad key")

    bucket = ensure_bucket(s3_client())

    url = presign_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=60 * 10,
    )

    return {"bucket": bucket, "key": key, "url": url}


@router.delete("/object")
def delete_object(key: str) -> dict[str, Any]:
    if not key or key.startswith("/") or ".." in key:
        raise HTTPException(status_code=400, detail="Bad key")

    client = s3_client()
    bucket = ensure_bucket(client)

    client.delete_object(Bucket=bucket, Key=key)
    return {"ok": True, "deleted": key}


@router.get("/import-plan")
def minio_import_plan() -> dict[str, Any]:
    return get_minio_import_plan()


@router.post("/import/files")
async def minio_import_files(
    files: list[UploadFile] = File(...),
    dry_run: bool = Form(False),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    job_id = create_job("minio_files_import", payload={"dry_run": dry_run, "files": [f.filename for f in files]}, progress_total=max(len(files), 1), stage="queued", message="MinIO file import queued")
    mark_running(job_id, stage="processing", message="Importing files to MinIO", progress_total=max(len(files), 1))

    try:
        def _progress(current: int, total: int, stage: str, message: str | None = None) -> None:
            update_job(job_id, progress_current=current, progress_total=total, stage=stage, message=message)

        def _cancelled() -> bool:
            return is_cancelled(job_id)

        result = import_files_to_minio(files=files, dry_run=dry_run, progress_cb=_progress, cancel_check=_cancelled)
        update_job(job_id, status="done" if result.get("ok", True) else "failed", result=result, progress_current=max(result.get("stats", {}).get("success", 0), 0), finished=True, error=None if result.get("ok", True) else result.get("message"))
        return {**result, "job_id": job_id}
    except HTTPException:
        raise
    except Exception as exc:
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/import/html-plan")
def remote_html_import_plan() -> dict[str, Any]:
    return get_remote_html_import_plan()


@router.post("/import/html-from-documents")
def remote_html_import_from_documents(
    dry_run: bool = Form(False),
    force: bool = Form(False),
    limit: int | None = Form(None),
) -> dict[str, Any]:
    job_id = create_job("minio_html_import", payload={"dry_run": dry_run, "force": force, "limit": limit}, progress_total=max(limit or 1, 1), stage="queued", message="MinIO HTML import queued")
    mark_running(job_id, stage="processing", message="Importing remote HTML", progress_total=max(limit or 1, 1))

    try:
        def _progress(current: int, total: int, stage: str, message: str | None = None) -> None:
            update_job(job_id, progress_current=current, progress_total=total, stage=stage, message=message)

        def _cancelled() -> bool:
            return is_cancelled(job_id)

        result = import_remote_html_to_minio(dry_run=dry_run, limit=limit, force=force, progress_cb=_progress, cancel_check=_cancelled)
        update_job(job_id, status="done" if result.get("ok", True) else "failed", result=result, progress_current=max(result.get("stats", {}).get("success", 0), 0), finished=True, error=None if result.get("ok", True) else result.get("message"))
        return {**result, "job_id": job_id}
    except HTTPException:
        raise
    except Exception as exc:
        update_job(job_id, status="failed", error=str(exc), finished=True)
        raise HTTPException(status_code=500, detail=str(exc))
