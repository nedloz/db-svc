from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Json

from app.services import audit
from app.services.pg import get_conn, qident, validate_ident


def _adapt_param(value: Any) -> Any:
    # dict/list нельзя биндить напрямую в %s для JSON/JSONB — psycopg бросает
    # "cannot adapt type 'dict'". Оборачиваем в Json(), psycopg сам сериализует.
    if isinstance(value, (dict, list)):
        return Json(value)
    return value


def _pk_where(columns_meta: "list[ColumnInfo]", pk_value: Any) -> tuple[str, list[Any]]:
    """WHERE по первичному ключу. Поддерживает составной PK (P-010).

    pk_value:
      - dict {col: val, ...} — для составного PK (или явного одиночного);
      - скаляр — для одиночного PK (обратная совместимость).
    Возвращает (where_sql, params).
    """
    pk_cols = [c.name for c in columns_meta if c.is_pk]
    if not pk_cols:
        raise HTTPException(status_code=400, detail='Table has no primary key')

    if isinstance(pk_value, dict):
        missing = [c for c in pk_cols if c not in pk_value]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f'Missing PK columns: {", ".join(missing)} (expected {", ".join(pk_cols)})',
            )
        cols, vals = pk_cols, [pk_value[c] for c in pk_cols]
    else:
        if len(pk_cols) != 1:
            raise HTTPException(
                status_code=400,
                detail=f'Composite primary key requires object of values for: {", ".join(pk_cols)}',
            )
        cols, vals = pk_cols, [pk_value]

    where = ' AND '.join(f'{qident(c)} = %s' for c in cols)
    return where, vals


@dataclass(frozen=True)
class ColumnInfo:
    name: str
    data_type: str
    udt_name: str
    nullable: bool
    default: str | None
    is_identity: bool
    is_generated: bool
    is_pk: bool


@dataclass(frozen=True)
class ForeignKeyInfo:
    column: str
    references_schema: str
    references_table: str
    references_column: str
    on_delete: str
    is_nullable: bool



def _jsonable(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        # Prefer int when exact, float otherwise.
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value



def serialize_row(columns: list[str], row: tuple[Any, ...]) -> dict[str, Any]:
    return {columns[i]: _jsonable(row[i]) for i in range(len(columns))}



def _fetch_pk_columns(conn, schema: str, table: str) -> list[str]:
    # pg_catalog, а не information_schema: последний показывает ограничения только тех
    # таблиц, где у роли есть права помимо SELECT. К графу, чатам и таблицам токенов у роли
    # db-svc только чтение, и через information_schema у них пропадали бы первичные ключи.
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.attname
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            WHERE con.contype = 'p'
              AND n.nspname = %s
              AND c.relname = %s
            ORDER BY k.ord
            """,
            (schema, table),
        )
        return [r[0] for r in cur.fetchall()]



def get_primary_key_columns(schema: str, table: str) -> list[str]:
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    with get_conn() as conn:
        return _fetch_pk_columns(conn, schema, table)



def get_table_columns(schema: str, table: str) -> list[ColumnInfo]:
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    with get_conn() as conn:
        pk_cols = set(_fetch_pk_columns(conn, schema, table))
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    column_name,
                    data_type,
                    udt_name,
                    (is_nullable = 'YES') AS nullable,
                    column_default,
                    (is_identity = 'YES') AS is_identity,
                    (is_generated <> 'NEVER') AS is_generated
                FROM information_schema.columns
                WHERE table_schema = %s
                  AND table_name = %s
                ORDER BY ordinal_position
                """,
                (schema, table),
            )
            rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail='Table not found')
    return [
        ColumnInfo(
            name=r[0],
            data_type=r[1],
            udt_name=r[2],
            nullable=bool(r[3]),
            default=r[4],
            is_identity=bool(r[5]),
            is_generated=bool(r[6]),
            is_pk=r[0] in pk_cols,
        )
        for r in rows
    ]



def get_table_column_map(schema: str, table: str) -> dict[str, ColumnInfo]:
    return {c.name: c for c in get_table_columns(schema, table)}



