"""`/api/export/*` — выгрузка графа и чанков архивом.

Отдельный префикс, а не `/api/graph/export`: там висит сквозной прокси `{path:path}` в
graph-rag-svc, и любой локальный путь под ним ушёл бы в чужой сервис.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.services.export import build_archive

logger = logging.getLogger(__name__)

router = APIRouter()


def _stream(kind: str, with_embeddings: bool) -> StreamingResponse:
    try:
        buffer, manifest = build_archive(kind, with_embeddings=with_embeddings)
    except Exception as exc:
        logger.exception("Выгрузка %s не удалась", kind)
        raise HTTPException(status_code=500, detail=f"не удалось собрать архив: {exc}") from exc

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"pochemuchnik-{kind}-{stamp}.zip"

    def _iter():
        # Файл держится открытым до конца отдачи; SpooledTemporaryFile закрывается сам
        # и удаляет временный файл с диска, если до него дошло.
        try:
            while True:
                block = buffer.read(64 * 1024)
                if not block:
                    break
                yield block
        finally:
            buffer.close()

    total = sum(manifest.get("tables", {}).values())
    logger.info("Выгрузка %s: строк всего %d", kind, total)

    return StreamingResponse(
        _iter(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Число строк в заголовке — чтобы интерфейс мог показать объём выгрузки,
            # не разбирая архив.
            "X-Export-Rows": str(total),
        },
    )


@router.get("/graph")
def export_graph() -> StreamingResponse:
    """Все таблицы схемы `graph` одним архивом (JSONL + manifest.json)."""
    return _stream("graph", with_embeddings=True)


@router.get("/chunks")
def export_chunks(
    embeddings: bool = Query(True, description="включать ли library.chunk_embeddings"),
) -> StreamingResponse:
    """Документы и чанки; эмбеддинги — по флагу, они занимают основной объём."""
    return _stream("chunks", with_embeddings=embeddings)
