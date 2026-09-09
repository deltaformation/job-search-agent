#!/usr/bin/env python3
"""
Initialize the PostgreSQL schema. Synthetic candidate data is opt-in and is
intended only for disposable development databases.
"""
import os
import sys
import argparse
from pathlib import Path
import psycopg

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.migrator import DatabaseMigrator

DB_URL = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")

def init_database(*, with_example_data: bool = False) -> None:
    print("Connecting to configured PostgreSQL database...")
    migrator = DatabaseMigrator(db_url=DB_URL)

    # 1. Run migrations via transactional migrator ledger
    print("Running database migrations...")
    applied = migrator.apply_pending()
    if applied:
        print(f"Applied migrations: {', '.join(applied)}")
    else:
        print("Schema is already up-to-date.")

    if not with_example_data:
        print("Candidate data was not seeded. Load the reviewed canonical profile separately when needed.")
        print("Run: .venv/bin/python scripts/load_candidate_profile.py --confirm-replace")
        print("Database initialization complete.")
        return

    # 2. Run synthetic example data only when explicitly requested.
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM candidate_profile LIMIT 1;")
            if cur.fetchone():
                print("Candidate profile already exists. Skipping seeds to preserve live candidate data.")
                print("Database initialization complete.")
                return

            print("No candidate profile found. Applying synthetic example data...")
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
    parser = argparse.ArgumentParser(description="Initialize the job-system database schema")
    parser.add_argument(
        "--with-example-data",
        action="store_true",
        help="Load synthetic candidate data into a disposable development database",
    )
    init_database(with_example_data=parser.parse_args().with_example_data)
