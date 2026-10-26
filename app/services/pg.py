from __future__ import annotations

import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Any

import psycopg
from psycopg.conninfo import make_conninfo

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
    # Вход по клиентскому сертификату (infra/pki, infra/db/pg_hba.pki.conf): если задан
    # POSTGRES_SSLCERT, пароль не используется, а подлинность роли подтверждает сертификат,
    # CN которого равен имени роли. Файлы читаются libpq при каждом соединении, поэтому
    # обновлённый сертификат подхватывается без перезапуска сервиса.
    sslcert: str = ""
    sslkey: str = ""
    sslrootcert: str = ""
    sslmode: str = ""

    @staticmethod
    def from_env() -> "PgConfig":
        return PgConfig(
            host=os.getenv("POSTGRES_HOST", "postgres"),
            port=int(os.getenv("POSTGRES_PORT", "5432")),
            db=os.getenv("POSTGRES_DB", "app_db"),
            user=os.getenv("POSTGRES_USER", "app_user"),
            password=os.getenv("POSTGRES_PASSWORD", "app_password"),
            sslcert=os.getenv("POSTGRES_SSLCERT", ""),
            sslkey=os.getenv("POSTGRES_SSLKEY", ""),
            sslrootcert=os.getenv("POSTGRES_SSLROOTCERT", ""),
            sslmode=os.getenv("POSTGRES_SSLMODE", ""),
        )

    def conninfo(self) -> str:
        params: dict[str, Any] = {"host": self.host, "port": self.port, "dbname": self.db, "user": self.user}
        if self.sslcert:
            # Сервер проверяется целиком (цепочка и имя хоста), а не принимается на веру.
            params.update(
                sslmode=self.sslmode or "verify-full",
                sslcert=self.sslcert,
                sslkey=self.sslkey,
                sslrootcert=self.sslrootcert,
            )
        else:
            params["password"] = self.password
            if self.sslmode:
                params["sslmode"] = self.sslmode
        return make_conninfo(**params)


@contextmanager
def get_conn() -> Iterator[psycopg.Connection[Any]]:
    with psycopg.connect(PgConfig.from_env().conninfo(), autocommit=False) as conn:
        yield conn

def check_db_connection() -> dict[str, Any]:
    cfg = PgConfig.from_env()

    try:
        with psycopg.connect(cfg.conninfo(), autocommit=True) as conn:
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
                    "auth": "certificate" if cfg.sslcert else "password",
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
