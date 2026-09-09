import os
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg import sql
import pytest

from services.memory.migrator import DatabaseMigrator, MigrationIntegrityError, MigrationLockError, compute_checksum

@pytest.fixture
def isolated_db_schema():
    db_url = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")
    schema_name = f"test_migrator_{uuid4().hex}"
    with psycopg.connect(db_url) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
    try:
        yield db_url, schema_name
    finally:
        with psycopg.connect(db_url) as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema_name)))

def test_migrator_reconcile_and_tamper(isolated_db_schema, tmp_path):
    db_url, schema = isolated_db_schema
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()

    # Create migration 001
    m1_file = migrations_dir / "001_test.sql"
    m1_file.write_text(f"""
        CREATE TABLE {schema}.dummy_table (
            id SERIAL PRIMARY KEY,
            name VARCHAR(50)
        );
    """)

    migrator = DatabaseMigrator(db_url=db_url, migrations_dir=migrations_dir, search_path=schema)

    # Apply migration
    applied = migrator.apply_pending()
    assert "001_test.sql" in applied

    # Second run should apply 0
    applied_again = migrator.apply_pending()
    assert len(applied_again) == 0

    # Tamper with migration file on disk
    m1_file.write_text(f"""
        CREATE TABLE {schema}.dummy_table (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) -- TAMPERED
        );
    """)

    # Should raise MigrationIntegrityError
    with pytest.raises(MigrationIntegrityError, match="checksum mismatch"):
        migrator.apply_pending()

def test_migrator_advisory_lock(isolated_db_schema, tmp_path):
    db_url, schema = isolated_db_schema
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "001_test.sql").write_text("SELECT 1;")

    migrator = DatabaseMigrator(db_url=db_url, migrations_dir=migrations_dir, search_path=schema)

    # Hold the advisory lock manually in a separate connection
    from services.memory.migrator import ADVISORY_LOCK_ID
    with psycopg.connect(db_url) as blocker_conn:
        with blocker_conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(%s);", (ADVISORY_LOCK_ID,))
        blocker_conn.commit()

        # Attempt to run migrations should fail with MigrationLockError
        with pytest.raises(MigrationLockError):
            migrator.apply_pending()

        # Unlock
        with blocker_conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s);", (ADVISORY_LOCK_ID,))
        blocker_conn.commit()

    # Now it should succeed
    applied = migrator.apply_pending()
    assert "001_test.sql" in applied
