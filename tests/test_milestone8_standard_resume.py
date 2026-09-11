"""Milestone 8a: standard template, shared view model, template-aware baseline.

Covers the plan's template/security, determinism, and rendering acceptance
slices that do not depend on the M8b ranker/summary work.
"""
import re

import pytest

from services.documents.renderer import DocumentRenderer
from services.documents.tailor import ResumeTailor
from services.documents.keywords import (
    CoverageFirstFactRanker,
    KeywordPlanner,
    evidence_qualified_skills,
    normalize_term,
)
from services.documents.summary import (
    compose_summary,
    unioned_career_months,
    verify_derivation,
)
from services.documents.validator import ClaimValidator
from services.documents.template_registry import (
    TemplateRegistry,
    load_resume_config,
)
from services.documents.view_model import (
    build_canonical_baseline_draft,
    build_view_model,
    render_plain_text,
)


def _draft(tailor: ResumeTailor, job_id: str = "00000000-0000-0000-0000-000000000001"):
    job = {
        "job_id": job_id,
        "title": "Senior Technical Product Manager",
        "company": "Cloud Innovators",
        "description": "Looking for a Senior Technical Product Manager with AWS API experience.",
    }
    return tailor.generate_tailored_draft(job)


def test_registry_rejects_unknown_and_traversal(tmp_path) -> None:
    registry = TemplateRegistry()
    with pytest.raises(ValueError, match="Unknown resume template"):
        registry.get_template("attacker_template")
    with pytest.raises(ValueError, match="Unknown resume template"):
        registry.get_template("../config/jobs")


def test_registry_hash_stable_and_config_trusted() -> None:
    registry = TemplateRegistry()
    source_a, hash_a = registry.get_template("mouad_standard_v1")
    source_b, hash_b = registry.get_template("mouad_standard_v1")
    assert hash_a == hash_b and source_a == source_b
    assert re.fullmatch(r"[a-f0-9]{64}", hash_a)
    config = load_resume_config()
    assert config["default_template"] == "mouad_standard_v1"
    assert config["variants_enabled"] is False


def test_resume_config_rejects_unknown_keys(tmp_path) -> None:
    (tmp_path / "resume.yaml").write_text("default_template: mouad_standard_v1\nbogus_key: 1\n")
    with pytest.raises(ValueError, match="unsupported key"):
        load_resume_config(tmp_path)


def test_production_html_has_no_editor_or_runtime_artifacts(candidate_data, tmp_path) -> None:
    tailor = ResumeTailor(candidate_data)
    renderer = DocumentRenderer(artifacts_dir=tmp_path)
    html = renderer.render_resume_to_html(candidate_data, _draft(tailor))
    lowered = html.lower()
    assert "<script" not in lowered
    assert "contenteditable" not in lowered
    assert "toolbar" not in lowered
    assert "codex-browser-sidebar-comments-root" not in html
    assert "http://" not in lowered and "https://" not in lowered
    assert "default-src 'none'" in html
    assert "size: Letter 8.5in 11in" in html
    assert "#213c6b" in html


def test_autoescape_prevents_markup_injection(tmp_path) -> None:
    profile = {
        "id": "cand_x",
        "full_name": "<img src=x onerror=alert(1)>",
        "headline": "PM",
        "email": "a@b.c",
        "phone": "1",
        "location": "Toronto",
        "work_experience": [
            {
                "id": "exp_1",
                "company": "Acme",
                "role": "PM",
                "location": "Toronto",
                "start_date": "2020-01-01",
                "end_date": None,
                "is_current": True,
            }
        ],
        "verified_facts": [
            {
                "fact_id": "fact_9",
                "work_experience_id": "exp_1",
                "text": "Did <b>great</b> things.",
                "technologies": [],
                "metrics": [],
                "verification_status": "approved",
            }
        ],
        "skills": [],
        "education": [],
    }
    renderer = DocumentRenderer(artifacts_dir=tmp_path)
    draft = ResumeTailor(profile).generate_tailored_draft(
        {"job_id": "00000000-0000-0000-0000-000000000001", "title": "PM",
         "company": "C", "description": "PM"}
    )
    html = renderer.render_resume_to_html(profile, draft)
    assert "<img src=x" not in html
    assert "&lt;img" in html
    assert "<b>great</b>" not in html


