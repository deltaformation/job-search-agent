#!/usr/bin/env python3
"""
Replace candidate memory with the reviewed canonical profile and career facts.
This is a transactional, human-operated replacement command. Replacing the
profile invalidates older resume snapshots and requires regeneration and review.
"""
import json
import os
import sys
import argparse
from pathlib import Path
from typing import List, Optional
import psycopg

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

DB_URL = os.getenv("DATABASE_URL", "postgresql://mouadatfi@localhost:5432/job_system")

def load_profile(*, human_confirmed: bool = False) -> None:
    if not human_confirmed:
        raise ValueError(
            "Explicit human confirmation is required. Run this script with --confirm-replace."
        )
    print("Connecting to configured PostgreSQL database...")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            # 1. Candidate Profile
            cur.execute("SELECT id FROM candidate_profile LIMIT 1;")
            row = cur.fetchone()
            
            target_titles = [
                "Lead Product Manager",
                "Principal Product Manager",
                "Director of Product",
                "Senior Product Manager",
                "Technical Product Manager",
                "Head of Product"
            ]
            target_locations = [
                "Pickering, ON",
                "Toronto, ON",
                "Greater Toronto Area",
                "Ontario",
                "Remote Canada",
                "Canada"
            ]
            summary = (
                "Product leader with 15 years spanning engineering, consulting, and product management, "
                "focused on AI decisioning and agentic platforms in enterprise and regulated environments. "
                "Owned strategy and P&L for a $150M+ AI portfolio at IBM, built a product organization from zero "
                "at a scaling SaaS company, and has repeatedly taken ambiguous 0-1 platforms from discovery through GTM. "
                "Hands-on builder: prototypes with agentic coding tools, designs MCP integrations, and translates "
                "complex technical architecture into decisions executives can act on."
            )

            if row:
                cand_id = row[0]
                cur.execute("""
                    UPDATE candidate_profile SET
                        full_name = %s,
                        headline = %s,
                        email = %s,
                        phone = %s,
                        location = %s,
                        target_titles = %s::jsonb,
                        target_locations = %s::jsonb,
                        summary = %s,
                        updated_at = NOW()
                    WHERE id = %s;
                """, (
                    "Mouad Atfi",
                    "Product Leader | AI Decisioning, Agentic Platforms & Enterprise Systems",
                    "ma170789@gmail.com",
                    "+1 (416) 828-7602",
                    "Pickering, ON, Canada",
                    json.dumps(target_titles),
                    json.dumps(target_locations),
                    summary,
                    cand_id
                ))
            else:
                cur.execute("""
                    INSERT INTO candidate_profile (
                        full_name, headline, email, phone, location, target_titles, target_locations, summary
                    ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                    RETURNING id;
                """, (
                    "Mouad Atfi",
                    "Product Leader | AI Decisioning, Agentic Platforms & Enterprise Systems",
                    "ma170789@gmail.com",
                    "+1 (416) 828-7602",
                    "Pickering, ON, Canada",
                    json.dumps(target_titles),
                    json.dumps(target_locations),
                    summary
                ))
                cand_id = cur.fetchone()[0]

            print(f"Loaded Candidate Profile ID: {cand_id}")

            # Replace dependent profile tables in one transaction. This changes
            # the candidate snapshot and intentionally invalidates older resumes.
            cur.execute("""
                DELETE FROM achievements WHERE work_experience_id IN (
                    SELECT id FROM work_experience WHERE candidate_id = %s
                );
            """, (cand_id,))
            cur.execute("DELETE FROM work_experience WHERE candidate_id = %s;", (cand_id,))
            cur.execute("DELETE FROM skills WHERE candidate_id = %s;", (cand_id,))
            cur.execute("DELETE FROM education WHERE candidate_id = %s;", (cand_id,))
            cur.execute("DELETE FROM preferences WHERE candidate_id = %s;", (cand_id,))
            cur.execute("DELETE FROM standard_answers WHERE candidate_id = %s;", (cand_id,))

            # 2. Insert Work Experiences
            experiences = [
                {
                    "key": "aot",
                    "company": "AOT Technologies",
                    "role": "Lead Product Manager",
                    "location": "Toronto, Canada",
                    "start_date": "2025-07-01",
                    "end_date": None,
                    "is_current": True,
                    "description": "Leading the product management function, SaaS platform consolidation, and agentic AI capabilities."
                },
                {
                    "key": "ibm",
                    "company": "IBM",
                    "role": "Senior Product Manager",
                    "location": "Toronto, Canada",
                    "start_date": "2021-08-01",
                    "end_date": "2025-07-31",
                    "is_current": False,
                    "description": "Owned strategic vision, roadmap, and GTM execution for a $150M+ annual revenue AI decisioning portfolio with P&L accountability."
                },
                {
                    "key": "odo",
                    "company": "Odotrack",
                    "role": "Product Manager",
                    "location": "Montreal, Canada",
                    "start_date": "2019-11-01",
                    "end_date": "2021-08-31",
                    "is_current": False,
                    "description": "Product management for last-mile delivery tracking, edge telematics, and fleet operations platform."
                },
                {
                    "key": "myr",
                    "company": "MYR POS",
                    "role": "Head of Operations (Product & Growth)",
                    "location": "Montreal, Canada",
                    "start_date": "2017-11-01",
                    "end_date": "2019-12-31",
                    "is_current": False,
                    "description": "Product and growth leadership for fintech point-of-sale and payments platform."
                },
                {
                    "key": "all",
                    "company": "Allagma Technologies",
                    "role": "Consultant",
                    "location": "Montreal, Canada",
                    "start_date": "2013-04-01",
                    "end_date": "2017-11-30",
                    "is_current": False,
                    "description": "Customer-facing consultant translating client problems into product requirements for national retail POS deployments."
                },
                {
                    "key": "fre",
                    "company": "Freelance",
                    "role": "Backend Developer",
                    "location": "Montreal, Canada",
                    "start_date": "2010-07-01",
                    "end_date": "2013-06-30",
                    "is_current": False,
                    "description": "Backend engineering, distributed crawlers, and automation frameworks in Python and Go."
                }
            ]

            exp_ids = {}
            for exp in experiences:
                cur.execute("""
                    INSERT INTO work_experience (
                        candidate_id, company, role, location, start_date, end_date, is_current, description
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id;
                """, (
                    cand_id, exp["company"], exp["role"], exp["location"],
                    exp["start_date"], exp["end_date"], exp["is_current"], exp["description"]
                ))
                exp_ids[exp["key"]] = cur.fetchone()[0]

            print(f"Loaded {len(exp_ids)} work experience entries.")

            # 3. Insert Verified Facts (Achievements)
            facts = [
                # AOT Technologies
                {
                    "fact_id": "fact_001",
                    "exp_key": "aot",
                    "category": "leadership",
                    "text": "Built the product management function from zero in an engineering-led company after multiple failed attempts to productize consulting assets: introduced structured discovery and data-driven roadmap prioritization, and recruited the company's first Product Design and Product Marketing teams.",
                    "technologies": ["Continuous Discovery", "Product Roadmapping", "Team Building", "GTM"],
                    "metrics": ["Built PM function from zero", "Recruited first Product Design and PMM teams"]
                },
                {
                    "fact_id": "fact_002",
                    "exp_key": "aot",
                    "category": "platform_scale",
                    "text": "Consolidated disparate core products into a single SaaS-first platform, moving delivery from two annual releases across three deployment flavors to a consistent quarterly cadence, a 4x increase in feature delivery velocity within six months.",
                    "technologies": ["SaaS Platform Architecture", "Agile Execution", "Release Management"],
                    "metrics": ["4x increase in feature delivery velocity", "Consistent quarterly cadence", "6 months"]
                },
                {
                    "fact_id": "fact_003",
                    "exp_key": "aot",
                    "category": "ai_innovation",
                    "text": "Shipped the platform's first agentic capabilities, including an AI-driven builder and a hosted MCP server, and defined the governance model (permissions, approvals, audit trails) that lets enterprise customers safely delegate real work to agents.",
                    "technologies": ["Agentic AI", "MCP (Model Context Protocol)", "AI Governance", "LLM Applications", "Audit Trails"],
                    "metrics": ["First agentic capabilities shipped", "Hosted MCP server deployed"]
                },
                {
                    "fact_id": "fact_004",
                    "exp_key": "aot",
                    "category": "prototyping",
                    "text": "Operate prototype-first: build working demos with agentic coding tools to settle roadmap debates and align engineering and executives faster than documents alone.",
                    "technologies": ["Agentic Coding Tools", "Prototyping", "Executive Alignment", "Claude Code"],
                    "metrics": ["Prototype-first alignment"]
                },
                {
                    "fact_id": "fact_005",
                    "exp_key": "aot",
                    "category": "revenue_growth",
                    "text": "Delivered a 22-point NPS improvement and 20% month-over-month SaaS revenue growth in the first year, restructuring pricing and packaging to support the SaaS motion.",
                    "technologies": ["Pricing & Packaging", "SaaS Growth", "NPS Analysis"],
                    "metrics": ["22-point NPS improvement", "20% MoM SaaS revenue growth"]
                },
                # IBM
                {
                    "fact_id": "fact_006",
                    "exp_key": "ibm",
                    "category": "portfolio_strategy",
                    "text": "Owned strategic vision, roadmap, and GTM execution for a $150M+ annual revenue AI decisioning portfolio with P&L accountability, serving the world's largest banks and enterprise retailers.",
                    "technologies": ["AI Decisioning", "Portfolio Strategy", "P&L Ownership", "GTM Strategy"],
                    "metrics": ["$150M+ annual revenue portfolio", "Global banking clients"]
                },
                {
                    "fact_id": "fact_007",
                    "exp_key": "ibm",
                    "category": "ai_governance",
                    "text": "Directed the transition from legacy rules-based automation to agentic AI workflows, cutting operational cycle times 45% for BFSI clients while sustaining a 98% pass rate across regulatory audits; designed the decision governance framework (human approval thresholds, audit trails, rollback) that made autonomous decisioning acceptable to bank compliance teams.",
                    "technologies": ["Agentic AI Workflows", "Decision Governance", "BFSI Compliance", "Audit Trails", "Human-in-the-Loop"],
                    "metrics": ["45% cycle time reduction", "98% audit pass rate"]
                },
                {
                    "fact_id": "fact_008",
                    "exp_key": "ibm",
                    "category": "revenue_growth",
                    "text": "Grew portfolio revenue 20% year over year by integrating predictive analytics into high-stakes decision flows, including credit, fraud, and payment authorization decisioning for global banking clients.",
                    "technologies": ["Predictive Analytics", "Decision Intelligence", "Credit Decisioning", "Fraud Analytics", "Payment Authorization"],
                    "metrics": ["20% YoY portfolio revenue growth"]
                },
                {
                    "fact_id": "fact_009",
                    "exp_key": "ibm",
                    "category": "cloud_infrastructure",
                    "text": "Managed products delivered across SaaS, hybrid, and on-premises models as containerized software on Kubernetes and OpenShift, partnering with engineering on packaging, release management, and upgrade paths for regulated customers.",
                    "technologies": ["Kubernetes", "OpenShift", "Docker", "SaaS", "Hybrid Cloud"],
                    "metrics": ["Containerized delivery across SaaS, hybrid, on-prem"]
                },
                {
                    "fact_id": "fact_010",
                    "exp_key": "ibm",
                    "category": "team_leadership",
                    "text": "Built and mentored a team of 8 product managers and designers with direct line management, implementing outcome-over-output frameworks that cut product-to-market latency by 3 months.",
                    "technologies": ["Team Building & Mentorship", "Outcome-over-Output", "Product Leadership"],
                    "metrics": ["Team of 8 PMs and designers", "3 months cut from product-to-market latency"]
                },
                {
                    "fact_id": "fact_011",
                    "exp_key": "ibm",
                    "category": "customer_retention",
                    "text": "Turned support ticket analysis into a roadmap pivot: uncovered correlations between migration patterns and churn, redirected investment, and improved retention and financial forecasting accuracy; authored the executive narratives on portfolio health and AI bets that informed quarterly and annual planning and contributed to the portfolio's largest banking renewals.",
                    "technologies": ["Churn Analysis", "Executive Narratives", "Financial Forecasting", "Renewals Strategy"],
                    "metrics": ["Contributed to largest banking renewals", "Improved retention & forecast accuracy"]
                },
                # Odotrack
                {
                    "fact_id": "fact_012",
                    "exp_key": "odo",
                    "category": "product_discovery",
                    "text": "Grew a last-mile delivery tracking product into a broader fleet operations platform: ran continuous discovery combining qualitative customer interviews with quantitative usage analysis, then took route optimization, ELD compliance, and proof-of-delivery capabilities from concept to launch.",
                    "technologies": ["Continuous Discovery", "Fleet Operations", "Route Optimization", "Proof-of-Delivery"],
                    "metrics": ["Expanded last-mile tracking into broader fleet operations platform"]
                },
                {
                    "fact_id": "fact_013",
                    "exp_key": "odo",
                    "category": "compliance",
                    "text": "Shipped into a regulated environment: ELD and hours-of-service compliance are government-mandated for commercial fleets, requiring telematics data integrity and auditability to be designed into the product from day one.",
                    "technologies": ["ELD Compliance", "Hours-of-Service Regulations", "Telematics Data Integrity", "Auditability"],
                    "metrics": ["Government-mandated ELD compliance delivered"]
                },
                {
                    "fact_id": "fact_014",
                    "exp_key": "odo",
                    "category": "edge_telematics",
                    "text": "Owned the roadmap for edge telematics collection: in-vehicle devices streaming location and vehicle data at fleet scale, including remote configuration and lifecycle management of the device fleet.",
                    "technologies": ["Edge Telematics", "IoT Device Lifecycle", "Streaming Data", "Remote Configuration"],
                    "metrics": ["Fleet-scale device streaming and lifecycle management"]
                },
                {
                    "fact_id": "fact_015",
                    "exp_key": "odo",
                    "category": "engineering_alignment",
                    "text": "Translated discovery into detailed wireframes, user stories, and acceptance criteria for engineering, launching features that improved operational efficiency and user experience by 30%.",
                    "technologies": ["Wireframing", "User Stories", "Acceptance Criteria", "UX Design"],
                    "metrics": ["30% operational efficiency and UX improvement"]
                },
                # MYR POS
                {
                    "fact_id": "fact_016",
                    "exp_key": "myr",
                    "category": "growth",
                    "text": "Led product and growth for a fintech point-of-sale platform through 400% year-over-year customer acquisition growth, making the hard scaling calls on what to build, automate, or cut; owned the payments experience from card processing through reconciliation.",
                    "technologies": ["Fintech POS", "Card Processing", "Payment Reconciliation", "Customer Acquisition"],
                    "metrics": ["400% YoY customer acquisition growth"]
                },
                {
                    "fact_id": "fact_017",
                    "exp_key": "myr",
                    "category": "automation",
                    "text": "Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.",
                    "technologies": ["Data Modeling", "Business Process Automation", "Cost Reduction"],
                    "metrics": ["65% cost reduction"]
                },
                # Allagma Technologies
                {
                    "fact_id": "fact_018",
                    "exp_key": "all",
                    "category": "consulting",
                    "text": "Customer-facing consultant translating client problems into product requirements; led the phased deployment of complex POS systems for a national retail client, delivering incremental value on schedule.",
                    "technologies": ["Client Consulting", "Requirements Gathering", "Retail POS Deployments"],
                    "metrics": ["National retail deployment delivered on schedule"]
                },
                # Freelance
                {
                    "fact_id": "fact_019",
                    "exp_key": "fre",
                    "category": "backend_engineering",
                    "text": "Engineered automation systems in Python and Go, including distributed web scrapers, decentralized crawlers, and database automation frameworks.",
                    "technologies": ["Python", "Go", "Distributed Web Scrapers", "Decentralized Crawlers", "Database Automation"],
                    "metrics": ["Distributed scraping and crawler infrastructure"]
                }
            ]

            for fact in facts:
                cur.execute("""
                    INSERT INTO achievements (
                        fact_id, work_experience_id, category, text, technologies, metrics, verification_status, source
                    ) VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s);
                """, (
                    fact["fact_id"], exp_ids[fact["exp_key"]], fact["category"],
                    fact["text"], json.dumps(fact["technologies"]), json.dumps(fact["metrics"]),
                    "approved", "resume_canonical"
                ))

            print(f"Loaded {len(facts)} verified achievements (fact_001 to fact_019).")

            # 4. Insert Verified Skills
            skills = [
                ("product", "Portfolio Strategy & Roadmap Ownership", "expert", 10.0),
                ("product", "Go-to-Market (GTM) & Pricing/Packaging", "expert", 8.0),
                ("product", "Continuous Discovery & OKRs", "expert", 9.0),
                ("product", "Team Building & Mentorship", "expert", 8.0),
                ("ai", "Agentic AI Workflow Design & LLM Applications", "expert", 4.0),
                ("ai", "MCP (Model Context Protocol) Design & Integration", "expert", 2.0),
                ("ai", "AI Governance (Approval, Audit, Rollback)", "expert", 4.0),
                ("ai", "Decision Intelligence & Business Process Orchestration", "expert", 5.0),
                ("technical", "API Design & Integration (REST / GraphQL)", "expert", 10.0),
                ("technical", "System Architecture & Data Modeling", "expert", 12.0),
                ("technical", "Python & Go", "expert", 10.0),
                ("technical", "SQL & Relational Databases (PostgreSQL)", "expert", 12.0),
                ("technical", "Containerized Delivery (Docker, Kubernetes, OpenShift)", "expert", 6.0),
                ("technical", "Git & CI/CD Pipelines", "expert", 12.0),
                ("domain", "BFSI & Regulated Compliance", "expert", 6.0),
                ("domain", "Payments & Fintech POS", "expert", 5.0),
                ("domain", "Enterprise B2B SaaS", "expert", 8.0),
                ("domain", "Fleet Telematics & IoT", "expert", 3.0),
            ]

            for cat, name, level, yrs in skills:
                cur.execute("""
                    INSERT INTO skills (candidate_id, category, name, proficiency_level, years_experience, verified)
                    VALUES (%s, %s, %s, %s, %s, TRUE);
                """, (cand_id, cat, name, level, yrs))

            print(f"Loaded {len(skills)} verified skills.")

            # 5. Insert Education
            cur.execute("""
                INSERT INTO education (candidate_id, degree, field_of_study, institution, start_date, end_date)
                VALUES (%s, %s, %s, %s, %s, %s);
            """, (cand_id, "Bachelor of Computer Science", "Computer Science", "Concordia University", "2010-09-01", "2013-06-30"))
            print("Loaded Education (Concordia University).")

            # 6. Insert Preferences
            prefs = [
                ("work_authorization", {"status": "Citizen / Permanent Resident", "country": "Canada", "visa_sponsorship_needed": False}),
                ("target_locations", target_locations),
                ("min_compensation_cad", {"base": 180000, "currency": "CAD"}),
                ("linkedin_url", "https://linkedin.com/in/mouadatfi")
            ]
            for k, v in prefs:
                cur.execute("""
                    INSERT INTO preferences (candidate_id, key, value)
                    VALUES (%s, %s, %s::jsonb);
                """, (cand_id, k, json.dumps(v)))
            print(f"Loaded {len(prefs)} candidate preferences.")

            # 7. Insert Standard Answers
            answers = [
                ("work_auth", "Are you legally authorized to work in Canada?", "Yes", True, True),
                ("sponsorship", "Will you now or in the future require visa sponsorship?", "No", True, True),
                ("location", "Where are you currently located?", "Pickering, Ontario, Canada", False, False),
                ("salary", "What are your salary expectations?", "Competitive for Lead / Senior Product Manager roles in Canada (approx $180,000 - $220,000 CAD base)", True, True),
                ("notice_period", "What is your notice period?", "2 to 4 weeks", False, False)
            ]
            for cat, pattern, text, sens, apprv in answers:
                cur.execute("""
                    INSERT INTO standard_answers (candidate_id, category, question_pattern, answer_text, is_sensitive, requires_human_approval)
                    VALUES (%s, %s, %s, %s, %s, %s);
                """, (cand_id, cat, pattern, text, sens, apprv))
            print(f"Loaded {len(answers)} standard answers.")

        conn.commit()

    print("\n✅ Candidate profile and verified facts loaded successfully into PostgreSQL.")

def main(argv: Optional[List[str]] = None) -> int:
    """Replace the profile only after explicit confirmation in a human terminal."""
    parser = argparse.ArgumentParser(
        description="Replace candidate memory with the reviewed canonical profile"
    )
    parser.add_argument(
        "--confirm-replace",
        action="store_true",
        help="Confirm replacement of current candidate memory and invalidation of old resume snapshots",
    )
    arguments = parser.parse_args(argv)
    if not arguments.confirm_replace:
        parser.error("--confirm-replace is required")
    if not sys.stdin.isatty():
        parser.error("Candidate profile replacement requires an interactive terminal.")
    load_profile(human_confirmed=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
