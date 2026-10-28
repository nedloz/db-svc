"""Импорт быстрых ответов (xlsx) и ссылок (txt): парсеры, синхронизация с БД, эндпоинты.

БД не нужна: upsert проверяется на памяти-подделке сессии, эндпоинты — с подменой соединения.
Один дымовой тест читает настоящие файлы и пропускается, если их нет на месте.

    python -m pytest tests/test_quick_answers_import.py -q
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

os.environ.setdefault("DBSVC_ADMIN_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import Workbook  # noqa: E402

from app.services import quick_answers_import as qi  # noqa: E402

HEADERS = ["Основной вопрос", "Ответ на русском", "Варианты вопроса на русском"]
AUTH = {"Authorization": "Bearer " + os.environ["DBSVC_ADMIN_TOKEN"]}


def make_xlsx(rows, headers=HEADERS, sheet="Ответы") -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------- нормализация ----------

def test_normalize_follows_notebook_rule():
    assert qi.normalize("  Как, ПОЛУЧИТЬ справку?! ") == "как получить справку"
    assert qi.normalize("???") == ""


def test_normalize_drops_yo_exactly_like_notebook():
    # [а-яА-Я] не включает Ё/ё, поэтому буква вырезается — правило ноутбука воспроизведено как есть.
    assert qi.normalize("Ёлка и ещё") == "лка и ещ"


# ---------- парсер xlsx ----------

def test_parse_xlsx_real_structure():
    data = make_xlsx([
        ["Как получить справку?", "В личном кабинете.",
         "где взять справку\nсправка об обучении; Как получить справку!"],
        [None, None, None],
        ["Где общежитие?", "На Таллинской.", None],
    ])
    rows = qi.parse_quick_answers_xlsx(data)
    assert [r["question"] for r in rows] == ["Как получить справку?", "Где общежитие?"]
    assert rows[0]["answer"] == "В личном кабинете."
    # основной вопрос идёт первым, дубль после нормализации схлопнут
    assert rows[0]["variants"] == ["как получить справку", "где взять справку", "справка об обучении"]
    assert rows[1]["variants"] == ["где общежитие"]


def test_parse_xlsx_finds_columns_by_header_not_position():
    data = make_xlsx([["Ответ", "Вопрос"]], headers=["Ответ на русском", "Основной вопрос"])
    rows = qi.parse_quick_answers_xlsx(data)
    assert rows == [{"question": "Вопрос", "answer": "Ответ", "variants": ["вопрос"]}]


def test_parse_xlsx_missing_header_is_error():
    with pytest.raises(qi.ImportFileError):
        qi.parse_quick_answers_xlsx(make_xlsx([["a", "b"]], headers=["Вопрос", "Ответ"]))


def test_parse_xlsx_garbage_is_error():
    with pytest.raises(qi.ImportFileError):
        qi.parse_quick_answers_xlsx(b"not an xlsx")


# ---------- парсер ссылок ----------

def test_parse_links_keeps_http_skips_no_url_strips_dot():
    text = (
        "Общежития, проживание. http://www.hse.ru/dormitory/\n"
        "Строка без ссылки.\n"
        "\n"
        "Справки  .  https://www.hse.ru/spravki \n"
    )
    assert qi.parse_links_txt(text) == [
        {"description": "Общежития, проживание", "url": "http://www.hse.ru/dormitory/"},
        {"description": "Справки", "url": "https://www.hse.ru/spravki"},
    ]


def test_parse_links_url_with_second_scheme_in_query_kept_whole():
    rows = qi.parse_links_txt("Редирект. https://a.ru/?u=https://b.ru")
    assert rows[0]["url"] == "https://a.ru/?u=https://b.ru"


# ---------- подделка сессии ----------

class FakeCursor:
    def __init__(self, rows=None):
        self._rows = rows or []

    async def fetchall(self):
        return self._rows

    async def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeSession:
    """Память вместо library.*: понимает ровно те запросы, что выпускает импортёр."""

    def __init__(self):
        self.qa = {}        # id -> {question, answer, updated}
        self.variants = {}  # (qa_id, text) -> {"embedding": ...}
        self.links = {}     # url -> {description, embedding}
        self.n = 0
        self.log = []

    def _id(self):
        self.n += 1
        return f"id{self.n}"

    async def execute(self, sql, params=()):
        self.log.append((sql, params))
        if sql is qi.SQL_QA_SELECT:
            (qs,) = params
            return FakeCursor([(i, r["question"], r["answer"]) for i, r in self.qa.items() if r["question"] in qs])
        if sql is qi.SQL_VARIANT_SELECT:
            (ids,) = params
            return FakeCursor([(k[0], k[1]) for k in self.variants if k[0] in ids])
        if sql is qi.SQL_QA_INSERT:
            question, answer = params
            i = self._id()
            self.qa[i] = {"question": question, "answer": answer, "updated": 0}
            return FakeCursor([(i,)])
        if sql is qi.SQL_QA_UPDATE_ANSWER:
            answer, i = params
            self.qa[i]["answer"] = answer
            self.qa[i]["updated"] += 1
            return FakeCursor()
        if sql is qi.SQL_QA_TOUCH:
            (i,) = params
            self.qa[i]["updated"] += 1
            return FakeCursor()
        if sql is qi.SQL_VARIANT_RESET:
            (i,) = params
            for k, v in self.variants.items():
                if k[0] == i:
                    v["embedding"] = None
            return FakeCursor()
        if sql is qi.SQL_VARIANT_INSERT:
            i, text = params
            self.variants[(i, text)] = {"embedding": None}
            return FakeCursor()
        if sql is qi.SQL_VARIANT_DELETE:
            i, texts = params
            for t in texts:
                self.variants.pop((i, t), None)
            return FakeCursor()
        if sql is qi.SQL_LINK_SELECT:
            (urls,) = params
            return FakeCursor([(u, r["description"]) for u, r in self.links.items() if u in urls])
        if sql is qi.SQL_LINK_INSERT:
            desc, url = params
            self.links[url] = {"description": desc, "embedding": None}
            return FakeCursor()
        if sql is qi.SQL_LINK_UPDATE:
            desc, url = params
            self.links[url].update(description=desc, embedding=None)
            return FakeCursor()
        raise AssertionError(f"неожиданный запрос: {sql}")

    def embed_all(self):
        for v in self.variants.values():
            v["embedding"] = [0.1]
        for l in self.links.values():
            l["embedding"] = [0.1]

    def variants_of(self, question):
        i = next(i for i, r in self.qa.items() if r["question"] == question)
        return {k[1] for k in self.variants if k[0] == i}


def run(coro):
    return asyncio.run(coro)


ROWS = [
    {"question": "Как получить справку?", "answer": "В ЛК.", "variants": ["как получить справку", "где справка"]},
    {"question": "Где общежитие?", "answer": "Таллинская.", "variants": ["где общежитие"]},
]


# ---------- синхронизация быстрых ответов ----------

def test_first_import_creates_questions_and_variants():
    s = FakeSession()
    res = run(qi.import_quick_answers(s, ROWS))
    assert res == {"created": 2, "updated": 0, "skipped": 0}
    assert s.variants_of("Как получить справку?") == {"как получить справку", "где справка"}


def test_reimport_same_file_is_noop():
    s = FakeSession()
    run(qi.import_quick_answers(s, ROWS))
    s.embed_all()
    res = run(qi.import_quick_answers(s, ROWS))
    assert res == {"created": 0, "updated": 0, "skipped": 0}
    assert all(v["embedding"] is not None for v in s.variants.values())
    assert all(r["updated"] == 0 for r in s.qa.values())


def test_sync_adds_new_deletes_missing_keeps_existing_embeddings():
    s = FakeSession()
    run(qi.import_quick_answers(s, ROWS))
    s.embed_all()
    changed = [dict(ROWS[0], variants=["как получить справку", "справка новая"]), ROWS[1]]
    res = run(qi.import_quick_answers(s, changed))
    assert res == {"created": 0, "updated": 1, "skipped": 0}
    assert s.variants_of("Как получить справку?") == {"как получить справку", "справка новая"}
    i = next(i for i, r in s.qa.items() if r["question"] == "Как получить справку?")
    assert s.variants[(i, "как получить справку")]["embedding"] == [0.1]  # сохранён
    assert s.variants[(i, "справка новая")]["embedding"] is None
    assert s.qa[i]["updated"] == 1


def test_questions_absent_from_file_are_untouched():
    s = FakeSession()
    run(qi.import_quick_answers(s, ROWS))
    res = run(qi.import_quick_answers(s, [ROWS[0]]))
    assert res == {"created": 0, "updated": 0, "skipped": 0}
    assert s.variants_of("Где общежитие?") == {"где общежитие"}


def test_answer_change_resets_all_variant_embeddings():
    s = FakeSession()
    run(qi.import_quick_answers(s, ROWS))
    s.embed_all()
    res = run(qi.import_quick_answers(s, [dict(ROWS[0], answer="Новый ответ"), ROWS[1]]))
    assert res == {"created": 0, "updated": 1, "skipped": 0}
    i = next(i for i, r in s.qa.items() if r["question"] == "Как получить справку?")
    assert s.qa[i]["answer"] == "Новый ответ"
    assert all(v["embedding"] is None for k, v in s.variants.items() if k[0] == i)
    other = next(i for i, r in s.qa.items() if r["question"] == "Где общежитие?")
    assert all(v["embedding"] is not None for k, v in s.variants.items() if k[0] == other)


def test_invalid_rows_skipped_and_counted():
    s = FakeSession()
    rows = [
        {"question": "", "answer": "x", "variants": []},
        {"question": "Без ответа", "answer": "  ", "variants": ["без ответа"]},
        {"question": "???", "answer": "x", "variants": []},
        ROWS[1],
        ROWS[1],  # повтор вопроса внутри файла
    ]
    res = run(qi.import_quick_answers(s, rows))
    assert res == {"created": 1, "updated": 0, "skipped": 4}


def test_importer_normalizes_variants_itself():
    s = FakeSession()
    run(qi.import_quick_answers(s, [{"question": "Q?", "answer": "a", "variants": ["  Где, СПРАВКА?! ", "где справка", "!!!"]}]))
    assert s.variants_of("Q?") == {"где справка", "q"}


# ---------- ссылки ----------

LINKS = [
    {"description": "Общежития", "url": "http://www.hse.ru/dormitory/"},
    {"description": "Справки", "url": "https://www.hse.ru/spravki"},
]


def test_links_create_then_idempotent():
    s = FakeSession()
    assert run(qi.import_links(s, LINKS)) == {"created": 2, "updated": 0, "skipped": 0}
    s.embed_all()
    assert run(qi.import_links(s, LINKS)) == {"created": 0, "updated": 0, "skipped": 0}
    assert all(l["embedding"] is not None for l in s.links.values())


def test_links_changed_description_resets_embedding_stale_untouched():
    s = FakeSession()
    run(qi.import_links(s, LINKS))
    s.embed_all()
    res = run(qi.import_links(s, [dict(LINKS[0], description="Новое описание")]))
    assert res == {"created": 0, "updated": 1, "skipped": 0}
    assert s.links[LINKS[0]["url"]]["embedding"] is None
    assert s.links[LINKS[1]["url"]]["embedding"] == [0.1]


def test_links_invalid_skipped():
    s = FakeSession()
    rows = [{"description": "", "url": "https://a.ru"}, {"description": "d", "url": ""}, LINKS[0], LINKS[0]]
    assert run(qi.import_links(s, rows)) == {"created": 1, "updated": 0, "skipped": 3}


# ---------- эндпоинты ----------

@pytest.fixture()
def api(monkeypatch):
    from app.main import app
    from app.routes import db as db_routes

    session = FakeSession()
    audited = []

    @asynccontextmanager
    async def fake_open():
        yield session

    monkeypatch.setattr(db_routes, "open_import_session", fake_open)
    monkeypatch.setattr(db_routes.audit, "record_standalone", lambda action, **kw: audited.append((action, kw)))
    monkeypatch.setattr(db_routes.audit, "record_failure", lambda action, **kw: audited.append((action, kw)))
    c = TestClient(app)
    c.session, c.audited = session, audited
    return c


def test_quick_answers_endpoint_not_swallowed_by_generic_route(api):
    data = make_xlsx([["Q1?", "A1", "вариант один"]])
    r = api.post(
        "/api/db/library/quick-answers/import", headers=AUTH,
        files={"file": ("a.xlsx", data, "application/octet-stream")},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 1, "updated": 0, "skipped": 0}
    assert api.audited[0][0] == "import.quick_answers"
    assert api.session.variants_of("Q1?") == {"q1", "вариант один"}


def test_parse_and_audit_run_off_event_loop(api, monkeypatch):
    """Разбор xlsx (CPU) и синхронный журнал не должны выполняться в потоке цикла событий."""
    import threading
    from app.routes import db as db_routes

    threads = {}
    loop_thread = []

    real_parse = db_routes.parse_quick_answers_xlsx

    def parse(data):
        threads["parse"] = threading.get_ident()
        return real_parse(data)

    def audit_rec(action, **kw):
        threads["audit"] = threading.get_ident()

    real_open = db_routes.open_import_session

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def open_session():
        loop_thread.append(threading.get_ident())
        async with real_open() as s:
            yield s

    monkeypatch.setattr(db_routes, "parse_quick_answers_xlsx", parse)
    monkeypatch.setattr(db_routes.audit, "record_standalone", audit_rec)
    monkeypatch.setattr(db_routes, "open_import_session", open_session)
    # real_open здесь уже подменён фикстурой api на фейковую сессию
    r = api.post(
        "/api/db/library/quick-answers/import", headers=AUTH,
        files={"file": ("a.xlsx", make_xlsx([["Q1?", "A1", "в"]]), "application/octet-stream")},
    )
    assert r.status_code == 200, r.text
    assert threads["parse"] != loop_thread[0]
    assert threads["audit"] != loop_thread[0]


def test_links_endpoint(api):
    r = api.post(
        "/api/db/library/links/import", headers=AUTH,
        files={"file": ("l.txt", "Описание. http://x.ru/a\nмусор".encode(), "text/plain")},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 1, "updated": 0, "skipped": 0}
    assert "http://x.ru/a" in api.session.links


def test_generic_routes_still_registered_after_fixed_ones():
    from app.routes.db import router
    paths = [getattr(r, "path", "") for r in router.routes]
    generic = paths.index("/{schema}/{table}")
    assert paths.index("/library/quick-answers/import") < generic
    assert paths.index("/library/links/import") < generic


@pytest.mark.parametrize("url,name,payload", [
    ("/api/db/library/quick-answers/import", "a.csv", b"x"),
    ("/api/db/library/quick-answers/import", "a.xlsx", b""),
    ("/api/db/library/quick-answers/import", "a.xlsx", b"not xlsx"),
    ("/api/db/library/links/import", "a.xlsx", b"x"),
    ("/api/db/library/links/import", "a.txt", b""),
    ("/api/db/library/links/import", "a.txt", b"\xff\xfe\x00bad"),
])
def test_upload_validation_gives_4xx(api, url, name, payload):
    r = api.post(url, headers=AUTH, files={"file": (name, payload, "application/octet-stream")})
    assert r.status_code in (400, 415, 422), r.text
    assert not api.session.qa and not api.session.links


def test_upload_size_limit(api, monkeypatch):
    from app.routes import db as db_routes
    monkeypatch.setattr(db_routes, "IMPORT_MAX_BYTES", 10)
    r = api.post("/api/db/library/links/import", headers=AUTH,
                 files={"file": ("l.txt", b"x" * 11, "text/plain")})
    assert r.status_code == 413


def test_import_requires_auth(api):
    r = api.post("/api/db/library/links/import", files={"file": ("l.txt", b"a. http://x", "text/plain")})
    assert r.status_code in (401, 403)


def test_graph_router_not_mounted(api):
    assert api.get("/api/graph/stats", headers=AUTH).status_code == 404


# ---------- настоящие файлы ----------

XLSX = Path("/home/nedloz/dev/pochemuchnik/HSE_Answers_RU.xlsx")
ZIP = Path("/home/nedloz/dev/pochemuchnik/MIEM_HSE_knowledge_base.zip")


@pytest.mark.skipif(not XLSX.exists(), reason="нет настоящего xlsx")
def test_real_xlsx_smoke():
    rows = qi.parse_quick_answers_xlsx(XLSX.read_bytes())
    assert len(rows) == 122
    assert all(r["question"] and r["answer"] and r["variants"] for r in rows)
    s = FakeSession()
    assert run(qi.import_quick_answers(s, rows))["created"] == 122
    assert run(qi.import_quick_answers(s, rows)) == {"created": 0, "updated": 0, "skipped": 0}


@pytest.mark.skipif(not ZIP.exists(), reason="нет архива с all_links.txt")
def test_real_links_smoke():
    with zipfile.ZipFile(ZIP) as z:
        text = z.read("MIEM_HSE_knowledge_base/documents/all_links.txt").decode("utf-8")
    rows = qi.parse_links_txt(text)
    assert len(rows) >= 90
    assert any(r["url"] == "http://www.hse.ru/dormitory/" for r in rows)
    s = FakeSession()
    assert run(qi.import_links(s, rows))["created"] == len({r["url"] for r in rows})
