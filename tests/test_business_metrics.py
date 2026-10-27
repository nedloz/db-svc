"""Метрики db-svc: журнал действий и размер корпуса. База не нужна: соединение подменяется."""

import os
import sys
from contextlib import contextmanager
from pathlib import Path

os.environ.setdefault("DBSVC_ADMIN_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from prometheus_client import REGISTRY  # noqa: E402

from app.services import audit, corpus_stats  # noqa: E402


def sample(name: str, **labels) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class Cursor:
    def __init__(self, rows=None, fail=False):
        self.rows = rows or []
        self.fail = fail

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, *_args):
        if self.fail:
            raise RuntimeError("db down")

    def fetchall(self):
        return self.rows


class Conn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass


def fake_get_conn(cursor):
    @contextmanager
    def get_conn():
        yield Conn(cursor)

    return get_conn


def test_successful_row_action_is_counted(monkeypatch):
    monkeypatch.setattr(audit, "get_conn", fake_get_conn(Cursor()))
    before = sample("pochemuchnik_admin_actions_total", action="row.insert", result="success")
    audit.record_standalone("row.insert", schema="library", table="documents")
    assert sample("pochemuchnik_admin_actions_total", action="row.insert", result="success") == before + 1


def test_import_is_counted_as_action_and_as_import(monkeypatch):
    monkeypatch.setattr(audit, "get_conn", fake_get_conn(Cursor()))
    imports = sample("pochemuchnik_imports_total", kind="dataset", result="success")
    audit.record_standalone("import.dataset")
    assert sample("pochemuchnik_imports_total", kind="dataset", result="success") == imports + 1


def test_failed_import_attempt_is_counted_as_failure(monkeypatch):
    monkeypatch.setattr(audit, "get_conn", fake_get_conn(Cursor()))
    imports = sample("pochemuchnik_imports_total", kind="csv", result="failure")
    audit.record_failure("import.csv", error="битый файл")
    assert sample("pochemuchnik_imports_total", kind="csv", result="failure") == imports + 1


def test_action_that_could_not_be_journaled_is_not_counted(monkeypatch):
    monkeypatch.setattr(audit, "get_conn", fake_get_conn(Cursor(fail=True)))
    before = sample("pochemuchnik_admin_actions_total", action="row.delete", result="success")
    with pytest.raises(HTTPException):
        audit.record_standalone("row.delete")
    assert sample("pochemuchnik_admin_actions_total", action="row.delete", result="success") == before


def test_corpus_counts_are_published_by_kind(monkeypatch):
    rows = [("documents", 12), ("chunks", 340), ("graph_nodes", 55), ("graph_edges", 80)]
    monkeypatch.setattr(corpus_stats, "get_conn", fake_get_conn(Cursor(rows)))
    corpus_stats.refresh_corpus_counts()
    assert sample("pochemuchnik_corpus_objects", kind="chunks") == 340
    assert sample("pochemuchnik_corpus_objects", kind="graph_edges") == 80
