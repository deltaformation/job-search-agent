#!/usr/bin/env python3
"""
Migration-only entrypoint for PostgreSQL database schema upgrades.
Maintains schema_migrations ledger with SHA256 checksums and serializes
concurrent runs via advisory locks.
"""
import sys
import os
import argparse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.migrator import DatabaseMigrator, MigrationIntegrityError, MigrationLockError

def main() -> int:
    parser = argparse.ArgumentParser(description="Database Migration Runner")
    parser.add_argument("--status", action="store_true", help="Display current migration status")
    parser.add_argument("--migrate", action="store_true", help="Apply pending forward migrations")
    parser.add_argument("--reconcile", action="store_true", help="Reconcile existing historical schema without migrating")
    parser.add_argument("--db-url", type=str, default=None, help="Database connection URL")

    args = parser.parse_args()

    migrator = DatabaseMigrator(db_url=args.db_url)

    if args.status or (not args.migrate and not args.reconcile):
        print("Migration Ledger Status:")
        print("-" * 75)
        print(f"{'Migration':<35} {'Status':<18} {'Applied At'}")
        print("-" * 75)
        try:
            statuses = migrator.get_status()
            for s in statuses:
                applied_str = str(s["applied_at"]) if s["applied_at"] else "-"
                status_label = s["status"].upper()
                print(f"{s['migration']:<35} {status_label:<18} {applied_str}")
            print("-" * 75)
        except Exception as exc:
            print(f"Error checking status: {exc}")
            return 1

    if args.reconcile:
        print("Reconciling existing installation...")
        import psycopg
        from psycopg.rows import dict_row
        try:
            with psycopg.connect(migrator.db_url, row_factory=dict_row) as conn:
                adopted = migrator.reconcile_existing_installation(conn)
                conn.commit()
                if adopted:
                    print(f"Adopted {len(adopted)} migrations: {', '.join(adopted)}")
                else:
                    print("No existing migrations needed adoption.")
        except Exception as exc:
            print(f"Reconciliation failed: {exc}")
            return 1

    if args.migrate:
        print("Applying pending migrations...")
        try:
            applied = migrator.apply_pending()
            if applied:
                print(f"Successfully applied {len(applied)} migrations: {', '.join(applied)}")
            else:
                print("Database is already up-to-date. No migrations applied.")
        except (MigrationIntegrityError, MigrationLockError) as exc:
            print(f"Migration error: {exc}")
            return 1
        except Exception as exc:
            print(f"Unexpected migration failure: {exc}")
            return 1

    return 0

if __name__ == "__main__":
    sys.exit(main())