def get_column_allowed_values(schema: str, table: str) -> dict[str, list[str]]:
    """Допустимые значения колонок (P-011): из enum-типов и из CHECK (col IN (...)).

    Возвращает {column_name: [values...]}. Для фронта — источник выпадающих списков.
    """
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    result: dict[str, list[str]] = {}

    with get_conn() as conn:
        with conn.cursor() as cur:
            # 1) Колонки enum-типа → метки из pg_enum.
            cur.execute(
                """
                SELECT a.attname, e.enumlabel
                FROM pg_attribute a
                JOIN pg_type t ON a.atttypid = t.oid
                JOIN pg_enum e ON e.enumtypid = t.oid
                JOIN pg_class c ON a.attrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = %s AND c.relname = %s
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attname, e.enumsortorder
                """,
                (schema, table),
            )
            for col, label in cur.fetchall():
                result.setdefault(col, []).append(label)

            # 2) CHECK-констрейнты (одноколоночные) → парсим строковые литералы.
            cur.execute(
                """
                SELECT con.conkey, pg_get_constraintdef(con.oid)
                FROM pg_constraint con
                JOIN pg_class c ON con.conrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = %s AND c.relname = %s AND con.contype = 'c'
                """,
                (schema, table),
            )
            checks = cur.fetchall()

            cur.execute(
                """
                SELECT a.attnum, a.attname
                FROM pg_attribute a
                JOIN pg_class c ON a.attrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = %s AND c.relname = %s
                  AND a.attnum > 0 AND NOT a.attisdropped
                """,
                (schema, table),
            )
            attmap = {num: name for num, name in cur.fetchall()}

    for conkey, condef in checks:
        # Берём только CHECK по одной колонке (status IN (...)), пропускаем
        # многоколоночные и числовые (year >= 1 — там нет строковых литералов).
        if not conkey or len(conkey) != 1:
            continue
        col = attmap.get(conkey[0])
        if not col or col in result:
            continue
        # Извлекаем строковые литералы '...' (с учётом экранирования '').
        literals = re.findall(r"'((?:[^']|'')*)'", condef or '')
        if literals:
            result[col] = [s.replace("''", "'") for s in literals]

    return result



def _build_filter_clause(filters: list[dict[str, Any]] | None, columns: dict[str, ColumnInfo]) -> tuple[str, list[Any]]:
    if not filters:
        return '', []

    clauses: list[str] = []
    params: list[Any] = []

    for raw in filters:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail='Each filter must be an object')
        column = raw.get('column')
        if not isinstance(column, str):
            raise HTTPException(status_code=400, detail='Filter column must be a string')
        validate_ident(column, 'column')
        if column not in columns:
            raise HTTPException(status_code=400, detail=f'Unknown column: {column}')

        op = str(raw.get('op') or 'eq').lower().strip()
        ident = qident(column)
        value = raw.get('value')

        if op == 'null':
            clauses.append(f'{ident} IS NULL')
            continue
        if op == 'not_null':
            clauses.append(f'{ident} IS NOT NULL')
            continue
        if op == 'eq':
            clauses.append(f'{ident} IS NOT DISTINCT FROM %s')
            params.append(value)
        elif op == 'ne':
            clauses.append(f'{ident} IS DISTINCT FROM %s')
            params.append(value)
        elif op == 'contains':
            clauses.append(f'CAST({ident} AS TEXT) ILIKE %s')
            params.append(f'%{value}%')
        elif op == 'starts':
            clauses.append(f'CAST({ident} AS TEXT) ILIKE %s')
            params.append(f'{value}%')
        elif op == 'ends':
            clauses.append(f'CAST({ident} AS TEXT) ILIKE %s')
            params.append(f'%{value}')
        elif op == 'between':
            if not isinstance(value, list) or len(value) != 2:
                raise HTTPException(status_code=400, detail='between filter requires value=[from, to]')
            clauses.append(f'{ident} BETWEEN %s AND %s')
            params.extend(value)
        elif op == 'in':
            if not isinstance(value, list) or not value:
                raise HTTPException(status_code=400, detail='in filter requires a non-empty array')
            clauses.append(f'{ident} = ANY(%s)')
            params.append(value)
        else:
            raise HTTPException(status_code=400, detail=f'Unsupported filter op: {op}')

    return ' WHERE ' + ' AND '.join(clauses), params



