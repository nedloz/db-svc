"""Проверка журнала действий и прав роли db-svc на живой базе.

Нужна база, созданная init.sql (или с применённой migrations/008) и роль dbsvc_user. Данные
тестом не портятся: всё, что он создаёт, удаляется, а записи журнала по замыслу остаются
(журнал неизменяем) — поэтому тест помечает свои действия уникальным маркером и ищет по нему.

    POSTGRES_HOST=... POSTGRES_USER=dbsvc_user POSTGRES_PASSWORD=... DBSVC_ADMIN_TOKEN=test \
        python -m pytest tests/test_audit.py -q          # или: python tests/test_audit.py

MinIO для этих проверок не нужен. Переменная DATASET_DIR (по умолчанию /documents) указывает
на каталог с CSV датасета; без неё проверка dry-run импорта пропускается.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

os.environ.setdefault("DBSVC_ADMIN_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Админ приходит от шлюза с подписанным контекстом (app/user_context.py). Тест сам выпускает
# одноразовые ключи и подписывает им, если ключи не заданы окружением.
import tempfile  # noqa: E402

from app import user_context  # noqa: E402

os.environ.setdefault("USER_CONTEXT_AUDIENCE", "db-svc")
if not os.environ.get("USER_CONTEXT_KEY_FILE"):
    _dir = Path(tempfile.mkdtemp(prefix="dbsvc-test-keys-"))
    _master = os.urandom(32)
    (_dir / "master.key").write_text(_master.hex() + "\n")
    (_dir / "db-svc.key").write_text(user_context.derive_key(_master, "db-svc").hex() + "\n")
    os.environ["USER_CONTEXT_KEY_FILE"] = str(_dir / "db-svc.key")
    os.environ["USER_CONTEXT_MASTER_FILE"] = str(_dir / "master.key")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.services.pg import get_conn  # noqa: E402

TOKEN = os.environ["DBSVC_ADMIN_TOKEN"]
ADMIN_ID = str(uuid.uuid4())
MARK = f"audit-test-{uuid.uuid4().hex[:8]}"
GATEWAY = {
    user_context.HEADER: user_context.sign(
        user_context.load_keys(os.environ["USER_CONTEXT_MASTER_FILE"]),
        "db-svc", ADMIN_ID, "admin", ttl_sec=3600,
    ),
    "X-Real-IP": "203.0.113.7",
}
BEARER = {"Authorization": f"Bearer {TOKEN}"}

failures: list[str] = []


def check(cond: bool, message: str) -> None:
    if not cond:
        failures.append(message)
        print(f"ПРОВАЛ  {message}")


def actions(**where):
    """Записи журнала по условию (читаются той же ролью db-svc, что и пишет)."""
    clauses = " AND ".join(f"{k} = %s" for k in where) or "true"
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT action, success, actor_type, actor_user_id::text, actor_role, client_ip, "
            f"target_schema, target_table, target_pk, object_key, details "
            f"FROM audit.db_actions WHERE {clauses} ORDER BY id",
            tuple(where.values()),
        )
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def run() -> int:
    with TestClient(app) as c:
        # --- доступ: без токена 401 JSON, а не 500 ---------------------------------------
        r = c.get("/api/db/schemas")
        check(r.status_code == 401, f"без авторизации ожидался 401, получен {r.status_code}")
        r = c.get("/api/db/schemas", headers={"Authorization": "Bearer wrong"})
        check(r.status_code == 403, f"неверный токен: ожидался 403, получен {r.status_code}")

        # --- CRUD строки через шлюз: актёр, до/после ------------------------------------
        r = c.post("/api/db/core/universities", json={"name": MARK, "short_name": "T"}, headers=GATEWAY)
        check(r.status_code == 201, f"создание строки: {r.status_code} {r.text}")
        row = r.json() if r.status_code == 201 else {}
        uid = row.get("id")

        r = c.patch(f"/api/db/core/universities/{uid}", json={"short_name": "T2"}, headers=GATEWAY)
        check(r.status_code == 200 and r.json().get("short_name") == "T2", f"правка строки: {r.status_code} {r.text}")

        r = c.delete(f"/api/db/core/universities/{uid}", headers=GATEWAY)
        check(r.status_code == 204, f"удаление строки: {r.status_code} {r.text}")

        got = actions(target_pk=uid)
        check([a["action"] for a in got] == ["row.insert", "row.update", "row.delete"],
              f"журнал строки: ожидалось insert/update/delete, получено {[a['action'] for a in got]}")
        if len(got) == 3:
            ins, upd, dele = got
            check(ins["actor_type"] == "user" and ins["actor_user_id"] == ADMIN_ID and ins["actor_role"] == "admin",
                  f"актёр не записан: {ins}")
            check(ins["client_ip"] == "203.0.113.7", f"IP не записан: {ins['client_ip']}")
            check(ins["details"]["after"]["name"] == MARK, "в insert нет итоговой строки")
            check(upd["details"]["changes"] == {"short_name": {"before": "T", "after": "T2"}},
                  f"update: неверные изменения {upd['details']}")
            check(dele["details"]["deleted"]["name"] == MARK, "в delete нет удалённой строки")

        # --- Bearer-токен: актёр 'token' ---------------------------------------------------
        r = c.post("/api/db/core/universities", json={"name": MARK + "-t"}, headers=BEARER)
        tid = r.json().get("id") if r.status_code == 201 else None
        check(r.status_code == 201, f"создание по токену: {r.status_code} {r.text}")
        if tid:
            c.delete(f"/api/db/core/universities/{tid}", headers=BEARER)
            first = actions(target_pk=tid)[0]
            check(first["actor_type"] == "token" and first["actor_user_id"] is None, f"актёр-токен: {first}")

        # --- несуществующая строка не оставляет записи об успехе ---------------------------
        missing = str(uuid.uuid4())
        r = c.delete(f"/api/db/core/universities/{missing}", headers=GATEWAY)
        check(r.status_code == 404, f"удаление отсутствующей строки: {r.status_code}")
        check(actions(target_pk=missing) == [], "для отсутствующей строки появилась запись в журнале")

        # --- auth.users: без password_hash, роль править можно -------------------------------
        r = c.get("/api/db/auth/users/rows?limit=5", headers=GATEWAY)
        check(r.status_code == 200, f"чтение auth.users: {r.status_code} {r.text[:200]}")
        if r.status_code == 200:
            check("password_hash" not in r.json()["columns"], "password_hash виден в списке колонок")
            admin_rows = [x for x in r.json()["rows"] if x["email"] == "admin@edu.hse.ru"]
            check(bool(admin_rows), "нет сид-администратора")
            if admin_rows:
                aid = admin_rows[0]["id"]
                r2 = c.patch(f"/api/db/auth/users/{aid}", json={"role": "curator"}, headers=GATEWAY)
                check(r2.status_code == 200, f"смена роли: {r2.status_code} {r2.text[:200]}")
                r2 = c.patch(f"/api/db/auth/users/{aid}", json={"role": "admin"}, headers=GATEWAY)
                check(r2.status_code == 200, f"возврат роли: {r2.status_code} {r2.text[:200]}")
                ch = [a for a in actions(target_pk=aid, action="row.update")]
                check(len(ch) >= 2 and ch[-2]["details"]["changes"]["role"] == {"before": "admin", "after": "curator"},
                      "смена роли не отражена в журнале")
                r3 = c.get(f"/api/db/auth/users/{aid}/dependencies", headers=GATEWAY)
                check(r3.status_code == 200, f"зависимости пользователя: {r3.status_code} {r3.text[:200]}")

        # --- запретное: пароль, создание пользователя; неудачи тоже в журнале ------------------
        r = c.patch(f"/api/db/auth/users/{aid}", json={"password_hash": "x"}, headers=GATEWAY)
        check(r.status_code in (400, 500), f"правка password_hash должна отклоняться, получен {r.status_code}")
        r = c.post("/api/db/auth/users", json={"email": f"{MARK}@edu.hse.ru"}, headers=GATEWAY)
        check(r.status_code >= 400, f"создание пользователя должно отклоняться, получен {r.status_code}")
        fails = [a for a in actions(action="row.insert", success=False) if a["target_table"] == "users"]
        check(bool(fails), "неудачная вставка в auth.users не попала в журнал")

        # --- графа: прокси недоступен -> 502, попытка записана с success=false ----------------
        r = c.post("/api/graph/entities", json={"name": MARK}, headers=GATEWAY)
        check(r.status_code in (502, 404, 400), f"прокси графа: {r.status_code}")
        g = [a for a in actions(action="graph.post") if a["details"].get("body", {}).get("name") == MARK]
        check(len(g) == 1 and g[0]["success"] is False, f"запись об операции с графом: {g}")

        # --- CSV-импорт: append и replace -------------------------------------------------------
        csv_body = f"name\n{MARK}-csv\n".encode()
        r = c.post("/api/db/import/csv", files={"file": ("u.csv", csv_body, "text/csv")},
                   data={"schema": "core", "table": "universities", "mode": "append"}, headers=GATEWAY)
        check(r.status_code == 200 and r.json().get("ok"), f"csv append: {r.status_code} {r.text[:200]}")
        imp = [a for a in actions(action="import.csv") if a["details"].get("filename") == "u.csv"]
        check(len(imp) >= 1 and imp[-1]["target_table"] == "universities", "csv-импорт не в журнале")
        c.request("GET", "/api/db/core/universities/rows?limit=500", headers=GATEWAY)
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM core.universities WHERE name = %s", (f"{MARK}-csv",))
            conn.commit()
        r = c.post("/api/db/import/csv", files={"file": ("r.csv", b"from_document_id,to_document_id,relation_type\n", "text/csv")},
                   data={"schema": "library", "table": "document_relations", "mode": "replace"}, headers=GATEWAY)
        check(r.status_code in (200, 400), f"csv replace (TRUNCATE листовой таблицы): {r.status_code} {r.text[:300]}")
        check("permission denied" not in r.text, f"csv replace упёрся в права: {r.text[:300]}")

        # --- импорт датасета, dry-run (проверка прав на INSERT/DELETE в core и library) --------------
        ds = Path(os.environ.get("DATASET_DIR", "/documents"))
        names = {
            "universities": "core_ - universities.csv", "campuses": "core_ - campuses.csv",
            "faculties": "core_ - faculties.csv", "buildings": "core_ - buildings.csv",
            "programs": "core_ - programs.csv", "topics": "library_ - topics.csv",
            "documents": "library_ - documents.csv", "document_relations": "library_ - document relations.csv",
        }
        if all((ds / n).exists() for n in names.values()):
            files = {k: (n, (ds / n).read_bytes(), "text/csv") for k, n in names.items()}
            r = c.post("/api/db/import/dataset", files=files, data={"dry_run": "true", "replace_mode": "true"}, headers=GATEWAY)
            check(r.status_code == 200, f"dataset dry-run: {r.status_code} {r.text[:300]}")
            check("permission denied" not in r.text, f"dataset dry-run упёрся в права: {r.text[:300]}")
            d = actions(action="import.dataset")
            check(bool(d) and d[-1]["details"]["dry_run"] is True, "dataset-импорт не в журнале")
        else:
            print("пропущено: нет CSV датасета (DATASET_DIR)")

        # --- выгрузка: читает graph/library, пишет запись -------------------------------------------
        r = c.get("/api/export/graph", headers=GATEWAY)
        check(r.status_code == 200, f"export graph: {r.status_code} {r.text[:200]}")
        r = c.get("/api/export/chunks?embeddings=true", headers=GATEWAY)
        check(r.status_code == 200, f"export chunks: {r.status_code} {r.text[:200]}")
        check(len(actions(action="export.chunks")) >= 1, "выгрузка не в журнале")

        # --- журнал задач: создаётся без DDL ----------------------------------------------------------
        rj = c.post("/api/db/import/csv", files={"file": ("j.csv", b"name\n", "text/csv")},
                    data={"schema": "core", "table": "universities", "mode": "append"}, headers=GATEWAY)
        job_id = rj.json().get("job_id")
        check(bool(job_id) and c.get(f"/api/jobs/{job_id}", headers=GATEWAY).status_code == 200,
              f"журнал задач недоступен: {rj.status_code} {rj.text[:200]}")

        # --- журнал только для добавления --------------------------------------------------------------------
        with get_conn() as conn, conn.cursor() as cur:
            for sql in ("UPDATE audit.db_actions SET action = 'x'", "DELETE FROM audit.db_actions", "TRUNCATE audit.db_actions"):
                try:
                    cur.execute(sql)
                    check(False, f"роль db-svc смогла выполнить: {sql}")
                except Exception as exc:
                    check("permission denied" in str(exc), f"{sql}: ожидался permission denied, получено {exc}")
                    conn.rollback()

    print(f"\nПровалов: {len(failures)}")
    return len(failures)


def test_audit_and_roles():
    assert run() == 0, failures


if __name__ == "__main__":
    sys.exit(1 if run() else 0)