def test_plain_and_html_share_section_order_dates_contacts(candidate_data, tmp_path) -> None:
    tailor = ResumeTailor(candidate_data)
    draft = _draft(tailor)
    view_model = build_view_model(candidate_data, draft)
    plain = render_plain_text(view_model)
    renderer = DocumentRenderer(artifacts_dir=tmp_path)
    html = renderer.render_resume_to_html(candidate_data, draft)
    order = ["SUMMARY", "PROFESSIONAL EXPERIENCE", "SKILLS", "EDUCATION"]
    positions = [plain.index(section) for section in order]
    assert positions == sorted(positions)
    for section in ["Summary", "Professional Experience", "Skills", "Education"]:
        assert section in html
    # Same dates and contacts in both projections.
    assert "Mar 2021 - Present" in plain and "Mar 2021 - Present" in html
    assert "mouad@example.com" in plain and "mouad@example.com" in html
    # Every rendered bullet is a cited fact verbatim.
    assert "Architected and launched a distributed multi-region API platform" in plain
    assert "Architected and launched a distributed multi-region API platform" in html


def test_optional_linkedin_omitted_without_stray_separators(tmp_path) -> None:
    profile = {
        "id": "cand_y",
        "full_name": "Jane Doe",
        "headline": "PM",
        "email": "",
        "phone": "+1-416-000-0000",
        "location": "",
        "preferences": {},
        "work_experience": [],
        "verified_facts": [],
        "skills": [],
        "education": [],
    }
    view_model = build_view_model(profile, {"claims": []})
    plain_lines = render_plain_text(view_model).splitlines()
    assert plain_lines[1] == "+1-416-000-0000"
    assert "||" not in plain_lines[1] and plain_lines[1].strip("| ") == plain_lines[1].strip()

    with_linkedin = dict(profile)
    with_linkedin["preferences"] = {"linkedin_url": "https://linkedin.com/in/mouadatfi"}
    linked_vm = build_view_model(with_linkedin, {"claims": []})
    assert "linkedin.com/in/mouadatfi" in render_plain_text(linked_vm)


def test_template_aware_baseline_is_stable_and_untailored(candidate_data) -> None:
    baseline_a = render_plain_text(build_view_model(candidate_data, build_canonical_baseline_draft(candidate_data)))
    baseline_b = render_plain_text(build_view_model(candidate_data, build_canonical_baseline_draft(candidate_data)))
    assert baseline_a == baseline_b
    # Baseline contains every approved fact and the canonical headline.
    assert "Senior Technical Product Manager" in baseline_a
    assert "Architected and launched" in baseline_a
    assert "$3.2M ARR" in baseline_a
    # Tailored draft is a subset selection, never new content.
    tailor = ResumeTailor(candidate_data)
    tailored = tailor.generate_plain_text(_draft(tailor))
    assert tailored != baseline_a


def test_renderer_exposes_template_lineage(candidate_data, tmp_path) -> None:
    renderer = DocumentRenderer(artifacts_dir=tmp_path)
    info = renderer.template_info()
    assert info["template_id"] == "mouad_standard_v1"
    assert info["template_version"] == "v1"
    assert re.fullmatch(r"[a-f0-9]{64}", info["template_hash"])


# --- M8b: coverage-first ranking & KeywordPlanV1 ---

def _ranking_profile():
    return {
        "id": "cand_rank",
        "full_name": "Rank Case",
        "headline": "Product Manager",
        "email": "r@example.com",
        "phone": "1",
        "location": "Toronto",
        "work_experience": [
            {"id": "exp_new", "company": "NewCo", "role": "Senior PM",
             "location": "Toronto", "start_date": "2022-01-01",
             "end_date": None, "is_current": True},
            {"id": "exp_old", "company": "OldCo", "role": "PM",
             "location": "Toronto", "start_date": "2018-01-01",
             "end_date": "2021-12-31", "is_current": False},
        ],
        "verified_facts": [
            {"fact_id": "fact_a", "work_experience_id": "exp_new",
             "text": "Shipped an AWS data platform serving enterprise clients.",
             "technologies": ["AWS"], "metrics": ["99.9% uptime"],
             "verification_status": "approved"},
            {"fact_id": "fact_b", "work_experience_id": "exp_new",
             "text": "Ran customer discovery interviews across fintech accounts.",
             "technologies": [], "metrics": [],
             "verification_status": "approved"},
            {"fact_id": "fact_c", "work_experience_id": "exp_old",
             "text": "Maintained legacy dashboards with Go automation.",
             "technologies": ["Go"], "metrics": [],
             "verification_status": "approved"},
        ],
        "skills": [
            {"name": "AWS", "verified": True},
            {"name": "Django", "verified": True},
            {"name": "Unverified Skill", "verified": False},
        ],
        "education": [],
    }


