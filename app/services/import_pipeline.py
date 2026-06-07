from __future__ import annotations

import csv
import io
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from psycopg.types.json import Json

from app.services.pg import get_conn

REQUIRED_FILES = {
    "universities": "core - universities.csv",
    "campuses": "core - campuses.csv",
    "faculties": "core - faculties.csv",
    "buildings": "core - buildings.csv",
    "programs": "core - programs.csv",
    "topics": "library - topics.csv",
    "documents": "library - documents.csv",
    "document_relations": "library - document relations.csv",
}

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


@dataclass
class ImportReport:
    ok: bool = True
    dry_run: bool = False
    files_seen: dict[str, str] = field(default_factory=dict)
    counts_read: dict[str, int] = field(default_factory=dict)
    counts_prepared: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    inserted: dict[str, int] = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)
        self.logs.append(f"WARN: {msg}")

    def error(self, msg: str) -> None:
        self.ok = False
        self.errors.append(msg)
        self.logs.append(f"ERROR: {msg}")

    def info(self, msg: str) -> None:
        self.logs.append(msg)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "dry_run": self.dry_run,
            "files_seen": self.files_seen,
            "counts_read": self.counts_read,
            "counts_prepared": self.counts_prepared,
            "inserted": self.inserted,
            "warnings": self.warnings,
            "errors": self.errors,
            "logs": self.logs,
        }


def _pulse(progress_cb, current: int, total: int, stage: str, message: str | None = None) -> None:
    if progress_cb is not None:
        progress_cb(current, total, stage, message)


