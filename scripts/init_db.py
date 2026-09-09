#!/usr/bin/env python3
"""
Initialize PostgreSQL database schema and initial candidate seed data.
Uses transactional DatabaseMigrator ledger and guards against rerunning seeds on existing candidate profiles.
"""
import os
import sys
from pathlib import Path
import psycopg

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.migrator import DatabaseMigrator

DB_URL = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")

def init_database() -> None:
    print(f"Connecting to database: {DB_URL}")
    migrator = DatabaseMigrator(db_url=DB_URL)

    # 1. Run migrations via transactional migrator ledger
    print("Running database migrations...")
    applied = migrator.apply_pending()
    if applied:
        print(f"Applied migrations: {', '.join(applied)}")
    else:
        print("Schema is already up-to-date.")

    # 2. Run seeds only on fresh installations
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM candidate_profile LIMIT 1;")
            if cur.fetchone():
                print("Candidate profile already exists. Skipping seeds to preserve live candidate data.")
                return

            print("No candidate profile found. Applying initial seeds...")
            seeds_dir = BASE_DIR / "db" / "seeds"
            seed_files = sorted(seeds_dir.glob("*.sql"))
            for s_file in seed_files:
                print(f"Applying seed: {s_file.name}")
                with open(s_file, "r", encoding="utf-8") as f:
                    sql = f.read()
                    cur.execute(sql)
                print(f"Applied {s_file.name} successfully.")
            conn.commit()

    print("Database initialization complete.")

if __name__ == "__main__":
    init_database()