def _order_clause(order_by: str | None, direction: str | None, columns: dict[str, ColumnInfo]) -> str:
    if not columns:
        return ''
    if order_by:
        validate_ident(order_by, 'order_by')
        if order_by not in columns:
            raise HTTPException(status_code=400, detail=f'Unknown order_by column: {order_by}')
        col = order_by
    else:
        pk_cols = [c.name for c in columns.values() if c.is_pk]
        col = pk_cols[0] if pk_cols else next(iter(columns.keys()))

    dir_sql = 'ASC'
    if direction:
        direction = direction.lower().strip()
        if direction not in ('asc', 'desc'):
            raise HTTPException(status_code=400, detail='direction must be asc|desc')
        dir_sql = direction.upper()
    return f' ORDER BY {qident(col)} {dir_sql}'



def list_rows(
    schema: str,
    table: str,
    *,
    limit: int = 50,
    offset: int = 0,
    order_by: str | None = None,
    direction: str | None = None,
    filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    columns_meta = get_table_columns(schema, table)
    columns = {c.name: c for c in columns_meta}
    where_sql, params = _build_filter_clause(filters, columns)
    order_sql = _order_clause(order_by, direction, columns)

    limit = max(1, min(int(limit), 5000))
    offset = max(0, int(offset))

    select_cols = ', '.join(qident(c.name) for c in columns_meta)
    sql = f'SELECT {select_cols} FROM {qident(schema)}.{qident(table)}{where_sql}{order_sql} LIMIT %s OFFSET %s'
    count_sql = f'SELECT COUNT(*) FROM {qident(schema)}.{qident(table)}{where_sql}'

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (*params, limit, offset))
            rows = cur.fetchall()
            cur.execute(count_sql, params)
            total = int(cur.fetchone()[0])

    return {
        'schema': schema,
        'table': table,
        'columns': [c.name for c in columns_meta],
        'column_meta': [
            {
                'name': c.name,
                'type': c.data_type,
                'udt_name': c.udt_name,
                'nullable': c.nullable,
                'default': c.default,
                'is_identity': c.is_identity,
                'is_generated': c.is_generated,
                'is_pk': c.is_pk,
            }
            for c in columns_meta
        ],
        'rows': [serialize_row([c.name for c in columns_meta], row) for row in rows],
        'limit': limit,
        'offset': offset,
        'total': total,
        'filters': filters or [],
        'order_by': order_by,
        'direction': direction or 'asc',
    }



def fetch_row_by_pk(schema: str, table: str, pk_value: Any) -> dict[str, Any] | None:
    columns_meta = get_table_columns(schema, table)
    where, params = _pk_where(columns_meta, pk_value)
    select_cols = ', '.join(qident(c.name) for c in columns_meta)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f'SELECT {select_cols} FROM {qident(schema)}.{qident(table)} WHERE {where}',
                tuple(params),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return serialize_row([c.name for c in columns_meta], row)



def _returning(columns_meta: "list[ColumnInfo]") -> str:
    # Явный список вместо `*`: у роли db-svc нет доступа к часть колонок (password_hash,
    # token_hash), и `RETURNING *` / `SELECT *` по таким таблицам отвечали бы permission denied.
    # information_schema.columns отдаёт только доступные роли колонки, так что список честный.
    return ', '.join(qident(c.name) for c in columns_meta)


def _row_pk(columns_meta: "list[ColumnInfo]", row: dict[str, Any]) -> Any:
    pk_cols = [c.name for c in columns_meta if c.is_pk]
    if not pk_cols:
        return None
    if len(pk_cols) == 1:
        return row.get(pk_cols[0])
    return {name: row.get(name) for name in pk_cols}


