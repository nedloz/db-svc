"""Страница «Настройки проекта»: GET /api/db/settings/project читает config.json llm-proxy.

БД не нужна: приложение создаётся без lifespan, путь к config.json подменяется на временный.

    python -m pytest tests/test_project_settings.py -q
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

os.environ.setdefault("DBSVC_ADMIN_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer " + os.environ["DBSVC_ADMIN_TOKEN"]}
URL = "/api/db/settings/project"
SECRET = "sk-router-secret-123"


def cfg(mode="router", router_model="qwen/qwen3.5-9b", ollama_model="llama3"):
    return {
        "mode": mode,
        "router": {"url": "https://api.polza.ai/v1", "model": router_model},
        "ollama": {"url": "https://ollama:8443/v1", "model": ollama_model},
    }


def write(path: Path, data) -> None:
    """Атомарная запись, как будет делать админка: tmp + rename."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


@pytest.fixture()
def api(monkeypatch, tmp_path):
    from app.main import app
    from app.routes import project_settings as ps

    path = tmp_path / "config.json"
    monkeypatch.setattr(ps, "LLM_CONFIG_PATH", str(path))
    monkeypatch.setenv("ROUTER_KEY", SECRET)
    monkeypatch.delenv("EMBEDDER_MODEL_NAME", raising=False)
    monkeypatch.delenv("EMBEDDING_DIM", raising=False)
    c = TestClient(app)
    c.cfg_path = path
    return c


def get(api):
    return api.get(URL, headers=AUTH)


def test_router_mode_shows_router_model(api):
    write(api.cfg_path, cfg("router"))
    r = get(api)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "llm": {"mode": "router", "model": "qwen/qwen3.5-9b"},
        "embeddings": {"model": "intfloat/multilingual-e5-base", "dimension": 768},
        "graphrag": {"enabled": False},
        "pipeline": "notebook-v1",
    }


def test_ollama_mode_shows_ollama_model(api):
    write(api.cfg_path, cfg("ollama"))
    assert get(api).json()["llm"] == {"mode": "ollama", "model": "llama3"}


def test_config_rewrite_is_picked_up_without_restart(api):
    write(api.cfg_path, cfg("router"))
    assert get(api).json()["llm"]["mode"] == "router"
    write(api.cfg_path, cfg("ollama", ollama_model="mistral"))
    assert get(api).json()["llm"] == {"mode": "ollama", "model": "mistral"}


@pytest.mark.parametrize("content", [
    None,                                                        # файла нет
    "{не json",                                                  # битый
    "[]",                                                        # не объект
    cfg("cloud"),                                                # неизвестный режим
    {"mode": "router"},                                          # нет разделов
    {"mode": "router", "router": {"url": "https://x"}, "ollama": {"url": "https://y", "model": "m"}},
    {"mode": "router", "router": {"url": "ftp://x", "model": "m"}, "ollama": {"url": "https://y", "model": "m"}},
    cfg("ollama", ollama_model=""),                              # пустая модель активного режима
])
def test_missing_or_invalid_config_is_unknown(api, content):
    if content is not None:
        write(api.cfg_path, content)
    r = get(api)
    assert r.status_code == 200
    assert r.json()["llm"] == {"mode": "unknown", "model": None}


def test_invalid_config_logs_warning_without_contents(api, caplog):
    write(api.cfg_path, '{"mode": "cloud", "secret": "TOPSECRET"}')
    with caplog.at_level(logging.WARNING):
        get(api)
    assert any(rec.levelno == logging.WARNING for rec in caplog.records)
    assert "TOPSECRET" not in caplog.text


def test_response_has_no_urls_or_keys(api):
    write(api.cfg_path, cfg("router"))
    body = get(api).text
    low = body.lower()
    assert "url" not in low and "http" not in low
    assert SECRET not in body and "ROUTER_KEY" not in body


def test_embeddings_from_env(api, monkeypatch):
    monkeypatch.setenv("EMBEDDER_MODEL_NAME", "BAAI/bge-m3")
    monkeypatch.setenv("EMBEDDING_DIM", "1024")
    assert get(api).json()["embeddings"] == {"model": "BAAI/bge-m3", "dimension": 1024}


@pytest.mark.parametrize("raw", ["", "abc", "12.5", "0", "-3"])
def test_garbled_embedding_dim_falls_back(api, monkeypatch, raw):
    monkeypatch.setenv("EMBEDDING_DIM", raw)
    r = get(api)
    assert r.status_code == 200
    assert r.json()["embeddings"]["dimension"] == 768


def test_requires_auth(api):
    assert api.get(URL).status_code in (401, 403)


def test_fixed_path_not_swallowed_by_generic_route(api):
    # /{schema}/{table} отдал бы 4xx/5xx про неизвестную схему «settings».
    write(api.cfg_path, cfg("router"))
    assert "pipeline" in get(api).json()


def test_read_llm_config_function(tmp_path):
    from app.routes.project_settings import read_llm_config

    p = tmp_path / "c.json"
    assert read_llm_config(str(p)) == {"mode": "unknown", "model": None}
    write(p, cfg("ollama", ollama_model="m1"))
    assert read_llm_config(str(p)) == {"mode": "ollama", "model": "m1"}


def _with_url(url, mode="router"):
    c = cfg(mode)
    c[mode]["url"] = url
    return c


@pytest.mark.parametrize("url", ["https://", "http:// x", "http://", "ftp://host", "", 42, None])
def test_bad_active_url_is_unknown(tmp_path, url):
    from app.routes.project_settings import read_llm_config

    p = tmp_path / "c.json"
    write(p, _with_url(url))
    assert read_llm_config(str(p)) == {"mode": "unknown", "model": None}


@pytest.mark.parametrize("url,mode", [
    ("https://api.example.com/v1", "router"),
    ("http://ollama:11434/v1", "ollama"),
])
def test_good_active_url_is_accepted(tmp_path, url, mode):
    from app.routes.project_settings import read_llm_config

    p = tmp_path / "c.json"
    write(p, _with_url(url, mode))
    assert read_llm_config(str(p))["mode"] == mode
