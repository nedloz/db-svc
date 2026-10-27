from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from typing import Any, BinaryIO, Callable

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import UploadFile

from app import s3_tls
from app.services.pg import get_conn
from app.services.html_processor import clean_html_for_rag

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".html", ".htm", ".txt"}
ARCHIVE_EXTENSION = ".zip"
CONTENT_TYPE_BY_EXT = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".html": "html",
    ".htm": "html",
    ".txt": "txt",
}
MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain; charset=utf-8",
}

# Лимиты на архив. Распаковка идёт во временные файлы, а размер в заголовке zip можно
# подделать, поэтому лимит проверяется и по заголовку, и по фактически прочитанным байтам.
ZIP_MAX_MEMBERS = int(os.getenv("IMPORT_ZIP_MAX_FILES", "1000"))
ZIP_MAX_TOTAL_BYTES = int(float(os.getenv("IMPORT_ZIP_MAX_TOTAL_MB", "2048")) * 1024 * 1024)
ZIP_MAX_MEMBER_BYTES = int(float(os.getenv("IMPORT_ZIP_MAX_FILE_MB", "200")) * 1024 * 1024)
ZIP_MANIFEST_MAX_BYTES = 20 * 1024 * 1024
ZIP_MANIFEST_NAME = "manifest.json"


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
    access_key = os.environ["MINIO_ACCESS_KEY"]
    secret_key = os.environ["MINIO_SECRET_KEY"]
    secure = os.getenv("MINIO_SECURE", "false").lower() in ("1", "true", "yes")

    scheme = "https" if secure else "http"
    endpoint_url = f"{scheme}://{endpoint}"

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.getenv("MINIO_REGION", "us-east-1"),
        verify=s3_tls.verify(),
        config=Config(signature_version="s3v4", client_cert=s3_tls.client_cert()),
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


def _load_documents_by_id() -> dict[str, dict[str, Any]]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, title, content_type, COALESCE(content_version, 1), status, checksum
                FROM library.documents
                """
            )
            rows = cur.fetchall()
    return {
        str(r[0]): {
            "id": r[0],
            "title": r[1],
            "content_type": (r[2] or "").strip().lower() if r[2] else None,
            "content_version": int(r[3] or 1),
            "status": r[4],
            "checksum": r[5],
        }
        for r in rows
    }


def get_minio_import_plan() -> dict[str, Any]:
    docs_by_title, duplicates = _load_documents_map()
    return {
        "ok": True,
        "implemented": True,
        "match_strategy": "document_id из manifest.json архива, иначе documents.title == filename_without_extension",
        "archives": {
            "extension": ARCHIVE_EXTENSION,
            "manifest": ZIP_MANIFEST_NAME,
            "max_files": ZIP_MAX_MEMBERS,
            "max_total_mb": round(ZIP_MAX_TOTAL_BYTES / 1024 / 1024),
            "max_file_mb": round(ZIP_MAX_MEMBER_BYTES / 1024 / 1024),
        },
        "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
        "documents_available": len(docs_by_title),
        "duplicate_titles": duplicates,
        "steps": [
            "распаковать .zip (структура папок внутри не важна) и прочитать manifest.json, если он есть",
            "прочитать загруженные файлы",
            "сопоставить каждый файл с library.documents: по document_id из манифеста, иначе по title",
            "проверить content_type по расширению",
            "посчитать sha256 и размер",
            "загрузить файл в MinIO по пути documents/{document_id}/v{content_version}/original/source.{ext}",
            "создать или обновить запись в library.document_files",
            "обновить library.documents.checksum и library.documents.status='published'",
        ],
        "notes": [
            "Теперь запись в library.document_files создается даже без уникального индекса на document_id.",
            "Если title в library.documents не уникален, такие файлы без манифеста не импортируются до исправления дублей.",
            "В манифесте имя файла может быть усечено (имена длиннее 255 байт), поэтому с манифестом сопоставление идёт строго по document_id, а не по имени.",
        ],
    }


# Привязка файла к документу. Кроме checksum и публикации ставит документ в очередь индексации:
# без этого документ, у которого файла не было (IVHR-1), оставался в pending без движения до
# случайного опроса, а документ с заменённым файлом не переиндексировался. Условие повторяет логику
# «содержимое новое»: другой checksum либо документ ещё не проиндексирован. В SET все правые части
# видят старую строку, поэтому checksum и ingest_status сравниваются со значениями до обновления.
# Триггеры library.documents_ingest_reset / _notify (миграция 006) сбрасывают счётчик попыток и будят воркер.
ATTACH_FILE_SQL = """
    UPDATE library.documents
    SET checksum = %s,
        status = 'published',
        updated_at = now(),
        ingest_status = CASE WHEN checksum IS DISTINCT FROM %s OR ingest_status <> 'indexed'
                             THEN 'pending' ELSE ingest_status END,
        ingest_error = CASE WHEN checksum IS DISTINCT FROM %s OR ingest_status <> 'indexed'
                            THEN NULL ELSE ingest_error END
    WHERE id = %s