def insert_row(schema: str, table: str, payload: dict[str, Any]) -> dict[str, Any]:
    columns_meta = get_table_columns(schema, table)
    columns = {c.name: c for c in columns_meta}
    unknown = [k for k in payload.keys() if k not in columns]
    if unknown:
        raise HTTPException(status_code=400, detail=f'Unknown columns: {", ".join(sorted(unknown))}')

    insert_cols = list(payload.keys())
    returning = _returning(columns_meta)
    names = [c.name for c in columns_meta]
    with get_conn() as conn:
        with conn.cursor() as cur:
            if insert_cols:
                col_sql = ', '.join(qident(c) for c in insert_cols)
                placeholders = ', '.join(['%s'] * len(insert_cols))
                cur.execute(
                    f'INSERT INTO {qident(schema)}.{qident(table)} ({col_sql}) VALUES ({placeholders}) RETURNING {returning}',
                    tuple(_adapt_param(payload[c]) for c in insert_cols),
                )
            else:
                cur.execute(f'INSERT INTO {qident(schema)}.{qident(table)} DEFAULT VALUES RETURNING {returning}')
            row = serialize_row(names, cur.fetchone())
            # Запись журнала в той же транзакции: нет следа — нет и вставки.
            audit.record(
                conn, 'row.insert', schema=schema, table=table,
                pk=_row_pk(columns_meta, row), details={'after': row},
            )
            conn.commit()

    return row



def update_row(schema: str, table: str, pk_value: Any, payload: dict[str, Any]) -> dict[str, Any]:
    columns_meta = get_table_columns(schema, table)
    columns = {c.name: c for c in columns_meta}

    unknown = [k for k in payload.keys() if k not in columns]
    if unknown:
        raise HTTPException(status_code=400, detail=f'Unknown columns: {", ".join(sorted(unknown))}')
    if not payload:
        raise HTTPException(status_code=400, detail='No fields provided for update')

    where, where_params = _pk_where(columns_meta, pk_value)
    set_sql = ', '.join(f'{qident(col)} = %s' for col in payload.keys())
    params = [_adapt_param(payload[col]) for col in payload.keys()]
    params.extend(where_params)
    returning = _returning(columns_meta)
    names = [c.name for c in columns_meta]

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Прежнее значение читается под блокировкой строки: в журнал попадает ровно то,
            # что было затёрто этим UPDATE, а не то, что успел записать параллельный запрос.
            cur.execute(
                f'SELECT {returning} FROM {qident(schema)}.{qident(table)} WHERE {where} FOR UPDATE',
                tuple(where_params),
            )
            before_raw = cur.fetchone()
            if before_raw is None:
                conn.rollback()
                return None
            before = serialize_row(names, before_raw)

            cur.execute(
                f'UPDATE {qident(schema)}.{qident(table)} SET {set_sql} WHERE {where} RETURNING {returning}',
                tuple(params),
            )
            row = serialize_row(names, cur.fetchone())
            changes = {
                col: {'before': before.get(col), 'after': row.get(col)}
                for col in payload.keys()
                if before.get(col) != row.get(col)
            }
            audit.record(
                conn, 'row.update', schema=schema, table=table,
                pk=audit.pk_text(pk_value), details={'changes': changes},
            )
            conn.commit()

    return row



def delete_row(schema: str, table: str, pk_value: Any) -> bool:
    columns_meta = get_table_columns(schema, table)
    where, params = _pk_where(columns_meta, pk_value)
    returning = _returning(columns_meta)
    names = [c.name for c in columns_meta]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f'DELETE FROM {qident(schema)}.{qident(table)} WHERE {where} RETURNING {returning}',
                tuple(params),
            )
            deleted_raw = cur.fetchone()
            if deleted_raw is None:
                conn.rollback()
                return False
            audit.record(
                conn, 'row.delete', schema=schema, table=table,
                pk=audit.pk_text(pk_value), details={'deleted': serialize_row(names, deleted_raw)},
            )
            conn.commit()
    return True



