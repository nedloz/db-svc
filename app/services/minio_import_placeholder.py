from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import UploadFile

from app.services.pg import get_conn
from app.services.html_processor import clean_html_for_rag

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".html", ".htm"}
CONTENT_TYPE_BY_EXT = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".html": "html",
    ".htm": "html",
}
MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".html": "text/html",
    ".htm": "text/html",
}


@dataclass
class RemoteHtmlDocument:
    id: str
    title: str
    origin_url: str
    content_type: str | None
    content_version: int
    status: str | None
    checksum: str | None
    storage_key: str | None
    file_name: str | None


def _normalize_title(value: str) -> str:
    value = value.strip()
    value = re.sub(r"\s+", " ", value)
    return value


def _s3_client():
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


def _ensure_bucket(client) -> str:
    bucket = os.getenv("MINIO_BUCKET", "documents")
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
        except Exception:
            pass
    return bucket


def _guess_mime(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in MIME_BY_EXT:
        return MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _build_storage_key(document_id: str, content_version: int, filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    return f"documents/{document_id}/v{content_version}/original/source.{ext}"


def _calc_sha256_and_size(file_obj) -> tuple[str, int]:
    sha = hashlib.sha256()
    total = 0
    file_obj.seek(0)
    while True:
        chunk = file_obj.read(1024 * 1024)
        if not chunk:
            break
        sha.update(chunk)
        total += len(chunk)
    file_obj.seek(0)
    return sha.hexdigest(), total


def _load_documents_map() -> tuple[dict[str, dict[str, Any]], list[str]]:
    docs_by_title: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    id,
                    title,
                    content_type,
                    COALESCE(content_version, 1) AS content_version,
                    status,
                    checksum
                FROM library.documents
                """
            )
            rows = cur.fetchall()

    seen: set[str] = set()
    duplicate_set: set[str] = set()
    for row in rows:
        title = _normalize_title(row[1])
        if title in seen:
            duplicate_set.add(title)
        else:
            seen.add(title)

    duplicates = sorted(duplicate_set)

    for row in rows:
        key = _normalize_title(row[1])
        if key in duplicate_set:
            continue
        docs_by_title[key] = {
            "id": row[0],
            "title": row[1],
            "content_type": (row[2] or "").strip().lower() if row[2] else None,
            "content_version": int(row[3] or 1),
            "status": row[4],
            "checksum": row[5],
        }

    return docs_by_title, duplicates


def get_minio_import_plan() -> dict[str, Any]:
    docs_by_title, duplicates = _load_documents_map()
    return {
        "ok": True,
        "implemented": True,
        "match_strategy": "documents.title == filename_without_extension",
        "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
        "documents_available": len(docs_by_title),
        "duplicate_titles": duplicates,
        "steps": [
            "прочитать загруженные файлы",
            "сопоставить каждый файл с library.documents по title",
            "проверить content_type по расширению",
            "посчитать sha256 и размер",
            "загрузить файл в MinIO по пути documents/{document_id}/v{content_version}/original/source.{ext}",
            "создать или обновить запись в library.document_files",
            "обновить library.documents.checksum и library.documents.status='published'",
        ],
        "notes": [
            "Теперь запись в library.document_files создается даже без уникального индекса на document_id.",
            "Если title в library.documents не уникален, такие документы не импортируются до исправления дублей.",
        ],
    }


def _upsert_document_file_manual(
    conn,
    *,
    document_id: str,
    bucket: str,
    storage_key: str,
    storage_path: str,
    filename: str,
    mime_type: str,
    size_bytes: int,
    sha256: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE library.document_files
            SET
                storage_backend = 'minio',
                bucket = %s,
                storage_key = %s,
                storage_path = %s,
                file_name = %s,
                mime_type = %s,
                size_bytes = %s,
                sha256_hash = %s
            WHERE document_id = %s
            """,
            (
                bucket,
                storage_key,
                storage_path,
                filename,
                mime_type,
                size_bytes,
                sha256,
                document_id,
            ),
        )
        if cur.rowcount == 0:
            cur.execute(
                """
                INSERT INTO library.document_files (
                    document_id,
                    storage_backend,
                    bucket,
                    storage_key,
                    storage_path,
                    file_name,
                    mime_type,
                    size_bytes,
                    sha256_hash
                )
                VALUES (%s, 'minio', %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    document_id,
                    bucket,
                    storage_key,
                    storage_path,
                    filename,
                    mime_type,
                    size_bytes,
                    sha256,
                ),
            )



def _sanitize_filename(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return value or "document"


def _build_html_filename(doc: RemoteHtmlDocument) -> str:
    parsed = urlparse(doc.origin_url)
    stem = Path(parsed.path).stem or _sanitize_filename(doc.title)
    stem = _sanitize_filename(stem)
    return f"{stem}.html"


def _load_remote_html_documents() -> list[RemoteHtmlDocument]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    d.id,
                    d.title,
                    d.origin_url,
                    d.content_type,
                    COALESCE(d.content_version, 1) AS content_version,
                    d.status,
                    d.checksum,
                    df.storage_key,
                    df.file_name
                FROM library.documents d
                LEFT JOIN library.document_files df
                    ON df.document_id = d.id
                WHERE d.origin_url IS NOT NULL
                  AND btrim(d.origin_url) <> ''
                  AND lower(COALESCE(d.content_type, '')) = 'html'
                ORDER BY d.title
                """
            )
            rows = cur.fetchall()

    items: list[RemoteHtmlDocument] = []
    for row in rows:
        items.append(
            RemoteHtmlDocument(
                id=str(row[0]),
                title=row[1],
                origin_url=row[2],
                content_type=row[3],
                content_version=int(row[4] or 1),
                status=row[5],
                checksum=row[6],
                storage_key=row[7],
                file_name=row[8],
            )
        )
    return items


def get_remote_html_import_plan() -> dict[str, Any]:
    docs = _load_remote_html_documents()
    pending = []
    imported = []
    for doc in docs:
        item = {
            "document_id": doc.id,
            "title": doc.title,
            "origin_url": doc.origin_url,
            "content_version": doc.content_version,
            "status": doc.status,
            "storage_key": doc.storage_key,
            "file_name": doc.file_name,
            "already_loaded": bool(doc.storage_key),
        }
        (imported if doc.storage_key else pending).append(item)

    return {
        "ok": True,
        "implemented": True,
        "match_strategy": "library.documents rows with content_type=html and non-empty origin_url",
        "summary": {
            "total_html_documents": len(docs),
            "already_loaded": len(imported),
            "pending": len(pending),
        },
        "pending": pending,
        "already_loaded": imported,
        "steps": [
            "выбрать из library.documents только записи с content_type=html и origin_url",
            "пропустить документы, у которых уже есть запись в library.document_files",
            "скачать HTML по origin_url",
            "загрузить HTML в MinIO",
            "создать или обновить запись в library.document_files",
            "обновить checksum и status='published' у library.documents",
        ],
    }


def _download_remote_html(url: str, timeout: int = 20) -> tuple[bytes, str | None]:
    request = Request(
        url,
        headers={
            "User-Agent": "db-svc-html-import/1.0",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
        content_type = response.headers.get("Content-Type")
    return body, content_type


def import_remote_html_to_minio(dry_run: bool = False, limit: int | None = None, force: bool = False, progress_cb=None, cancel_check=None) -> dict[str, Any]:
    docs = _load_remote_html_documents()
    candidates = docs if force else [doc for doc in docs if not doc.storage_key]
    if limit is not None and limit > 0:
        candidates = candidates[:limit]

    stats = {
        "total_html_documents": len(docs),
        "selected": len(candidates),
        "already_loaded": len([doc for doc in docs if doc.storage_key]),
        "success": 0,
        "download_failed": 0,
        "upload_failed": 0,
        "db_failed": 0,
        "skipped_non_html_response": 0,
        "txt_converted": 0,
        "txt_conversion_failed": 0,
        "dry_run": dry_run,
        "force": force,
    }
    results: list[dict[str, Any]] = []

    client = None
    bucket = os.getenv("MINIO_BUCKET", "documents")
    if not dry_run:
        client = _s3_client()
        bucket = _ensure_bucket(client)

    total = max(len(candidates), 1)
    for idx, doc in enumerate(candidates, 1):
        if progress_cb is not None:
            progress_cb(idx - 1, total, "download", f"Processing {idx}/{total}")
        if cancel_check is not None and cancel_check():
            raise RuntimeError("Job cancelled")
        filename = _build_html_filename(doc)
        try:
            body, response_content_type = _download_remote_html(doc.origin_url)
        except (HTTPError, URLError, TimeoutError, Exception) as exc:
            stats["download_failed"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": False,
                "status": "download_failed",
                "message": str(exc),
            })
            continue

        content_type_header = (response_content_type or "").lower()
        if "html" not in content_type_header and not body.lstrip().startswith((b"<!DOCTYPE html", b"<html", b"<HTML")):
            stats["skipped_non_html_response"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": False,
                "status": "skipped_non_html_response",
                "response_content_type": response_content_type,
            })
            continue

        sha256 = hashlib.sha256(body).hexdigest()
        size_bytes = len(body)
        storage_key = _build_storage_key(doc.id, doc.content_version, filename)
        storage_path = f"{bucket}/{storage_key}"

        if dry_run:
            stats["success"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": True,
                "status": "dry_run",
                "bucket": bucket,
                "storage_key": storage_key,
                "checksum": sha256,
                "size_bytes": size_bytes,
            })
            continue

        try:
            with tempfile.SpooledTemporaryFile() as tmp:
                tmp.write(body)
                tmp.seek(0)
                client.upload_fileobj(
                    Fileobj=tmp,
                    Bucket=bucket,
                    Key=storage_key,
                    ExtraArgs={"ContentType": "text/html; charset=utf-8"},
                )
        except (ClientError, BotoCoreError, Exception) as exc:
            stats["upload_failed"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": False,
                "status": "upload_failed",
                "message": str(exc),
            })
            continue

        # --- Текстовая версия для RAG-чанкинга ---
        # Рядом с сырым .html кладём очищенный .txt (Markdown без nav/footer/скриптов).
        # Сбой конвертации НЕ роняет импорт самого .html — просто .txt не создаётся.
        txt_storage_key: str | None = None
        try:
            encoding_hint = (response_content_type or "utf-8").split("charset=")[-1].split(";")[0].strip() or "utf-8"
            markdown_text = clean_html_for_rag(body, encoding=encoding_hint)
            txt_storage_key = storage_key.rsplit(".", 1)[0] + ".txt"
            txt_bytes = markdown_text.encode("utf-8")
            with tempfile.SpooledTemporaryFile() as txt_tmp:
                txt_tmp.write(txt_bytes)
                txt_tmp.seek(0)
                client.upload_fileobj(
                    Fileobj=txt_tmp,
                    Bucket=bucket,
                    Key=txt_storage_key,
                    ExtraArgs={"ContentType": "text/plain; charset=utf-8"},
                )
            stats["txt_converted"] += 1
        except Exception:
            stats["txt_conversion_failed"] += 1
            txt_storage_key = None

        try:
            with get_conn() as conn:
                _upsert_document_file_manual(
                    conn,
                    document_id=doc.id,
                    bucket=bucket,
                    storage_key=storage_key,
                    storage_path=storage_path,
                    filename=filename,
                    mime_type="text/html",
                    size_bytes=size_bytes,
                    sha256=sha256,
                )
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE library.documents
                        SET checksum = %s,
                            status = 'published',
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (sha256, doc.id),
                    )
                conn.commit()
        except Exception as exc:
            stats["db_failed"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": False,
                "status": "db_failed",
                "message": str(exc),
            })
            continue

        stats["success"] += 1
        results.append({
            "document_id": doc.id,
            "title": doc.title,
            "origin_url": doc.origin_url,
            "ok": True,
            "status": "imported",
            "bucket": bucket,
            "storage_key": storage_key,
            "checksum": sha256,
            "size_bytes": size_bytes,
        })

    return {
        "ok": stats["download_failed"] == 0 and stats["upload_failed"] == 0 and stats["db_failed"] == 0 and stats["skipped_non_html_response"] == 0,
        "message": "Импорт HTML страниц по origin_url завершён",
        "stats": stats,
        "results": results,
    }