def _nullish(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _s(v: Any) -> str | None:
    if _nullish(v):
        return None
    return str(v).strip()


def _old_id(v: Any) -> str | None:
    s = _s(v)
    if s is None:
        return None
    if re.fullmatch(r"\d+\.0", s):
        s = s[:-2]
    return s


def _to_int(v: Any) -> int | None:
    s = _s(v)
    if s is None:
        return None
    return int(float(s))


def _translit(text: str) -> str:
    return "".join(TRANSLIT.get(ch, ch) for ch in text.lower())


def _slugify(text: str | None) -> str:
    base = _translit((text or "topic").strip().lower())
    base = re.sub(r"[^a-z0-9]+", "-", base)
    base = re.sub(r"-+", "-", base).strip("-")
    return base or "topic"


def _unique_slugs(names: list[str | None]) -> list[str]:
    used: dict[str, int] = {}
    out = []
    for name in names:
        base = _slugify(name)
        used[base] = used.get(base, 0) + 1
        out.append(base if used[base] == 1 else f"{base}-{used[base]}")
    return out


def _read_csv_bytes(data: bytes) -> list[dict[str, str]]:
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    return [dict(row) for row in reader]


def _make_map(rows: list[dict[str, Any]], report: ImportReport, table_name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for i, row in enumerate(rows, 1):
        oid = _old_id(row.get("id"))
        if oid is None:
            report.error(f"{table_name}: пустой id в строке {i}")
            continue
        if oid in out:
            report.error(f"{table_name}: дубликат id={oid}")
            continue
        out[oid] = str(uuid.uuid4())
    return out


def _parse_scope(raw: str | None, maps: dict[str, dict[str, str]], report: ImportReport, row_label: str) -> Any:
    if _nullish(raw):
        return None
    try:
        obj = json.loads(str(raw))
    except Exception as e:
        report.error(f"{row_label}: битый scope_json: {e}")
        return None

    key_to_map = {
        "university": "universities",
        "universities": "universities",
        "campus": "campuses",
        "campuses": "campuses",
        "faculty": "faculties",
        "faculties": "faculties",
        "building": "buildings",
        "buildings": "buildings",
        "program": "programs",
        "programs": "programs",
        "topic": "topics",
        "topics": "topics",
    }

    def remap_value(key: str, value: Any) -> Any:
        map_name = key_to_map.get(key)
        if map_name is None:
            return value
        mapping = maps[map_name]
        if value is None:
            return None
        if isinstance(value, list):
            return [remap_value(key, x) for x in value if remap_value(key, x) is not None]
        if isinstance(value, str) and value.strip().lower() == "all":
            return "all"
        old = _old_id(value)
        if old is None:
            report.warn(f"{row_label}: scope_json.{key} содержит пустое значение")
            return None
        new = mapping.get(old)
        if new is None:
            report.warn(f"{row_label}: scope_json.{key} old_id={old} не найден")
            return None
        return new

    return {k: remap_value(k, v) for k, v in obj.items()}


def _normalize_inputs(files: dict[str, tuple[str, bytes]], report: ImportReport) -> dict[str, list[dict[str, Any]]]:
    raw: dict[str, list[dict[str, Any]]] = {}
    for key, expected_name in REQUIRED_FILES.items():
        if key not in files:
            report.error(f"Не загружен обязательный файл: {expected_name}")
            continue
        filename, content = files[key]
        report.files_seen[key] = filename
        rows = _read_csv_bytes(content)
        report.counts_read[key] = len(rows)
        raw[key] = rows

    if report.errors:
        return raw

    # trim and keep only needed columns
    for key, rows in raw.items():
        for row in rows:
            for k, v in list(row.items()):
                row[k] = _s(v)

    # topics slug from name
    topic_rows = raw["topics"]
    topic_slugs = _unique_slugs([r.get("name") for r in topic_rows])
    for row, slug in zip(topic_rows, topic_slugs):
        row["slug"] = slug

    return raw


def _prepare_rows(raw: dict[str, list[dict[str, Any]]], report: ImportReport) -> tuple[dict[str, dict[str, str]], dict[str, list[tuple[Any, ...]]]]:
    maps = {name: _make_map(rows, report, name) for name, rows in raw.items()}
    if report.errors:
        return maps, {}

    def check_ref(rows: list[dict[str, Any]], col: str, target: str, label: str) -> None:
        for i, row in enumerate(rows, 1):
            old = _old_id(row.get(col))
            if old is None:
                continue
            if old not in maps[target]:
                report.error(f"{label}: ссылка {col}={old} не найдена в {target}, строка {i}")

    check_ref(raw["campuses"], "university_id", "universities", "campuses")
    check_ref(raw["faculties"], "university_id", "universities", "faculties")
    check_ref(raw["buildings"], "campus_id", "campuses", "buildings")
    check_ref(raw["programs"], "faculty_id", "faculties", "programs")
    check_ref(raw["topics"], "parent_id", "topics", "topics")
    check_ref(raw["documents"], "topic_id", "topics", "documents")
    check_ref(raw["document_relations"], "from_document_id", "documents", "document_relations")
    check_ref(raw["document_relations"], "to_document_id", "documents", "document_relations")

    if report.errors:
        return maps, {}

    rows: dict[str, list[tuple[Any, ...]]] = {
        "universities": [],
        "campuses": [],
        "faculties": [],
        "buildings": [],
        "programs": [],
        "topics": [],
        "documents": [],
        "document_relations": [],
    }

    for r in raw["universities"]:
        rows["universities"].append((
            maps["universities"][_old_id(r["id"])], r.get("name"), r.get("short_name"), r.get("timezone"),
            r.get("website_url"),
        ))

    for r in raw["campuses"]:
        rows["campuses"].append((
            maps["campuses"][_old_id(r["id"])],
            maps["universities"][_old_id(r["university_id"])],
            r.get("city"),
        ))

    for r in raw["faculties"]:
        rows["faculties"].append((
            maps["faculties"][_old_id(r["id"])],
            maps["universities"][_old_id(r["university_id"])],
            r.get("name"), r.get("short_name"),
        ))

    for r in raw["buildings"]:
        rows["buildings"].append((
            maps["buildings"][_old_id(r["id"])],
            maps["campuses"][_old_id(r["campus_id"])],
            r.get("name"), r.get("address"), r.get("map_url"),
        ))

    for r in raw["programs"]:
        rows["programs"].append((
            maps["programs"][_old_id(r["id"])],
            maps["faculties"][_old_id(r["faculty_id"])],
            r.get("name"), r.get("short_name"), r.get("code"), r.get("degree_level"), r.get("study_form"), r.get("language"),
        ))

    for r in raw["topics"]:
        pid = _old_id(r.get("parent_id"))
        rows["topics"].append((
            maps["topics"][_old_id(r["id"])], maps["topics"].get(pid), r.get("name"), r.get("slug"), r.get("description"), _to_int(r.get("order_index")),
        ))

    for idx, r in enumerate(raw["documents"], 1):
        tid = _old_id(r.get("topic_id"))
        scope = _parse_scope(r.get("scope_json"), maps, report, f"documents[{idx}]")
        rows["documents"].append((
            maps["documents"][_old_id(r["id"])], maps["topics"].get(tid), r.get("title"), r.get("category"), r.get("source_type"),
            r.get("content_type"), r.get("language"), r.get("status"), _to_int(r.get("priority")), r.get("origin_url"),
            None, Json(scope) if scope is not None else None, r.get("ingest_status"), r.get("indexed_at"), r.get("ingest_error"), _to_int(r.get("content_version")), None,
        ))

    for r in raw["document_relations"]:
        rows["document_relations"].append((
            maps["document_relations"][_old_id(r["id"])],
            maps["documents"][_old_id(r["from_document_id"])],
            maps["documents"][_old_id(r["to_document_id"])],
            r.get("relation_type"), r.get("label"),
        ))

    for name, vals in rows.items():
        report.counts_prepared[name] = len(vals)
    report.info("Подготовка данных завершена")
    return maps, rows


SQL = {
    "universities": "INSERT INTO core.universities (id, name, short_name, timezone, website_url) VALUES (%s,%s,%s,%s,%s)",
    "campuses": "INSERT INTO core.campuses (id, university_id, city) VALUES (%s,%s,%s)",
    "faculties": "INSERT INTO core.faculties (id, university_id, name, short_name) VALUES (%s,%s,%s,%s)",
    "buildings": "INSERT INTO core.buildings (id, campus_id, name, address, map_url) VALUES (%s,%s,%s,%s,%s)",
    "programs": "INSERT INTO core.programs (id, faculty_id, name, short_name, code, degree_level, study_form, language) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
    "topics": "INSERT INTO library.topics (id, parent_id, name, slug, description, order_index) VALUES (%s,%s,%s,%s,%s,%s)",
    "documents": "INSERT INTO library.documents (id, topic_id, title, category, source_type, content_type, language, status, priority, origin_url, checksum, scope_json, ingest_status, indexed_at, ingest_error, content_version, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    "document_relations": "INSERT INTO library.document_relations (id, from_document_id, to_document_id, relation_type, label) VALUES (%s,%s,%s,%s,%s)",
}

TRUNCATE_SQL = [
    "TRUNCATE TABLE library.document_relations CASCADE",
    "TRUNCATE TABLE library.documents CASCADE",
    "TRUNCATE TABLE library.topics CASCADE",
    "TRUNCATE TABLE core.programs CASCADE",
    "TRUNCATE TABLE core.buildings CASCADE",
    "TRUNCATE TABLE core.faculties CASCADE",
    "TRUNCATE TABLE core.campuses CASCADE",
    "TRUNCATE TABLE core.universities CASCADE",
]


def run_dataset_import(files: dict[str, tuple[str, bytes]], dry_run: bool = False, replace_mode: bool = False, progress_cb=None, cancel_check=None) -> dict[str, Any]:
    report = ImportReport(dry_run=dry_run)
    order = ["universities", "campuses", "faculties", "buildings", "programs", "topics", "documents", "document_relations"]
    total_steps = 4 + len(order) + (1 if replace_mode else 0)
    step = 0

    def advance(stage: str, message: str | None = None) -> None:
        nonlocal step
        step += 1
        _pulse(progress_cb, step, total_steps, stage, message)

    _pulse(progress_cb, step, total_steps, "reading", "Чтение CSV файлов")
    report.info("Чтение CSV файлов")
    if cancel_check is not None and cancel_check():
        raise RuntimeError("Job cancelled")
    raw = _normalize_inputs(files, report)
    advance("normalized", "CSV файлы прочитаны")

    if cancel_check is not None and cancel_check():
        raise RuntimeError("Job cancelled")
    maps, rows = _prepare_rows(raw, report)
    advance("prepared", "Данные подготовлены")

    if report.errors:
        return report.as_dict()

    if dry_run:
        report.info("Dry-run: вставка в БД не выполнялась")
        advance("dry_run", "Dry-run завершён")
        return report.as_dict()

    with get_conn() as conn:
        with conn.cursor() as cur:
            if replace_mode:
                report.info("TRUNCATE целевых таблиц")
                for stmt in TRUNCATE_SQL:
                    if cancel_check is not None and cancel_check():
                        raise RuntimeError("Job cancelled")
                    cur.execute(stmt)
                advance("truncate", "Таблицы очищены")
            for name in order:
                if cancel_check is not None and cancel_check():
                    raise RuntimeError("Job cancelled")
                vals = rows[name]
                if not vals:
                    advance(f"insert:{name}", f"Пропуск {name}: нет строк")
                    continue
                cur.executemany(SQL[name], vals)
                report.inserted[name] = len(vals)
                report.info(f"Вставлено в {name}: {len(vals)}")
                advance(f"insert:{name}", f"Вставлено в {name}: {len(vals)}")
        conn.commit()

    report.info("Импорт завершён")
    return report.as_dict()


def dataset_status() -> dict[str, Any]:
    return {
        "ok": True,
        "route": "/api/db/import/dataset",
        "required_files": REQUIRED_FILES,
        "notes": [
            "Алгоритм remap old_id -> UUID выполняется в памяти Python",
            "scope_json сохраняет значение 'all' без замены",
            "created_by и checksum в documents выставляются в NULL",
            "created_at и updated_at остаются на default БД",
        ],
    }
