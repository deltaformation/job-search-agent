import os
import hashlib
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
import psycopg
from psycopg import sql
from psycopg.rows import dict_row

logger = logging.getLogger("migrator")

ADVISORY_LOCK_ID = 74829103
DEFAULT_DB_URL = "postgresql://mouadatfi@localhost:5432/job_system"

class MigrationIntegrityError(Exception):
    pass

class MigrationLockError(Exception):
    pass

def compute_checksum(file_path: Path) -> str:
    content = file_path.read_bytes()
    return hashlib.sha256(content).hexdigest()

class DatabaseMigrator:
    def __init__(self, db_url: Optional[str] = None, migrations_dir: Optional[Path] = None, search_path: Optional[str] = None) -> None:
        self.db_url = db_url or os.getenv("DATABASE_URL", DEFAULT_DB_URL)
        base_dir = Path(__file__).resolve().parent.parent.parent
        self.migrations_dir = migrations_dir or (base_dir / "db" / "migrations")
        self.search_path = search_path

    def _get_connection(self) -> psycopg.Connection[Dict[str, Any]]:
        conn = psycopg.connect(self.db_url, row_factory=dict_row)
        if self.search_path:
            conn.execute(
                sql.SQL("SET search_path TO {}, public").format(
                    sql.Identifier(self.search_path)
                )
            )
        return conn

    def _ensure_ledger(self, cur: psycopg.Cursor[Dict[str, Any]]) -> None:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_name VARCHAR(255) PRIMARY KEY,
                checksum_sha256 VARCHAR(64) NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)

    def _check_table_exists(self, cur: psycopg.Cursor[Dict[str, Any]], table_name: str) -> bool:
        cur.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = %s AND table_name = %s
            );
        """, (self.search_path or "public", table_name))
        return cur.fetchone()["exists"]

    def _check_column_exists(self, cur: psycopg.Cursor[Dict[str, Any]], table_name: str, column_name: str) -> bool:
        cur.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s AND column_name = %s
            );
        """, (self.search_path or "public", table_name, column_name))
        return cur.fetchone()["exists"]

    def reconcile_existing_installation(self, conn: psycopg.Connection[Dict[str, Any]]) -> List[str]:
        """
        Adopts migrations 001, 002, 003 if their corresponding schema objects already exist
        in an un-tracked existing database, recording their checksums without rerunning them.
        """
        adopted = []
        with conn.cursor() as cur:
            self._ensure_ledger(cur)

            # Check 001
            m001_file = self.migrations_dir / "001_initial_schema.sql"
            if m001_file.exists():
                cur.execute("SELECT 1 FROM schema_migrations WHERE migration_name = %s;", (m001_file.name,))
                if not cur.fetchone():
                    # Check if 001 tables exist
                    has_jobs = self._check_table_exists(cur, "jobs")
                    has_profile = self._check_table_exists(cur, "candidate_profile")
                    if has_jobs and has_profile:
                        csum = compute_checksum(m001_file)
                        cur.execute("""
                            INSERT INTO schema_migrations (migration_name, checksum_sha256)
                            VALUES (%s, %s);
                        """, (m001_file.name, csum))
                        adopted.append(m001_file.name)
                        logger.info(f"Adopted existing migration: {m001_file.name}")

            # Check 002
            m002_file = self.migrations_dir / "002_tailoring_and_provenance.sql"
            if m002_file.exists():
                cur.execute("SELECT 1 FROM schema_migrations WHERE migration_name = %s;", (m002_file.name,))
                if not cur.fetchone():
                    has_snapshots = self._check_table_exists(cur, "candidate_profile_snapshots")
                    has_val_status = self._check_column_exists(cur, "resume_versions", "validation_status")
                    if has_snapshots and has_val_status:
                        csum = compute_checksum(m002_file)
                        cur.execute("""
                            INSERT INTO schema_migrations (migration_name, checksum_sha256)
                            VALUES (%s, %s);
                        """, (m002_file.name, csum))
                        adopted.append(m002_file.name)
                        logger.info(f"Adopted existing migration: {m002_file.name}")

            # Check 003
            m003_file = self.migrations_dir / "003_document_integrity.sql"
            if m003_file.exists():
                cur.execute("SELECT 1 FROM schema_migrations WHERE migration_name = %s;", (m003_file.name,))
                if not cur.fetchone():
                    has_pdf_hash = self._check_column_exists(cur, "resume_versions", "pdf_hash")
                    if has_pdf_hash:
                        csum = compute_checksum(m003_file)
                        cur.execute("""
                            INSERT INTO schema_migrations (migration_name, checksum_sha256)
                            VALUES (%s, %s);
                        """, (m003_file.name, csum))
                        adopted.append(m003_file.name)
                        logger.info(f"Adopted existing migration: {m003_file.name}")

        return adopted

    def get_status(self) -> List[Dict[str, Any]]:
        migration_files = sorted(self.migrations_dir.glob("*.sql"))
        results = []

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                self._ensure_ledger(cur)
                cur.execute("SELECT migration_name, checksum_sha256, applied_at FROM schema_migrations;")
                applied = {r["migration_name"]: r for r in cur.fetchall()}

                for m_file in migration_files:
                    file_csum = compute_checksum(m_file)
                    if m_file.name in applied:
                        db_csum = applied[m_file.name]["checksum_sha256"]
                        if db_csum == file_csum:
                            status = "applied"
                        else:
                            status = "checksum_mismatch"
                        results.append({
                            "migration": m_file.name,
                            "status": status,
                            "applied_at": applied[m_file.name]["applied_at"],
                            "file_checksum": file_csum,
                            "db_checksum": db_csum,
                        })
                    else:
                        results.append({
                            "migration": m_file.name,
                            "status": "pending",
                            "applied_at": None,
                            "file_checksum": file_csum,
                            "db_checksum": None,
                        })
        return results

    def apply_pending(self) -> List[str]:
        """
        Acquires an advisory lock, reconciles existing installation if necessary,
        verifies checksums of applied migrations, and executes pending migrations transactionally.
        """
        migration_files = sorted(self.migrations_dir.glob("*.sql"))
        applied_names = []

        with self._get_connection() as conn:
            # 1. Acquire session-level advisory lock
            with conn.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(%s) AS locked;", (ADVISORY_LOCK_ID,))
                row = cur.fetchone()
                if not row or not row["locked"]:
                    raise MigrationLockError("Could not acquire migration advisory lock. Another migration may be running.")

            try:
                # 2. Reconcile existing installation if needed
                self.reconcile_existing_installation(conn)
                conn.commit()

                # 3. Check for checksum mismatches
                with conn.cursor() as cur:
                    cur.execute("SELECT migration_name, checksum_sha256 FROM schema_migrations;")
                    applied = {r["migration_name"]: r["checksum_sha256"] for r in cur.fetchall()}

                for m_file in migration_files:
                    file_csum = compute_checksum(m_file)
                    if m_file.name in applied:
                        db_csum = applied[m_file.name]
                        if file_csum != db_csum:
                            raise MigrationIntegrityError(
                                f"Migration checksum mismatch for '{m_file.name}'! "
                                f"Database has {db_csum}, but file on disk is {file_csum}. "
                                "Applied migrations must never be altered."
                            )

                # 4. Apply pending migrations transactionally one-by-one
                for m_file in migration_files:
                    if m_file.name not in applied:
                        logger.info(f"Applying migration: {m_file.name}")
                        file_csum = compute_checksum(m_file)
                        sql_content = m_file.read_text(encoding="utf-8")

                        # Each migration runs in its own transaction
                        with conn.transaction():
                            with conn.cursor() as cur:
                                cur.execute(sql_content)
                                cur.execute("""
                                    INSERT INTO schema_migrations (migration_name, checksum_sha256)
                                    VALUES (%s, %s);
                                """, (m_file.name, file_csum))

                        applied_names.append(m_file.name)
                        logger.info(f"Successfully applied: {m_file.name}")

            finally:
                # Always release advisory lock
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_unlock(%s);", (ADVISORY_LOCK_ID,))
                conn.commit()

        return applied_names
