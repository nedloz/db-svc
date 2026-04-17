from __future__ import annotations

import os
from typing import Any, Optional

import boto3
from botocore.config import Config
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from app.services.minio_import_placeholder import (
    get_minio_import_plan,
    get_remote_html_import_plan,
    import_files_to_minio,
    import_remote_html_to_minio,
)

router = APIRouter()


def s3_client():
    endpoint = os.getenv("MINIO_ENDPOINT", "minio:9000")
    access_key = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    secret_key = os.getenv("MINIO_SECRET_KEY", "minioadmin")
    secure = os.getenv("MINIO_SECURE", "false").lower() in ("1", "true", "yes")

    scheme = "https" if secure else "http"
    endpoint_url = f"{scheme}://{endpoint}"

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.getenv("MINIO_REGION", "us-east-1"),
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket(client) -> str:
    bucket = os.getenv("MINIO_BUCKET", "documents")
    # Create if missing
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
        except Exception:
            pass
    return bucket


@router.get("/objects")
def list_objects(prefix: Optional[str] = None) -> dict[str, Any]:
    client = s3_client()
    bucket = ensure_bucket(client)

    kwargs: dict[str, Any] = {"Bucket": bucket, "MaxKeys": 200}
    if prefix:
        kwargs["Prefix"] = prefix

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

    return {"bucket": bucket, "items": items}


@router.post("/presign/upload")
def presign_upload(key: str, content_type: str = "application/octet-stream") -> dict[str, Any]:
    if not key or key.startswith("/") or ".." in key:
        raise HTTPException(status_code=400, detail="Bad key")

    client = s3_client()
    bucket = ensure_bucket(client)

    url = client.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=60 * 10,
    )

    return {"bucket": bucket, "key": key, "method": "PUT", "url": url}


@router.get("/presign/download")
def presign_download(key: str) -> dict[str, Any]:
    if not key or key.startswith("/") or ".." in key:
        raise HTTPException(status_code=400, detail="Bad key")

    client = s3_client()
    bucket = ensure_bucket(client)

    url = client.generate_presigned_url(
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
    return import_files_to_minio(files=files, dry_run=dry_run)


@router.get("/import/html-plan")
def remote_html_import_plan() -> dict[str, Any]:
    return get_remote_html_import_plan()


@router.post("/import/html-from-documents")
def remote_html_import_from_documents(
    dry_run: bool = Form(False),
    force: bool = Form(False),
    limit: int | None = Form(None),
) -> dict[str, Any]:
    return import_remote_html_to_minio(dry_run=dry_run, limit=limit, force=force)