def get_relations(schema: str, table: str) -> list[dict[str, Any]]:
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    a.attname, rn.nspname, rc.relname, ra.attname,
                    CASE con.confdeltype
                        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                    END,
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_class rc ON rc.oid = con.confrelid
                JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
                WHERE con.contype = 'f'
                  AND n.nspname = %s AND c.relname = %s
                ORDER BY con.conname, k.ord
                """,
                (schema, table),
            )
            rows = cur.fetchall()
    return [
        {
            'column': r[0],
            'references': {'schema': r[1], 'table': r[2], 'column': r[3]},
            'on_delete': r[4],
            'is_nullable': (r[5] == 'YES'),
        }
        for r in rows
    ]



def get_inbound_relations(schema: str, table: str) -> list[dict[str, Any]]:
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    n.nspname, c.relname, a.attname, ra.attname,
                    CASE con.confdeltype
                        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                    END,
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_class rc ON rc.oid = con.confrelid
                JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
                WHERE con.contype = 'f'
                  AND rn.nspname = %s AND rc.relname = %s
                ORDER BY n.nspname, c.relname, con.conname, k.ord
                """,
                (schema, table),
            )
            rows = cur.fetchall()
    return [
        {
            'schema': r[0],
            'table': r[1],
            'column': r[2],
            'references_column': r[3],
            'on_delete': r[4],
            'is_nullable': (r[5] == 'YES'),
        }
        for r in rows
    ]



def get_dependencies(schema: str, table: str, pk_value: Any, sample: int = 3) -> dict[str, Any]:
    if sample < 0:
        sample = 0

    if fetch_row_by_pk(schema, table, pk_value) is None:
        raise HTTPException(status_code=404, detail='Row not found')

    inbound = get_inbound_relations(schema, table)
    by_table: list[dict[str, Any]] = []
    total = 0

    for rel in inbound:
        child_schema = rel['schema']
        child_table = rel['table']
        child_column = rel['column']
        # Дочерний FK ссылается на конкретную PK-колонку родителя — берём её
        # значение (для составного PK pk_value это dict).
        ref_value = pk_value[rel['references_column']] if isinstance(pk_value, dict) else pk_value
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f'SELECT COUNT(*) FROM {qident(child_schema)}.{qident(child_table)} WHERE {qident(child_column)} = %s',
                    (ref_value,),
                )
                count = int(cur.fetchone()[0])
                sample_rows: list[dict[str, Any]] = []
                if sample > 0 and count > 0:
                    child_columns = get_table_columns(child_schema, child_table)
                    child_names = [c.name for c in child_columns]
                    cur.execute(
                        f'SELECT {_returning(child_columns)} FROM {qident(child_schema)}.{qident(child_table)} '
                        f'WHERE {qident(child_column)} = %s LIMIT %s',
                        (ref_value, sample),
                    )
                    sample_rows = [serialize_row(child_names, row) for row in cur.fetchall()]
        total += count
        item = {
            'schema': child_schema,
            'table': child_table,
            'column': child_column,
            'count': count,
            'on_delete': rel['on_delete'],
        }
        if sample > 0:
            item['samples'] = sample_rows
        by_table.append(item)

    return {'total': total, 'by_table': by_table}



def _csv_cell(value: Any) -> str:
    value = _jsonable(value)
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)



def export_csv_text(
    schema: str,
    table: str,
    *,
    limit: int = 50000,
    offset: int = 0,
    order_by: str | None = None,
    direction: str | None = None,
    filters: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    payload = list_rows(
        schema,
        table,
        limit=limit,
        offset=offset,
        order_by=order_by,
        direction=direction,
        filters=filters,
    )
    columns = payload['columns']
    rows = payload['rows']
    total = payload['total']
    truncated = (offset + len(rows)) < total

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(columns)
    for row in rows:
        writer.writerow([_csv_cell(row.get(col)) for col in columns])
    text = '﻿' + buf.getvalue()
    meta = {
        'total': total,
        'returned': len(rows),
        'truncated': truncated,
        'limit': limit,
        'offset': offset,
    }
    return text, meta
