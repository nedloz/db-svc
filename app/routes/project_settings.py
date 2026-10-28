"""Страница «Настройки проекта» (только чтение): активный LLM, эмбеддинги, GraphRAG.

Показывается то, что записано в файле, а не живое состояние прокси. Границы: (1) страница
не видит копию «последней корректной» конфигурации в памяти llm-proxy: если файл стал
некорректным, прокси продолжает работать по прежней, а страница покажет unknown; (2) ключ
ROUTER_KEY ей недоступен, поэтому режим router без ключа (прокси отвечает 503) всё равно
отображается как router; (3) доступность upstream не проверяется.

Режим и модель LLM берутся из того же config.json, который llm-proxy перечитывает на каждом
запросе (том llm_proxy_config, в db-svc он смонтирован только на чтение), поэтому страница
показывает настройки из файла, а не копию из переменных окружения. Ключей и адресов
(url) в ответ не попадает ничего.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from fastapi import APIRouter

logger = logging.getLogger("db-svc.project-settings")

router = APIRouter()

LLM_CONFIG_PATH = "/etc/llm-proxy/config.json"
MODES = ("router", "ollama")
# Адрес раздела: схема http(s):// и непустой хост без пробелов; зеркало проверки в infra/llm-proxy/llm.js.
URL_RE = re.compile(r"^https?://[^/\s]+")
UNKNOWN = {"mode": "unknown", "model": None}

DEFAULT_EMBEDDER_MODEL = "intfloat/multilingual-e5-base"
DEFAULT_EMBEDDING_DIM = 768


def validate_llm_config(cfg: Any) -> str | None:
    """Проверка формы config.json так же, как infra/llm-proxy/llm.js. None — файл годен.

    Вынесена отдельно, чтобы будущая запись настроек из админки пользовалась теми же правилами.
    """
    if not isinstance(cfg, dict):
        return "корень не объект"
    if cfg.get("mode") not in MODES:
        return 'mode должен быть "router" или "ollama"'
    for name in MODES:
        section = cfg.get(name)
        if not isinstance(section, dict) or not isinstance(section.get("url"), str) \
                or not isinstance(section.get("model"), str):
            return f"нужен раздел {name} со строками url и model"
    active = cfg[cfg["mode"]]
    if not URL_RE.match(active["url"]):
        return f"{cfg['mode']}.url должен начинаться с http:// или https://"
    if not active["model"]:
        return f"{cfg['mode']}.model пуст"
    return None


def read_llm_config(path: str = LLM_CONFIG_PATH) -> dict:
    """{"mode", "model"} действующего режима; при отсутствии или порче файла — unknown.

    В лог пишется только причина, содержимое файла не логируется.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        logger.warning("config.json llm-proxy не найден: %s", path)
        return dict(UNKNOWN)
    except (OSError, ValueError) as exc:
        logger.warning("config.json llm-proxy не прочитан: %s", type(exc).__name__)
        return dict(UNKNOWN)
    problem = validate_llm_config(cfg)
    if problem:
        logger.warning("config.json llm-proxy некорректен: %s", problem)
        return dict(UNKNOWN)
    return {"mode": cfg["mode"], "model": cfg[cfg["mode"]]["model"]}


def _embedding_dim() -> int:
    raw = os.getenv("EMBEDDING_DIM", "")
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_EMBEDDING_DIM
    return value if value > 0 else DEFAULT_EMBEDDING_DIM


@router.get("/settings/project")
async def project_settings() -> dict[str, Any]:
    return {
        "llm": read_llm_config(LLM_CONFIG_PATH),
        "embeddings": {
            "model": os.getenv("EMBEDDER_MODEL_NAME") or DEFAULT_EMBEDDER_MODEL,
            "dimension": _embedding_dim(),
        },
        "graphrag": {"enabled": False},
        "pipeline": "notebook-v1",
    }
