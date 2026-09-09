#!/usr/bin/env python3
"""
Environment diagnostics for Job Search Operating System.
Verifies Python 3.11+, PostgreSQL 16 connectivity, Google Chrome, and required dependencies
without modifying system state or automatically installing packages.
"""
import sys
import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

def check_python() -> bool:
    v = sys.version_info
    print(f"Python Version: {v.major}.{v.minor}.{v.micro}", end=" ")
    if v.major == 3 and v.minor >= 11:
        print("[OK]")
        return True
    else:
        print("[FAIL] (Requires Python 3.11+)")
        return False

def check_postgres() -> bool:
    db_url = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")
    print(f"PostgreSQL ({db_url}):", end=" ")
    try:
        import psycopg
        with psycopg.connect(db_url, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SHOW server_version;")
                ver = cur.fetchone()[0]
                print(f"[OK] (Server: {ver})")
                return True
    except Exception as exc:
        print(f"[FAIL] ({exc})")
        return False

def check_chrome() -> bool:
    candidates = [
        os.getenv("CHROME_PATH", ""),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
    ]
    found = next((p for p in candidates if p and Path(p).is_file() and os.access(p, os.X_OK)), None)
    print("Google Chrome / Headless Browser:", end=" ")
    if found:
        print(f"[OK] ({found})")
        return True
    else:
        print("[FAIL] (Google Chrome executable not found for PDF rendering)")
        return False

def check_dependencies() -> bool:
    packages = [
        ("psycopg", "psycopg"),
        ("pandas", "pandas"),
        ("jobspy", "python-jobspy"),
        ("fastmcp", "fastmcp"),
        ("pydantic", "pydantic"),
        ("yaml", "pyyaml"),
        ("pypdf", "pypdf"),
        ("jinja2", "jinja2"),
    ]
    all_ok = True
    print("Core Python Modules:")
    for mod_name, pkg_label in packages:
        try:
            __import__(mod_name)
            print(f"  - {pkg_label}: [OK]")
        except ImportError:
            print(f"  - {pkg_label}: [FAIL] (Not installed)")
            all_ok = False
    return all_ok

def main() -> int:
    print("=" * 60)
    print("Job Search OS - Environment Diagnostics")
    print("=" * 60)
    p_ok = check_python()
    db_ok = check_postgres()
    c_ok = check_chrome()
    dep_ok = check_dependencies()
    print("=" * 60)
    all_healthy = p_ok and db_ok and c_ok and dep_ok
    if all_healthy:
        print("Status: ALL CHECKS PASSED. System is ready.")
        return 0
    else:
        print("Status: DIAGNOSTICS DETECTED ISSUES. Review above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