"""


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


def _build_source_filename(doc: RemoteHtmlDocument) -> str:
    """Имя сохраняемого файла — всегда .txt.

    Страница скачивается как HTML, но в хранилище попадает уже очищенный текст, поэтому и
    расширение, и ключ в MinIO (`_build_storage_key` берёт его отсюда), и запись в
    library.document_files описывают именно .txt. Упоминаний html в этой цепочке быть
    не должно: ingest-worker читает её напрямую и обрабатывает файл по расширению.
    """
    parsed = urlparse(doc.origin_url)
    stem = Path(parsed.path).stem or _sanitize_filename(doc.title)
    stem = _sanitize_filename(stem)
    return f"{stem}.txt"


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
        filename = _build_source_filename(doc)
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

        # Сырой HTML в хранилище не попадает. Страница очищается ДО загрузки, и в MinIO
        # уезжает только текстовая версия; library.document_files, из которой читает
        # ingest-worker, ссылается исключительно на .txt.
        #
        # Раньше клались оба файла, а в таблицу записывался .html — и в индекс уходила
        # разметка целиком, вместе с <script>, <head> и меню. На живом стенде это дало
        # 126 чанков с тегами из 662, а самые объёмные страницы валили embedding-svc по
        # размеру запроса. Хранить исходную разметку незачем: при изменении очистки страницу
        # всё равно нужно скачивать заново по origin_url, а checksum ниже показывает,
        # изменился ли источник.
        try:
            encoding_hint = (response_content_type or "utf-8").split("charset=")[-1].split(";")[0].strip() or "utf-8"
            markdown_text = clean_html_for_rag(body, encoding=encoding_hint)
        except Exception as exc:
            # Без очищенного текста документ не импортируется вовсе: класть вместо него
            # разметку нельзя, а пустую запись создавать бессмысленно.
            stats["txt_conversion_failed"] += 1
            results.append({
                "document_id": doc.id,
                "title": doc.title,
                "origin_url": doc.origin_url,
                "ok": False,
                "status": "html_cleanup_failed",
                "message": str(exc),
            })
            continue

        txt_bytes = markdown_text.encode("utf-8")
        txt_size_bytes = len(txt_bytes)
        txt_sha256 = hashlib.sha256(txt_bytes).hexdigest()

        try:
            with tempfile.SpooledTemporaryFile() as txt_tmp:
                txt_tmp.write(txt_bytes)
                txt_tmp.seek(0)
                client.upload_fileobj(
                    Fileobj=txt_tmp,
                    Bucket=bucket,
                    Key=storage_key,
                    ExtraArgs={"ContentType": "text/plain; charset=utf-8"},
                )
            stats["txt_converted"] += 1
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

        try:
            with get_conn() as conn:
                _upsert_document_file_manual(
                    conn,
                    document_id=doc.id,
                    bucket=bucket,
                    storage_key=storage_key,
                    storage_path=storage_path,
                    filename=filename,
                    mime_type="text/plain; charset=utf-8",
                    size_bytes=txt_size_bytes,
                    # Хеш описывает сохранённый файл. documents.checksum ниже — хеш исходной
                    # страницы: именно он показывает, изменился ли источник.
                    sha256=txt_sha256,
                )
                with conn.cursor() as cur:
                    cur.execute(
                        ATTACH_FILE_SQL,
                        (sha256, sha256, sha256, doc.id),
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


@dataclass
class _ImportItem:
    """Один файл к импорту: загруженный напрямую или член zip-архива."""

    filename: str                      # имя без каталогов, по нему берётся расширение и title
    path: str                          # путь для отчёта: «архив.zip:папка/файл.docx» либо имя файла
    archive: str | None                # имя архива, если файл из него
    document_id: str | None            # из manifest.json архива; None — манифеста нет
    open_file: Callable[[], BinaryIO]  # ленивое открытие: члены архива распаковываются по одному
    manifest_title: str | None = None  # полное название из манифеста (имя файла могло быть усечено)


def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    """Имя члена архива с исправленной кодировкой.

    Без флага UTF-8 (0x800) zipfile читает имя как cp437, и кириллица от Windows-архиваторов
    превращается в мусор. Возвращаем исходные байты и пробуем utf-8, затем cp866 (OEM-кодировка
    русской Windows).
    """
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    for encoding in ("utf-8", "cp866"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return name


def _read_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> BinaryIO:
    """Распаковывает член архива во временный файл, не давая ему превысить лимит.

    Размер в заголовке zip можно подделать (zip-бомба), поэтому лимит проверяется по
    фактически прочитанным байтам.
    """
    tmp = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    copied = 0
    try:
        with zf.open(info) as src:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > ZIP_MAX_MEMBER_BYTES:
                    raise ValueError(
                        f"файл в архиве больше {ZIP_MAX_MEMBER_BYTES // 1024 // 1024} МБ после распаковки"
                    )
                tmp.write(chunk)
    except Exception:
        tmp.close()
        raise
    tmp.seek(0)
    return tmp


def _load_manifest(zf: zipfile.ZipFile, members: list[tuple[zipfile.ZipInfo, str]]) -> dict[str, dict[str, str]]:
    """{имя файла: {"document_id", "title"}} из manifest.json архива (если он есть).

    Формат (schema_version 1): {"documents": [{"file": "...", "document_id": "...", ...}]}.
    Имя файла в манифесте — это то, под которым файл лежит в архиве, но у длинных названий оно
    усечено до лимита файловой системы; поэтому с базой файл сопоставляется не по имени, а по
    document_id и полному title из манифеста. document_id при этом может не найтись: при импорте
    датасета идентификаторы документов пересоздаются, и у выгрузки из другой базы они другие.
    """
    for info, name in members:
        if Path(name).name.lower() != ZIP_MANIFEST_NAME:
            continue
        if info.file_size > ZIP_MANIFEST_MAX_BYTES:
            raise ValueError("manifest.json слишком большой")
        data = json.loads(_read_member(zf, info).read().decode("utf-8-sig"))
        documents = data.get("documents") if isinstance(data, dict) else None
        if not isinstance(documents, list):
            raise ValueError("в manifest.json нет списка documents")
        return {
            Path(str(d["file"])).name: {"document_id": str(d.get("document_id") or ""), "title": str(d.get("title") or "")}
            for d in documents
            if isinstance(d, dict) and d.get("file")
        }
    return {}


def _expand_upload(upload: UploadFile, stats: dict[str, Any], results: list[dict[str, Any]], opened: list[Any]) -> list[_ImportItem]:
    """Превращает загруженный файл в список файлов к импорту: zip раскрывается, остальное как есть."""
    filename = upload.filename or ""
    if Path(filename).suffix.lower() != ARCHIVE_EXTENSION:
        return [_ImportItem(Path(filename).name, filename, None, None, lambda f=upload.file: f)]

    stats["archives"] += 1
    try:
        upload.file.seek(0)
        zf = zipfile.ZipFile(upload.file)
        opened.append(zf)
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > ZIP_MAX_MEMBERS:
            raise ValueError(f"в архиве {len(infos)} файлов, предел — {ZIP_MAX_MEMBERS}")
        total = sum(i.file_size for i in infos)
        if total > ZIP_MAX_TOTAL_BYTES:
            raise ValueError(
                f"архив распаковывается в {total // 1024 // 1024} МБ, предел — {ZIP_MAX_TOTAL_BYTES // 1024 // 1024} МБ"
            )
        members = [(i, _decode_zip_name(i)) for i in infos]
        manifest = _load_manifest(zf, members)
    except Exception as exc:
        stats["archive_failed"] += 1
        results.append({"filename": filename, "ok": False, "status": "archive_failed", "message": f"Не удалось прочитать архив: {exc}"})
        return []

    items: list[_ImportItem] = []
    for info, name in members:
        base = Path(name).name
        parts = Path(name).parts
        # Служебное: манифест, метаданные macOS, скрытые файлы. Не документы и не ошибка.
        if base.lower() == ZIP_MANIFEST_NAME or "__MACOSX" in parts or base.startswith(".") or base.lower() == "thumbs.db":
            continue
        if info.file_size > ZIP_MAX_MEMBER_BYTES:
            stats["skipped_too_large"] += 1
            results.append({
                "filename": base, "path": f"{filename}:{name}", "archive": filename, "ok": False,
                "status": "skipped_too_large",
                "message": f"Файл {info.file_size // 1024 // 1024} МБ, предел — {ZIP_MAX_MEMBER_BYTES // 1024 // 1024} МБ",
            })
            continue
        items.append(_ImportItem(
            filename=base,
            path=f"{filename}:{name}",
            archive=filename,
            document_id=(manifest.get(base) or {}).get("document_id") or None,
            manifest_title=(manifest.get(base) or {}).get("title") or None,
            open_file=lambda zf=zf, info=info: _read_member(zf, info),
        ))
    return items


def _content_type_compatible(expected: str | None, actual: str | None) -> bool:
    if not expected or expected == actual:
        return True
    # HTML-страницы хранятся очищенным текстом (source.txt), так что .txt для html-документа — норма.
    return expected == "html" and actual == "txt"


def import_files_to_minio(files: list[UploadFile], dry_run: bool = False, progress_cb=None, cancel_check=None) -> dict[str, Any]:
    """Загрузка файлов и zip-архивов в MinIO с привязкой к library.documents.

    Файл сопоставляется с документом по document_id из manifest.json архива, а без манифеста —
    по title (имя файла без расширения). Папки внутри архива значения не имеют.
    """
    docs_by_title, duplicates = _load_documents_map()
    docs_by_id = _load_documents_by_id()
    duplicate_set = set(duplicates)
    stats = {
        "total_files": 0,
        "success": 0,
        "unmatched": 0,
        "ambiguous_titles": len(duplicates),
        "type_mismatch": 0,
        "upload_failed": 0,
        "db_failed": 0,
        "skipped_unsupported": 0,
        "skipped_too_large": 0,
        "duplicate_in_batch": 0,
        "archives": 0,
        "archive_failed": 0,
        "dry_run": dry_run,
    }
    results: list[dict[str, Any]] = []
    opened_archives: list[Any] = []

    try:
        items: list[_ImportItem] = []
        for upload in files:
            items.extend(_expand_upload(upload, stats, results, opened_archives))

        client = None
        bucket = os.getenv("MINIO_BUCKET", "documents")
        if not dry_run:
            client = _s3_client()
            bucket = _ensure_bucket(client)

        seen_documents: set[str] = set()
        total = max(len(items), 1)
        for idx, item in enumerate(items, 1):
            if progress_cb is not None:
                progress_cb(idx - 1, total, "upload", f"Processing {idx}/{total}")
            if cancel_check is not None and cancel_check():
                raise RuntimeError("Job cancelled")
            filename = item.filename
            ext = Path(filename).suffix.lower()
            stats["total_files"] += 1
            base_info = {"filename": filename, "path": item.path}
            if item.archive:
                base_info["archive"] = item.archive

            if ext not in ALLOWED_EXTENSIONS:
                stats["skipped_unsupported"] += 1
                results.append({**base_info, "ok": False, "status": "skipped_unsupported",
                                "message": f"Расширение {ext or '<empty>'} не поддерживается"})
                continue

            file_title = _normalize_title(Path(filename).stem)
            # Порядок сопоставления: document_id из манифеста, затем полный title из манифеста,
            # затем имя файла. Имя файла последним: у длинных названий оно усечено.
            doc = None
            matched_by = None
            title = file_title
            if item.document_id:
                doc = docs_by_id.get(item.document_id)
                matched_by = "manifest_id" if doc else None
            candidates = []
            if doc is None and item.manifest_title:
                candidates.append(("manifest_title", _normalize_title(item.manifest_title)))
            if doc is None:
                candidates.append(("title", file_title))
            ambiguous = None
            for kind, candidate in candidates:
                if candidate in duplicate_set:
                    ambiguous = ambiguous or candidate
                    continue
                found = docs_by_title.get(candidate)
                if found:
                    doc, matched_by, title = found, kind, candidate
                    break
            if doc is None and ambiguous:
                stats["unmatched"] += 1
                results.append({**base_info, "ok": False, "status": "ambiguous_title", "title": ambiguous,
                                "message": "В library.documents несколько документов с таким title: исправьте дубли"})
                continue
            if doc is None:
                stats["unmatched"] += 1
                tried = ", ".join(
                    part for part in (
                        f"document_id {item.document_id}" if item.document_id else "",
                        f"title из манифеста «{item.manifest_title}»" if item.manifest_title else "",
                        f"имя файла «{file_title}»",
                    ) if part
                )
                results.append({**base_info, "ok": False, "status": "unmatched", "title": title,
                                "document_id": item.document_id,
                                "message": f"В library.documents нет документа: искали по {tried}"})
                continue

            doc_id = str(doc["id"])
            if doc_id in seen_documents:
                stats["duplicate_in_batch"] += 1
                results.append({**base_info, "ok": False, "status": "duplicate_in_batch", "document_id": doc_id,
                                "title": doc["title"], "message": "Для этого документа в загрузке уже есть другой файл"})
                continue

            actual_content_type = CONTENT_TYPE_BY_EXT.get(ext)
            # Совпадение по document_id надёжно, тип не перепроверяем; по названию — проверяем.
            if matched_by != "manifest_id" and not _content_type_compatible(doc["content_type"], actual_content_type):
                stats["type_mismatch"] += 1
                results.append({**base_info, "ok": False, "status": "type_mismatch", "document_id": doc_id,
                                "title": title, "expected_content_type": doc["content_type"],
                                "actual_content_type": actual_content_type})
                continue

            file_obj = None
            try:
                try:
                    file_obj = item.open_file()
                except Exception as exc:
                    stats["archive_failed"] += 1
                    results.append({**base_info, "ok": False, "status": "archive_failed", "document_id": doc_id,
                                    "message": f"Не удалось распаковать файл: {exc}"})
                    continue

                sha256, size_bytes = _calc_sha256_and_size(file_obj)
                mime_type = _guess_mime(filename)
                storage_key = _build_storage_key(doc_id, int(doc["content_version"]), filename)
                storage_path = f"{bucket}/{storage_key}"
                done = {**base_info, "document_id": doc_id, "title": doc["title"], "matched_by": matched_by,
                        "bucket": bucket, "storage_key": storage_key, "checksum": sha256, "size_bytes": size_bytes}

                if dry_run:
                    seen_documents.add(doc_id)
                    stats["success"] += 1
                    results.append({**done, "ok": True, "status": "dry_run"})
                    continue

                try:
                    file_obj.seek(0)
                    client.upload_fileobj(
                        Fileobj=file_obj,
                        Bucket=bucket,
                        Key=storage_key,
                        ExtraArgs={"ContentType": mime_type},
                    )
                except (ClientError, BotoCoreError, Exception) as exc:
                    stats["upload_failed"] += 1
                    results.append({**base_info, "ok": False, "status": "upload_failed", "document_id": doc_id,
                                    "title": doc["title"], "message": str(exc)})
                    continue

                try:
                    with get_conn() as conn:
                        _upsert_document_file_manual(
                            conn,
                            document_id=doc_id,
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
                                ATTACH_FILE_SQL,
                                (sha256, sha256, sha256, doc_id),
                            )
                        conn.commit()
                except Exception as exc:
                    stats["db_failed"] += 1
                    results.append({**base_info, "ok": False, "status": "db_failed", "document_id": doc_id,
                                    "title": doc["title"], "message": str(exc)})
                    continue

                seen_documents.add(doc_id)
                stats["success"] += 1
                results.append({**done, "ok": True, "status": "imported"})
            finally:
                if file_obj is not None:
                    try:
                        file_obj.close()
                    except Exception:
                        pass
    finally:
        for resource in opened_archives:
            try:
                resource.close()
            except Exception:
                pass
        for upload in files:
            try:
                upload.file.close()
            except Exception:
                pass

    failures = (
        stats["db_failed"] + stats["upload_failed"] + stats["type_mismatch"] + stats["unmatched"]
        + stats["archive_failed"] + stats["skipped_too_large"] + stats["duplicate_in_batch"]
    )
    return {
        "ok": failures == 0,
        "message": "Импорт в MinIO завершён",
        "stats": stats,
        "duplicate_titles": duplicates,
        "results": results,
    }
