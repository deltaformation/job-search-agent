from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
import pytest

from services.memory.repository import JobRepository


@pytest.fixture(scope="module")
def isolated_repo() -> Iterator[JobRepository]:
    """Exercise real PostgreSQL without modifying the candidate's live tables."""
    base = JobRepository()
    schema = f"test_review_{uuid4().hex}"

    class IsolatedRepository(JobRepository):
        def get_connection(self) -> psycopg.Connection:
            conn = super().get_connection()
            conn.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
            return conn

    root = Path(__file__).resolve().parents[1]
    with base.get_connection() as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    repo = IsolatedRepository(base.db_url)
    try:
        with repo.get_connection() as conn:
            conn.execute((root / "db/migrations/001_initial_schema.sql").read_text())
            conn.execute((root / "db/seeds/001_candidate_seed.sql").read_text())
        yield repo
    finally:
        with base.get_connection() as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