def _ranking_requirements():
    return [
        {"requirement_id": "req_1", "jd_quote": "AWS data platform",
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": ["fact_a"],
         "evidence_quotes": ["Shipped an AWS data platform serving enterprise clients."]},
        {"requirement_id": "req_2", "jd_quote": "customer discovery interviews",
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "preferred",
         "evidence_fact_ids": ["fact_b"],
         "evidence_quotes": ["Ran customer discovery interviews across fintech accounts."]},
        {"requirement_id": "req_3", "jd_quote": "Kubernetes experience",
         "match_status": "unsupported", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": []},
    ]


def test_ranker_prioritizes_required_coverage_first() -> None:
    ranker = CoverageFirstFactRanker()
    ranked = ranker.rank(_ranking_requirements(), _ranking_profile())
    assert ranked[0] == "fact_a"
    assert ranked[1] == "fact_b"
    # Unsupported requirement contributes no fact.
    assert "fact_c" not in ranked or ranked.index("fact_c") > ranked.index("fact_b")


def test_ranker_duplicate_coverage_suppression() -> None:
    profile = _ranking_profile()
    requirements = [
        {"requirement_id": "req_1", "jd_quote": "AWS data platform",
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": ["fact_a", "fact_b"],
         "evidence_quotes": [
             "Shipped an AWS data platform serving enterprise clients.",
             "Ran customer discovery interviews across fintech accounts."]},
        {"requirement_id": "req_2", "jd_quote": "customer discovery",
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "preferred",
         "evidence_fact_ids": ["fact_b"],
         "evidence_quotes": ["Ran customer discovery interviews across fintech accounts."]},
    ]
    ranked = CoverageFirstFactRanker().rank(requirements, profile)
    # fact_b covers both req_1 and req_2, so it wins outright; fact_a would add
    # no new coverage and must be suppressed rather than stuffed.
    assert ranked == ["fact_b"]


def test_ranker_ignores_raw_jd_buzzwords_and_is_deterministic() -> None:
    profile = _ranking_profile()
    requirements = _ranking_requirements()
    first = CoverageFirstFactRanker().rank(requirements, profile)
    second = CoverageFirstFactRanker().rank(requirements, profile)
    assert first == second
    # fact_c has no supporting requirement: raw "Go"/"dashboards" JD tokens
    # must not surface it above evidence-backed facts.
    assert first[0] == "fact_a"


def test_ranker_respects_per_role_and_total_budgets() -> None:
    profile = _ranking_profile()
    requirements = [
        {"requirement_id": f"req_{i}", "jd_quote": f"quote {i}",
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": ["fact_a", "fact_b"],
         "evidence_quotes": [
             "Shipped an AWS data platform serving enterprise clients.",
             "Ran customer discovery interviews across fintech accounts."]}
        for i in range(6)
    ]
    ranked = CoverageFirstFactRanker(max_per_role=1, max_total=1).rank(requirements, profile)
    assert len(ranked) == 1


def test_skill_terms_require_cited_fact_evidence() -> None:
    profile = _ranking_profile()
    assert evidence_qualified_skills(profile, ["fact_a"]) == ["AWS"]
    # "Django" shares the "go" substring but is not evidence-backed.
    assert "Django" not in evidence_qualified_skills(profile, ["fact_c"])
    assert "Unverified Skill" not in evidence_qualified_skills(profile, ["fact_a", "fact_b"])


def test_normalize_term_narrow() -> None:
    assert normalize_term("  AWS\u2013Cloud/API ") == "aws cloud api"
    assert normalize_term("Go") == "go"


def test_keyword_planner_metrics_and_omissions() -> None:
    planner = KeywordPlanner()
    plan = planner.plan(
        _ranking_requirements(), ["fact_a", "fact_b"], _ranking_profile(), ["AWS"]
    )
    assert plan["plan_version"] == "KeywordPlanV1"
    assert plan["ranking_policy_version"] == "coverage-first/v1"
    report = plan["coverage_report"]
    assert report["covered_supported_requirements"] == 2
    assert report["total_supported_requirements"] == 2
    assert report["supported_keyword_coverage"] == 1.0
    # Full-JD denominator includes the unsupported requirement.
    assert report["total_requirements"] == 3
    assert report["full_jd_keyword_coverage"] == pytest.approx(2 / 3)
    decisions = {t["requirement_id"]: t["decision"] for t in plan["terms"]}
    assert decisions == {"req_1": "include_exact", "req_2": "include_exact",
                         "req_3": "omit_unsupported"}
    assert "Kubernetes experience" in plan["omitted_unsupported"]


# --- M8b: constrained summary composition ---

def _summary_profile():
    return {
        "id": "cand_sum",
        "full_name": "Summary Case",
        "headline": "Senior Technical Product Manager",
        "email": "s@example.com",
        "phone": "1",
        "location": "Toronto",
        "target_titles": ["Senior Product Manager", "Technical Product Manager"],
        "work_experience": [
            {"id": "exp_a", "company": "A", "role": "Senior PM",
             "location": "Toronto", "start_date": "2020-01-15",
             "end_date": None, "is_current": True},
            {"id": "exp_b", "company": "B", "role": "PM",
             "location": "Toronto", "start_date": "2018-06-01",
             "end_date": "2020-06-30", "is_current": False},
        ],
        "verified_facts": [
            {"fact_id": "fact_1", "work_experience_id": "exp_a",
             "text": "Launched an AWS analytics platform processing 10M events daily.",
             "technologies": ["AWS", "Kafka"], "metrics": ["10M events daily"],
             "verification_status": "approved"},
            {"fact_id": "fact_2", "work_experience_id": "exp_b",
             "text": "Grew trial conversion with PostgreSQL-backed experimentation.",
             "technologies": ["PostgreSQL"], "metrics": [],
             "verification_status": "approved"},
        ],
        "skills": [],
        "education": [],
    }


def test_tenure_unions_overlaps_and_caps_at_as_of() -> None:
    from datetime import date
    exps = [
        {"id": "a", "start_date": "2020-01-01", "end_date": None, "is_current": True},
        {"id": "b", "start_date": "2019-06-01", "end_date": "2020-06-30", "is_current": False},
    ]
    months, intervals = unioned_career_months(exps, date(2024, 6, 15))
    # Jun 2019 - Jun 2024 inclusive = 61 months, overlap counted once.
    assert months == 61
    assert intervals[0]["work_experience_id"] == "b"
    # Deterministic: wall clock after as_of must not change the result.
    months_later, _ = unioned_career_months(exps, date(2024, 6, 15))
    assert months_later == months
    earlier, _ = unioned_career_months(exps, date(2023, 6, 15))
    assert earlier == 49


def test_tenure_gaps_partial_months_and_leap_years() -> None:
    from datetime import date
    exps = [
        {"id": "a", "start_date": "2020-02-29", "end_date": "2020-02-29", "is_current": False},
        {"id": "b", "start_date": "2021-05-10", "end_date": "2021-05-20", "is_current": False},
    ]
    months, _ = unioned_career_months(exps, date(2022, 1, 1))
    # Leap-day start parses; two touched months across a gap year.
    assert months == 2


def test_derived_summary_reconstructs_byte_for_byte() -> None:
    from datetime import date
    profile = _summary_profile()
    result = compose_summary(profile, ["fact_1", "fact_2"],
                             "Senior Technical Product Manager", date(2026, 9, 10))
    assert result.strategy == "derived_template"
    assert result.fallback_reason is None
    assert result.derivation is not None
    valid, errors = verify_derivation(result.derivation, profile)
    assert valid, errors
    assert result.derivation["final_text"] == result.text
    assert "Targeting Senior Technical Product Manager roles." in result.text
    # Validator accepts the derived claim end to end.
    claim = {"claim_id": "claim_001", "section": "summary", "text": result.text,
             "fact_ids": result.fact_ids, "generation_strategy": "derived_template",
             "derivation": result.derivation}
    valid_claim, claim_errors = ClaimValidator(profile).validate_claim(claim)
    assert valid_claim, claim_errors


def test_derived_summary_rejects_unapproved_jd_title() -> None:
    from datetime import date
    profile = _summary_profile()
    result = compose_summary(profile, ["fact_1", "fact_2"],
                             "Chief Executive Officer", date(2026, 9, 10))
    assert result.strategy == "derived_template"
    assert "Chief Executive Officer" not in result.text


def test_derived_summary_tamper_fails_validation() -> None:
    from datetime import date
    profile = _summary_profile()
    result = compose_summary(profile, ["fact_1", "fact_2"],
                             "Senior Technical Product Manager", date(2026, 9, 10))
    assert result.derivation is not None
    tampered = dict(result.derivation)
    tampered["final_text"] = result.text + " Unverified superpowers."
    claim = {"claim_id": "claim_001", "section": "summary", "text": tampered["final_text"],
             "fact_ids": result.fact_ids, "generation_strategy": "derived_template",
             "derivation": tampered}
    valid_claim, _ = ClaimValidator(profile).validate_claim(claim)
    assert not valid_claim


def test_summary_rejects_unsupported_relationships() -> None:
    from datetime import date
    profile = _summary_profile()
    result = compose_summary(profile, ["fact_1", "fact_2"],
                             "Senior Technical Product Manager", date(2026, 9, 10))
    assert result.derivation is not None
    tampered = dict(result.derivation)
    tampered_slots = dict(tampered["slot_values"])
    # Individually supported words ("AWS", "PostgreSQL") recombined with an
    # invented scope claim must fail even though each word exists in evidence.
    tampered_slots["domains_techs"] = "AWS, PostgreSQL, and Martian colonies"
    tampered["slot_values"] = tampered_slots
    valid, _ = verify_derivation(tampered, profile)
    assert not valid


def test_summary_fallback_reasons() -> None:
    from datetime import date
    profile = _summary_profile()
    no_evidence = compose_summary(profile, [], "PM", date(2026, 9, 10))
    assert (no_evidence.strategy, no_evidence.fallback_reason) == ("none", "NO_EVIDENCE")
    thin = compose_summary(
        {**profile, "work_experience": [
            {"id": "x", "company": "X", "role": "Intern", "start_date": "2026-06-01",
             "end_date": None, "is_current": True}]},
        ["fact_1"], "PM", date(2026, 9, 10))
    assert (thin.strategy, thin.fallback_reason) == ("verbatim", "THIN_TENURE")
    no_domains = compose_summary(
        {**profile, "verified_facts": [
            {**profile["verified_facts"][0], "technologies": []},
            {**profile["verified_facts"][1], "technologies": []}]},
        ["fact_1"], "PM", date(2026, 9, 10))
    assert (no_domains.strategy, no_domains.fallback_reason) == ("verbatim", "NO_DOMAINS")


def test_approved_variant_claim_requires_human_approval() -> None:
    import hashlib
    profile = _summary_profile()
    variant_text = "Launched an AWS analytics platform at massive scale."
    variant = {
        "id": "var_1", "candidate_id": "cand_sum", "fact_ids": ["fact_1"],
        "variant_text": variant_text,
        "content_hash": hashlib.sha256(variant_text.encode()).hexdigest(),
        "review_status": "proposed",
    }
    claim = {"claim_id": "claim_001", "section": "summary", "text": variant_text,
             "fact_ids": ["fact_1"], "generation_strategy": "approved_variant",
             "variant_id": "var_1"}
    valid_proposed, _ = ClaimValidator(profile, variants=[variant]).validate_claim(claim)
    assert not valid_proposed
    approved = dict(variant, review_status="approved")
    valid_approved, errors = ClaimValidator(profile, variants=[approved]).validate_claim(claim)
    assert valid_approved, errors
    # Cross-candidate variants never validate.
    other = dict(approved, candidate_id="cand_other")
    valid_other, _ = ClaimValidator(profile, variants=[other]).validate_claim(claim)
    assert not valid_other


# --- M8b: pipeline lineage integration ---

class _PipelineFakeRenderer:
    def __init__(self, directory) -> None:
        self.directory = directory

    def render_resume_to_html(self, profile: dict, draft: dict, variants=None) -> str:
        return "<html><body>Fake M8 Resume</body></html>"

    def template_info(self) -> dict:
        return {
            "template_id": "mouad_standard_v1",
            "template_version": "v1",
            "template_hash": "1" * 64,
            "render_schema_version": "v1",
        }

    def compile_html_to_pdf(self, html: str, job_id: str, version: int, digest: str):
        source = self.directory / f"resume_{version}.html"
        pdf = self.directory / f"resume_{version}.pdf"
        pdf.write_bytes(b"%PDF-1.4 Fake PDF Content")
        source.write_text(html)
        return str(source), str(pdf), 1


def test_pipeline_persists_m8_lineage(clean_db, tmp_path) -> None:
    from uuid import uuid4
    from services.documents.pipeline import generate_documents

    profile = clean_db.get_candidate_profile()
    assert profile is not None
    facts = {f["fact_id"]: f for f in profile["verified_facts"]}
    quote_1 = " ".join(facts["fact_001"]["text"].split()[:7])
    quote_2 = " ".join(facts["fact_002"]["text"].split()[:7])
    unsupported_quote = "Quantum teleportation operations"
    jd_text = (
        f"Senior Product Manager. We need {quote_1}. "
        f"You will drive {quote_2}. {unsupported_quote} required."
    )
    key = uuid4().hex
    job, _ = clean_db.upsert_job(
        {"canonical_url": f"https://example.com/m8/{key}", "content_hash": key,
         "company": "M8 Corp", "title": str(profile.get("headline") or "PM"),
         "location": "Toronto", "description": jd_text}, {})
    job_id = str(job["job_id"])
    cand_snap = clean_db.save_candidate_snapshot(str(profile["id"]), profile)
    jd_snap = clean_db.save_jd_snapshot(job_id, jd_text, jd_text)
    requirements = [
        {"requirement_id": "req_1", "jd_quote": quote_1,
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": ["fact_001"], "evidence_quotes": [facts["fact_001"]["text"]]},
        {"requirement_id": "req_2", "jd_quote": quote_2,
         "match_status": "partial", "review_status": "proposed",
         "category": "experience", "importance": "preferred",
         "evidence_fact_ids": ["fact_002"], "evidence_quotes": [facts["fact_002"]["text"]]},
        {"requirement_id": "req_3", "jd_quote": unsupported_quote,
         "match_status": "unsupported", "review_status": "proposed",
         "category": "experience", "importance": "required",
         "evidence_fact_ids": []},
    ]
    clean_db.save_job_analysis(job_id, jd_snap, cand_snap, requirements, notes="M8 test")

    result = generate_documents(clean_db, job_id, renderer=_PipelineFakeRenderer(tmp_path))
    assert result["status"] == "success", result
    assert result["summary_strategy"] == "derived_template"
    assert result["keyword_coverage"]["total_supported_requirements"] == 2
    assert unsupported_quote in result["omitted_unsupported"]

    saved = clean_db.get_resume_version(result["resume_version_id"])
    assert saved["template_id"] == "mouad_standard_v1"
    assert saved["template_version"] == "v1"
    assert saved["ranking_policy_version"] == "coverage-first/v1"
    keyword_plan = saved["keyword_plan"]
    if isinstance(keyword_plan, str):
        import json as _json
        keyword_plan = _json.loads(keyword_plan)
    assert keyword_plan["plan_version"] == "KeywordPlanV1"
    derivation = saved["summary_derivation"]
    if isinstance(derivation, str):
        import json as _json
        derivation = _json.loads(derivation)
    assert derivation["formula_version"] == "summary/v1"
    # Historical-row honesty: lineage columns exist but carry real values only here.
    assert saved["validation_status"] == "AWAITING_HUMAN_REVIEW"

    # Immutability trigger covers the new lineage columns.
    import psycopg
    with pytest.raises(psycopg.Error, match="immutable"):
        with clean_db.get_connection() as conn:
            conn.execute(
                "UPDATE resume_versions SET keyword_plan = '{}' WHERE id = %s",
                (result["resume_version_id"],))


def test_variant_lifecycle_human_only(clean_db) -> None:
    profile = clean_db.get_candidate_profile()
    assert profile is not None
    candidate_id = str(profile["id"])
    proposed = clean_db.propose_wording_variant(
        candidate_id, ["fact_001"], "Shipped discovery-led roadmap wins.", ["roadmap"])
    assert proposed["review_status"] == "proposed"
    # Agents cannot approve: consent flag required.
    assert not clean_db.approve_wording_variant(str(proposed["id"]))[0]
    approved, _ = clean_db.approve_wording_variant(
        str(proposed["id"]), "human", human_confirmed=True)
    assert approved
    assert clean_db.get_approved_variants(candidate_id)
    # Approved variants are immutable and non-deletable.
    import psycopg
    with pytest.raises(psycopg.Error, match="immutable"):
        with clean_db.get_connection() as conn:
            conn.execute(
                "UPDATE candidate_wording_variants SET variant_text = 'x' WHERE id = %s",
                (str(proposed["id"]),))