def import_files_to_minio(files: list[UploadFile], dry_run: bool = False, progress_cb=None, cancel_check=None) -> dict[str, Any]:
    docs_by_title, duplicates = _load_documents_map()
    stats = {
        "total_files": 0,
        "success": 0,
        "unmatched": 0,
        "ambiguous_titles": len(duplicates),
        "type_mismatch": 0,
        "upload_failed": 0,
        "db_failed": 0,
        "skipped_unsupported": 0,
        "dry_run": dry_run,
    }
    results: list[dict[str, Any]] = []

    if duplicates:
        return {
            "ok": False,
            "message": "Импорт остановлен: в library.documents есть дубли по title.",
            "stats": stats,
            "duplicate_titles": duplicates,
            "results": results,
        }

    client = None
    bucket = os.getenv("MINIO_BUCKET", "documents")
    if not dry_run:
        client = _s3_client()
        bucket = _ensure_bucket(client)

    total = max(len(files), 1)
    for idx, upload in enumerate(files, 1):
        if progress_cb is not None:
            progress_cb(idx - 1, total, "upload", f"Processing {idx}/{total}")
        if cancel_check is not None and cancel_check():
            raise RuntimeError("Job cancelled")
        filename = upload.filename or ""
        ext = Path(filename).suffix.lower()
        stats["total_files"] += 1

        if ext not in ALLOWED_EXTENSIONS:
            stats["skipped_unsupported"] += 1
            results.append({
                "filename": filename,
                "ok": False,
                "status": "skipped_unsupported",
                "message": f"Расширение {ext or '<empty>'} не поддерживается",
            })
            continue

        title = _normalize_title(Path(filename).stem)
        doc = docs_by_title.get(title)
        if not doc:
            stats["unmatched"] += 1
            results.append({
                "filename": filename,
                "ok": False,
                "status": "unmatched",
                "title": title,
                "message": "В library.documents не найден title, совпадающий с именем файла без расширения",
            })
            continue

        expected_content_type = doc["content_type"]
        actual_content_type = CONTENT_TYPE_BY_EXT.get(ext)
        if expected_content_type and expected_content_type != actual_content_type:
            stats["type_mismatch"] += 1
            results.append({
                "filename": filename,
                "ok": False,
                "status": "type_mismatch",
                "document_id": str(doc["id"]),
                "title": title,
                "expected_content_type": expected_content_type,
                "actual_content_type": actual_content_type,
            })
            continue

        try:
            sha256, size_bytes = _calc_sha256_and_size(upload.file)
            mime_type = _guess_mime(filename)
            storage_key = _build_storage_key(str(doc["id"]), int(doc["content_version"]), filename)
            storage_path = f"{bucket}/{storage_key}"

            if dry_run:
                stats["success"] += 1
                results.append({
                    "filename": filename,
                    "ok": True,
                    "status": "dry_run",
                    "document_id": str(doc["id"]),
                    "title": title,
                    "bucket": bucket,
                    "storage_key": storage_key,
                    "checksum": sha256,
                    "size_bytes": size_bytes,
                })
                continue

            try:
                upload.file.seek(0)
                client.upload_fileobj(
                    Fileobj=upload.file,
                    Bucket=bucket,
                    Key=storage_key,
                    ExtraArgs={"ContentType": mime_type},
                )
            except (ClientError, BotoCoreError, Exception) as exc:
                stats["upload_failed"] += 1
                results.append({
                    "filename": filename,
                    "ok": False,
                    "status": "upload_failed",
                    "document_id": str(doc["id"]),
                    "title": title,
                    "message": str(exc),
                })
                continue

            try:
                with get_conn() as conn:
                    _upsert_document_file_manual(
                        conn,
                        document_id=str(doc["id"]),
                        bucket=bucket,
                        storage_key=storage_key,
                        storage_path=storage_path,
                        filename=filename,
                        mime_type=mime_type,
                        size_bytes=size_bytes,
                        sha256=sha256,
                    )
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE library.documents
                            SET checksum = %s,
                                status = 'published',
                                updated_at = now()
                            WHERE id = %s
                            """,
                            (sha256, str(doc["id"])),
                        )
                    conn.commit()
            except Exception as exc:
                stats["db_failed"] += 1
                results.append({
                    "filename": filename,
                    "ok": False,
                    "status": "db_failed",
                    "document_id": str(doc["id"]),
                    "title": title,
                    "message": str(exc),
                })
                continue

            stats["success"] += 1
            results.append({
                "filename": filename,
                "ok": True,
                "status": "imported",
                "document_id": str(doc["id"]),
                "title": title,
                "bucket": bucket,
                "storage_key": storage_key,
                "checksum": sha256,
                "size_bytes": size_bytes,
            })
        finally:
            try:
                upload.file.close()
            except Exception:
                pass

    return {
        "ok": stats["db_failed"] == 0 and stats["upload_failed"] == 0 and stats["type_mismatch"] == 0 and stats["unmatched"] == 0,
        "message": "Импорт в MinIO завершён",
        "stats": stats,
        "results": results,
    }
