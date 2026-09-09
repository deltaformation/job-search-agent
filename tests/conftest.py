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
            conn.execute((root / "db/migrations/002_tailoring_and_provenance.sql").read_text())
            conn.execute((root / "db/seeds/001_candidate_seed.sql").read_text())
        yield repo
    finally:
        with base.get_connection() as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def clean_db(isolated_repo: JobRepository) -> JobRepository:
    return isolated_repo


@pytest.fixture
def candidate_data():
    return {
        "id": "cand_001",
        "full_name": "Mouad Atfi",
        "headline": "Senior Technical Product Manager",
        "email": "mouad@example.com",
        "phone": "+1-647-000-0000",
        "location": "Toronto, ON, Canada",
        "target_titles": ["Senior Product Manager", "Technical Product Manager"],
        "work_experience": [
            {
                "id": "exp_001",
                "company": "FinTech Cloud Solutions",
                "role": "Senior Technical Product Manager",
                "start_date": "2021-03-01",
                "end_date": None,
                "is_current": True
            },
            {
                "id": "exp_002",
                "company": "Enterprise SaaS Inc.",
                "role": "Product Manager, Technical",
                "start_date": "2018-06-01",
                "end_date": "2021-02-28",
                "is_current": False
            }
        ],
        "verified_facts": [
            {
                "fact_id": "fact_001",
                "work_experience_id": "exp_001",
                "text": "Architected and launched a distributed multi-region API platform reducing p99 latency by 42% while scaling to 50M+ daily requests.",
                "technologies": ["AWS", "PostgreSQL", "Kafka", "REST APIs", "Kubernetes"],
                "metrics": ["42% latency reduction", "50M daily requests"],
                "verification_status": "approved"
            },
            {
                "fact_id": "fact_002",
                "work_experience_id": "exp_001",
                "text": "Spearheaded enterprise developer portal monetization strategy, driving $3.2M ARR in new customer contract value within 14 months of release.",
                "technologies": ["Stripe API", "GraphQL", "OAuth2", "Data Analytics"],
                "metrics": ["$3.2M ARR", "14 months"],
                "verification_status": "approved"
            }
        ],
        "skills": [
            {"name": "Technical Product Management", "verified": True},
            {"name": "AWS", "verified": True},
            {"name": "PostgreSQL", "verified": True}
        ],
        "education": [
            {
                "degree": "Bachelor of Science",
                "field_of_study": "Computer Science",
                "institution": "University of Toronto"
            }
        ],
        "credentials": []
    }
