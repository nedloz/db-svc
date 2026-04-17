from __future__ import annotations

import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Any

import psycopg

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def validate_ident(name: str, kind: str = "identifier") -> str:
    if not _IDENTIFIER_RE.match(name or ""):
        raise ValueError(f"Invalid {kind}: {name!r}. Allowed: letters, digits, underscore; cannot start with digit.")
    return name


def qident(name: str) -> str:
    # Safe because we validate with strict regex and then quote.
    return '"' + name.replace('"', '""') + '"'


@dataclass(frozen=True)
class PgConfig:
    host: str
    port: int
    db: str
    user: str
    password: str

    @staticmethod
    def from_env() -> "PgConfig":
        return PgConfig(
            host=os.getenv("POSTGRES_HOST", "postgres"),
            port=int(os.getenv("POSTGRES_PORT", "5432")),
            db=os.getenv("POSTGRES_DB", "app_db"),
            user=os.getenv("POSTGRES_USER", "app_user"),
            password=os.getenv("POSTGRES_PASSWORD", "app_password"),
        )


@contextmanager
def get_conn() -> Iterator[psycopg.Connection[Any]]:
    cfg = PgConfig.from_env()
    conninfo = (
        f"host={cfg.host} port={cfg.port} dbname={cfg.db} user={cfg.user} password={cfg.password}"
    )
    with psycopg.connect(conninfo, autocommit=False) as conn:
        yield conn

def check_db_connection() -> dict[str, Any]:
    cfg = PgConfig.from_env()
    conninfo = (
        f"host={cfg.host} port={cfg.port} dbname={cfg.db} user={cfg.user} password={cfg.password}"
    )

    try:
        with psycopg.connect(conninfo, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT current_database(), current_user, version()")
                row = cur.fetchone()
                return {
                    "ok": True,
                    "database": row[0],
                    "user": row[1],
                    "version": row[2],
                    "host": cfg.host,
                    "port": cfg.port,
                }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "host": cfg.host,
            "port": cfg.port,
            "database": cfg.db,
            "user": cfg.user,
        }