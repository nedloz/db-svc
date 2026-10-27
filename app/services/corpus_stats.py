"""Размер корпуса и графа для метрик Prometheus (gauge pochemuchnik_corpus_objects)."""

from app.metrics import CORPUS_OBJECTS
from app.services.pg import get_conn

_COUNTS_SQL = """
SELECT 'documents', count(*) FROM library.documents
UNION ALL SELECT 'chunks', count(*) FROM library.chunks
UNION ALL SELECT 'graph_nodes', count(*) FROM graph.entities
UNION ALL SELECT 'graph_edges', count(*) FROM graph.relations
"""


def refresh_corpus_counts() -> None:
    """Блокирующая функция (psycopg): вызывать через пул потоков."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_COUNTS_SQL)
            for kind, count in cur.fetchall():
                CORPUS_OBJECTS.labels(kind=kind).set(count)
