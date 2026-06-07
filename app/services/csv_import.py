from __future__ import annotations

import csv
import io
import time
from typing import Any

from fastapi import HTTPException

from app.services.catalog import get_table_columns, qident
from app.services.pg import get_conn, validate_ident


def _violation(
    *,
    line: int | None,
    column: str | None,
    code: str,
    message: str,
    constraint: str | None = None,
) -> dict[str, Any]:
    item = {
        'line': line,
        'column': column,
        'code': code,
        'message': message,
    }
    if constraint:
        item['constraint'] = constraint
    return item



def _looks_like_required_column(column_info) -> bool:
    return (
        not column_info.nullable
        and not column_info.default
        and not column_info.is_identity
        and not column_info.is_generated
        and not column_info.is_pk
    )



def import_csv_with_report(
    *,
    file_bytes: bytes,
    schema: str,
    table: str,
    mode: str = 'append',
    delimiter: str = ',',
    encoding: str = 'utf-8',
    filename: str | None = None,
    progress_cb=None,
    cancel_check=None,
) -> dict[str, Any]:
    validate_ident(schema, 'schema')
    validate_ident(table, 'table')
    if mode not in ('append', 'replace'):
        raise HTTPException(status_code=400, detail='mode must be append|replace')
    if len(delimiter) != 1:
        raise HTTPException(status_code=400, detail='delimiter must be a single character')

    started = time.monotonic()
    columns_meta = get_table_columns(schema, table)
    columns_map = {c.name: c for c in columns_meta}

    text = file_bytes.decode(encoding, errors='strict')
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if reader.fieldnames is None:
        raise HTTPException(status_code=400, detail='CSV header is missing')

    header = [h.lstrip('\ufeff').strip() if isinstance(h, str) else h for h in reader.fieldnames]
    reader.fieldnames = header
    unknown_columns = [col for col in header if col not in columns_map]
    if unknown_columns:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return {
            'ok': False,
            'detail': f'unknown columns: {", ".join(unknown_columns)}',
            'schema': schema,
            'table': table,
            'mode': mode,
            'filename': filename,
            'rows_inserted': 0,
            'rows_skipped': 0,
            'rows_deleted_by_truncate': 0,
            'rows_inserted_before_failure': 0,
            'elapsed_ms': elapsed_ms,
            'violations': [_violation(line=1, column=None, code='unknown_columns', message=f'unknown columns: {", ".join(unknown_columns)}')],
        }

    missing_required = [c.name for c in columns_meta if _looks_like_required_column(c) and c.name not in header]
    if missing_required:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return {
            'ok': False,
            'detail': f'missing required columns: {", ".join(missing_required)}',
            'schema': schema,
            'table': table,
            'mode': mode,
            'filename': filename,
            'rows_inserted': 0,
            'rows_skipped': 0,
            'rows_deleted_by_truncate': 0,
            'rows_inserted_before_failure': 0,
            'elapsed_ms': elapsed_ms,
            'violations': [_violation(line=1, column=None, code='missing_required_columns', message=f'missing required columns: {", ".join(missing_required)}')],
        }

    insert_columns = [col for col in header if col in columns_map]
    if not insert_columns:
        raise HTTPException(status_code=400, detail='CSV header does not contain insertable columns')

    rows = list(reader)
    total_rows = len(rows)
    if progress_cb:
        progress_cb(0, max(total_rows, 1), 'parse', 'CSV parsed')
    if cancel_check and cancel_check():
        raise HTTPException(status_code=499, detail='Job cancelled')

    rows_deleted_by_truncate = 0
    inserted = 0
    rows_inserted_before_failure = 0
    violations: list[dict[str, Any]] = []

    with get_conn() as conn:
        with conn.cursor() as cur:
            if mode == 'replace':
                cur.execute(f'SELECT COUNT(*) FROM {qident(schema)}.{qident(table)}')
                rows_deleted_by_truncate = int(cur.fetchone()[0])
                cur.execute(f'TRUNCATE TABLE {qident(schema)}.{qident(table)}')

            for idx, row in enumerate(rows, 1):
                if progress_cb and (idx == 1 or idx == total_rows or idx % 50 == 0):
                    progress_cb(idx - 1, total_rows, 'import', f'Processing row {idx}/{total_rows}')
                if cancel_check and cancel_check():
                    conn.rollback()
                    raise HTTPException(status_code=499, detail='Job cancelled')

                values = []
                for col in insert_columns:
                    val = row.get(col)
                    if val == '':
                        val = None
                    values.append(val)

                savepoint = f'sp_{idx}'
                cur.execute(f'SAVEPOINT {savepoint}')
                try:
                    placeholders = ', '.join(['%s'] * len(insert_columns))
                    col_sql = ', '.join(qident(c) for c in insert_columns)
                    cur.execute(
                        f'INSERT INTO {qident(schema)}.{qident(table)} ({col_sql}) VALUES ({placeholders})',
                        tuple(values),
                    )
                    inserted += 1
                except Exception as exc:
                    cur.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
                    diag = getattr(exc, 'diag', None)
                    constraint = getattr(diag, 'constraint_name', None) if diag else None
                    col_name = getattr(diag, 'column_name', None) if diag else None
                    code = getattr(exc, 'sqlstate', None) or exc.__class__.__name__.lower()
                    msg = str(exc).strip()
                    violations.append(_violation(line=idx + 1, column=col_name, code=code, message=msg, constraint=constraint))
                    if rows_inserted_before_failure == 0:
                        rows_inserted_before_failure = inserted
                finally:
                    cur.execute(f'RELEASE SAVEPOINT {savepoint}')

            if violations:
                conn.rollback()
            else:
                conn.commit()

    elapsed_ms = int((time.monotonic() - started) * 1000)
    if progress_cb:
        progress_cb(total_rows, max(total_rows, 1), 'done' if not violations else 'failed', 'CSV import finished')

    ok = not violations
    return {
        'ok': ok,
        'detail': 'CSV imported successfully' if ok else 'CSV import failed',
        'schema': schema,
        'table': table,
        'mode': mode,
        'filename': filename,
        'rows_inserted': inserted if ok else 0,
        'rows_skipped': len(violations),
        'rows_deleted_by_truncate': rows_deleted_by_truncate,
        'rows_inserted_before_failure': rows_inserted_before_failure if violations else inserted,
        'elapsed_ms': elapsed_ms,
        'violations': violations,
    }
