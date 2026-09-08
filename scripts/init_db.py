#!/usr/bin/env python3
"""
Initialize PostgreSQL database schema and initial candidate seed data.
"""
import os
import sys
from pathlib import Path
import psycopg

BASE_DIR = Path(__file__).resolve().parent.parent
DB_URL = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")

def init_database():
    print(f"Connecting to database: {DB_URL}")
    migrations_dir = BASE_DIR / "db" / "migrations"
    seeds_dir = BASE_DIR / "db" / "seeds"

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            # 1. Run migrations
            migration_files = sorted(migrations_dir.glob("*.sql"))
            for m_file in migration_files:
                print(f"Applying migration: {m_file.name}")
                with open(m_file, "r", encoding="utf-8") as f:
                    sql = f.read()
                    cur.execute(sql)
                print(f"Applied {m_file.name} successfully.")

            # 2. Run seeds
            seed_files = sorted(seeds_dir.glob("*.sql"))
            for s_file in seed_files:
                print(f"Applying seed: {s_file.name}")
                with open(s_file, "r", encoding="utf-8") as f:
                    sql = f.read()
                    cur.execute(sql)
                print(f"Applied {s_file.name} successfully.")

    print("Database initialization complete.")

if __name__ == "__main__":
    init_database()
