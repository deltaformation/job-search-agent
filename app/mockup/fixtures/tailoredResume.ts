export interface TailoredResumeFixture {
  version: number;
  versionLabel: string;
  reviewState: "AWAITING_REVIEW" | "APPROVED" | "DECLINED";
  summary: string;
  markdownText: string;
  plainText: string;
  keyChanges: string[];
  remainingGaps: {
    tool: string;
    status: "gap" | "unsupported";
    explanation: string;
  }[];
  comparisonMetrics: {
    keywordCoverage: {
      matched: number;
      total: number;
      label: string;
      details: string;
    };
    requirementsAddressed: {
      addressed: number;
      total: number;
      label: string;
      details: string;
    };
    documentChecks: {
      passed: boolean;
      label: string;
      details: string;
    };
    evidenceIntegrity: {
      verifiedPercent: number;
      label: string;
      details: string;
    };
  };
}

export const TAILORED_RESUME_V1_MARKDOWN = `# Mouad Atfi

Pickering, ON, Canada | +1 (416) 828-7602 | ma170789@gmail.com

## Summary

Product leader with 15+ years across engineering, consulting, operations, and product management, with hands-on background expanding logistics and fleet operations platforms. Proven track record driving enterprise roadmap prioritization and cross-functional engineering delivery: owned P&L for a $150M+ portfolio at IBM, accelerated feature velocity 4x at AOT Technologies, and scaled route optimization and electronic proof-of-delivery platforms at Odotrack to achieve 30% operational efficiency gains. Hands-on roots in Python and Go. Specialty: aligning operations, engineering, and product roadmaps to deliver measurable efficiency, retention, and compliance outcomes.

## Professional Experience

**AOT Technologies** | Jul 2025 - Present
*Lead Product Manager* | Toronto, Canada
- Recruited to solve a problem the company had failed at multiple times: converting bespoke consulting assets into a scalable SaaS product. Established the first product management function, introducing structured discovery, data-driven roadmap prioritization, and the company’s inaugural Product Design and Product Marketing teams.
- Refocused delivery in a mature, engineering-centric org: consolidated disparate core products into a SaaS-first platform and moved from two annual releases across three deployment flavors to consistent quarterly releases, a 4x increase in feature delivery velocity within six months.
- Improved product-market fit with measurable first-year results: +22-point NPS gain and 20% month-over-month SaaS revenue growth.
- Shipped AI capabilities into the core platform, including an AI-driven application builder and a hosted MCP server for agentic integrations.

**IBM** | Aug 2021 - Jul 2025
*Senior Product Manager, AI Decisioning Portfolio* | Toronto, Canada
- Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio of AI/ML decisioning and automation products serving global BFSI and enterprise retail clients; started by leading a single product and earned ownership of the full portfolio.
- Drove 20% average year-over-year revenue growth by integrating predictive analytics into decisioning workflows at the world’s largest banking and retail institutions.
- Led the portfolio’s transition from legacy rules-based automation to agentic AI workflows: 45% reduction in operational cycle times for BFSI clients while maintaining a 98% compliance rate across regulatory audits.
- Built and mentored a team of 8 product managers and designers; implemented outcome-over-output frameworks that cut product-to-market latency by 3 months.
- Uncovered a correlation between migration patterns and client churn through support-ticket analysis, and pivoted the roadmap to protect retention on the portfolio’s largest accounts.
- Shaped AI decisioning features tied directly to the portfolio’s largest banking renewals and expansions; authored executive narratives that informed quarterly and annual portfolio planning.

**Odotrack** | Nov 2019 - Aug 2021
*Product Manager* | Montreal, Canada
- Grew a last-mile delivery tracking platform into a broader fleet operations product: identified expansion opportunities through qualitative interviews and quantitative usage analysis, then launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.
- Owned backlog and roadmap for the B2B SaaS platform, translating market segmentation and customer feedback into prioritized initiatives aligned with executive objectives.
- Delivered wireframes, user stories, and acceptance criteria that shipped features improving operational efficiency and user experience by 30%.

## Earlier Career

**MYR POS** | Nov 2017 - Dec 2019
*Head of Operations (Product & Growth)* | Montreal, Canada
- Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.
- Led product and growth through 400% year-over-year customer acquisition growth at a fintech POS startup, driving the hard prioritization and scaling decisions that kept the product and team ahead of demand.

**Allagma Technologies** | Apr 2013 - Nov 2017
*Consultant* | Montreal, Canada
- First client-facing role: translated customer problems into product requirements and led phased POS system deployments for a national retail client, delivering incremental value on schedule.

**Freelance** | Jul 2010 - Jun 2013
*Backend Developer* | Remote
- Engineered automation solutions in Python and Go, including distributed web scrapers, decentralized crawlers, and database automation frameworks; the technical foundation behind later AI and automation product work.

## Skills

**Product Leadership:** Product Strategy and Vision, Portfolio Management & P&L Ownership, Roadmap Prioritization, Go-to-Market (GTM), Pricing and Packaging, OKRs & Executive Communication, Team Building & Mentorship
**AI and ML:** AI Decisioning, Agentic Workflows and Orchestration, Generative AI and LLMs, RAG, Model Context Protocol (MCP), ML Product Lifecycle & Model Monitoring, Predictive Analytics
**Discovery and Delivery:** Customer Discovery & User Interviews, Experimentation and A/B Testing, Product Analytics, Prototyping, Agile, Scrum, and Kanban
**Domain:** Fleet Operations & Route Optimization, Electronic Proof-of-Delivery, Banking & Financial Services, Fintech, Regulatory Compliance, Enterprise Workflow Automation, B2B SaaS, POS
**Technical:** SQL, Python, Go, Git, JIRA, Confluence, Aha!, Figma, Notion, n8n, Make
**Languages:** English, French

## Education

- Bachelor's in Information Science, Concordia University (2013-05-31)
`;

export const TAILORED_RESUME_V1_FIXTURE: TailoredResumeFixture = {
  version: 1,
  versionLabel: "Version 1",
  reviewState: "AWAITING_REVIEW",
  summary:
    "Product leader with 15+ years across engineering, consulting, operations, and product management, with hands-on background expanding logistics and fleet operations platforms. Proven track record driving enterprise roadmap prioritization and cross-functional engineering delivery: owned P&L for a $150M+ portfolio at IBM, accelerated feature velocity 4x at AOT Technologies, and scaled route optimization and electronic proof-of-delivery platforms at Odotrack to achieve 30% operational efficiency gains. Hands-on roots in Python and Go. Specialty: aligning operations, engineering, and product roadmaps to deliver measurable efficiency, retention, and compliance outcomes.",
  markdownText: TAILORED_RESUME_V1_MARKDOWN,
  plainText: TAILORED_RESUME_V1_MARKDOWN,
  keyChanges: [
    "Positioning re-centered on logistics product leadership and measurable operational outcomes (30% efficiency at Odotrack, 45% cycle time reduction at IBM, 4x delivery velocity at AOT).",
    "Summary synthesized route optimization, electronic proof-of-delivery, and cross-functional delivery leadership as primary themes.",
    "Preserved all approved employment history, verified metrics, dates, and Concordia University education without alteration.",
    "Retained explicit disclosure for unevidenced ERP and TMS tooling.",
  ],
  remainingGaps: [
    {
      tool: "NetSuite ERP / Inventory Management / WMS",
      status: "gap",
      explanation:
        "Lime requires demonstrated expertise in NetSuite ERP/WMS data pipelines. Candidate facts show deep SaaS and platform delivery, but zero documented NetSuite experience. Left unmentioned on resume rather than invented.",
    },
    {
      tool: "Anaplan Demand Planning",
      status: "unsupported",
      explanation:
        "JD bonus qualification. Not documented in approved candidate facts. Excluded from tailored draft.",
    },
    {
      tool: "Oracle TMS (Transportation Management System)",
      status: "unsupported",
      explanation:
        "JD bonus qualification. Candidate has proven fleet/route optimization platforms (Odotrack), but specifically Oracle TMS is not documented. Excluded from tailored draft.",
    },
  ],
  comparisonMetrics: {
    keywordCoverage: {
      matched: 14,
      total: 18,
      label: "14 / 18 Core Keywords Matched",
      details:
        "Matched: Product Strategy, Roadmap, Logistics, Route Optimization, Operational Efficiencies, KPIs, Cross-functional, Agile/Scrum, Engineering Delivery, Proof-of-Delivery, User Adoption, B2B SaaS, Data Analytics, Release Plans. Gaps: NetSuite ERP, NetSuite WMS, Anaplan, Oracle TMS.",
    },
    requirementsAddressed: {
      addressed: 8,
      total: 11,
      label: "8 / 11 Requirements Addressed",
      details:
        "Strong coverage across supply chain roadmap, engineering delivery, operational metrics, and team leadership. 3 tool-specific ERP/TMS requirements flagged as gaps.",
    },
    documentChecks: {
      passed: true,
      label: "All Automated Checks Passed",
      details:
        "Length: 2 pages within standard limits. Formatting: consistent headings and bullet density. Contact & location info verified.",
    },
    evidenceIntegrity: {
      verifiedPercent: 100,
      label: "100% Claims Evidenced",
      details:
        "Every single bullet and summary claim links directly to an approved immutable fact ID. Zero hallucinated employers, dates, metrics, or technologies.",
    },
  },
};

export const TAILORED_RESUME_V2_MARKDOWN = `# Mouad Atfi

Pickering, ON, Canada | +1 (416) 828-7602 | ma170789@gmail.com

## Summary

Product leader with 15+ years across engineering, consulting, operations, and product management, specializing in logistics systems, fleet operations, and operational process optimization. Proven enterprise leader driving complex supply chain and platform roadmaps across engineering, operations, and external logistics partners: accelerated feature delivery velocity 4x at AOT Technologies, owned P&L for a $150M+ enterprise decisioning portfolio at IBM, and launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities at Odotrack resulting in a 30% operational efficiency improvement. Developer foundation in Python and Go. Focused on bridging operational stakeholders and engineering execution.

## Professional Experience

**AOT Technologies** | Jul 2025 - Present
*Lead Product Manager* | Toronto, Canada
- Recruited to solve a problem the company had failed at multiple times: converting bespoke consulting assets into a scalable SaaS product. Established the first product management function, introducing structured discovery, data-driven roadmap prioritization, and the company’s inaugural Product Design and Product Marketing teams.
- Refocused delivery in a mature, engineering-centric org: consolidated disparate core products into a SaaS-first platform and moved from two annual releases across three deployment flavors to consistent quarterly releases, a 4x increase in feature delivery velocity within six months.
- Improved product-market fit with measurable first-year results: +22-point NPS gain and 20% month-over-month SaaS revenue growth.
- Shipped AI capabilities into the core platform, including an AI-driven application builder and a hosted MCP server for agentic integrations.

**IBM** | Aug 2021 - Jul 2025
*Senior Product Manager, AI Decisioning Portfolio* | Toronto, Canada
- Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio of AI/ML decisioning and automation products serving global BFSI and enterprise retail clients; started by leading a single product and earned ownership of the full portfolio.
- Drove 20% average year-over-year revenue growth by integrating predictive analytics into decisioning workflows at the world’s largest banking and retail institutions.
- Led the portfolio’s transition from legacy rules-based automation to agentic AI workflows: 45% reduction in operational cycle times for BFSI clients while maintaining a 98% compliance rate across regulatory audits.
- Built and mentored a team of 8 product managers and designers; implemented outcome-over-output frameworks that cut product-to-market latency by 3 months.
- Uncovered a correlation between migration patterns and client churn through support-ticket analysis, and pivoted the roadmap to protect retention on the portfolio’s largest accounts.
- Shaped AI decisioning features tied directly to the portfolio’s largest banking renewals and expansions; authored executive narratives that informed quarterly and annual portfolio planning.

**Odotrack** | Nov 2019 - Aug 2021
*Product Manager* | Montreal, Canada
- Grew a last-mile delivery tracking platform into a broader fleet operations product: identified expansion opportunities through qualitative interviews and quantitative usage analysis, then launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.
- Owned backlog and roadmap for the B2B SaaS platform, translating market segmentation and customer feedback into prioritized initiatives aligned with executive objectives.
- Delivered wireframes, user stories, and acceptance criteria that shipped features improving operational efficiency and user experience by 30%.

## Earlier Career

**MYR POS** | Nov 2017 - Dec 2019
*Head of Operations (Product & Growth)* | Montreal, Canada
- Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.
- Led product and growth through 400% year-over-year customer acquisition growth at a fintech POS startup, driving the hard prioritization and scaling decisions that kept the product and team ahead of demand.

**Allagma Technologies** | Apr 2013 - Nov 2017
*Consultant* | Montreal, Canada
- First client-facing role: translated customer problems into product requirements and led phased POS system deployments for a national retail client, delivering incremental value on schedule.

**Freelance** | Jul 2010 - Jun 2013
*Backend Developer* | Remote
- Engineered automation solutions in Python and Go, including distributed web scrapers, decentralized crawlers, and database automation frameworks; the technical foundation behind later AI and automation product work.

## Skills

**Product Leadership:** Product Strategy and Vision, Portfolio Management & P&L Ownership, Roadmap Prioritization, Go-to-Market (GTM), Pricing and Packaging, OKRs & Executive Communication, Team Building & Mentorship
**AI and ML:** AI Decisioning, Agentic Workflows and Orchestration, Generative AI and LLMs, RAG, Model Context Protocol (MCP), ML Product Lifecycle & Model Monitoring, Predictive Analytics
**Discovery and Delivery:** Customer Discovery & User Interviews, Experimentation and A/B Testing, Product Analytics, Prototyping, Agile, Scrum, and Kanban
**Domain:** Logistics Systems & Fleet Operations, Route Optimization, Electronic Proof-of-Delivery, Process Optimization, Enterprise Automation, B2B SaaS, BFSI, POS
**Technical:** SQL, Python, Go, Git, JIRA, Confluence, Aha!, Figma, Notion, n8n, Make
**Languages:** English, French

## Education

- Bachelor's in Information Science, Concordia University (2013-05-31)
`;

export const TAILORED_RESUME_V2_FIXTURE: TailoredResumeFixture = {
  version: 2,
  versionLabel: "Version 2 (Revision)",
  reviewState: "AWAITING_REVIEW",
  summary:
    "Product leader with 15+ years across engineering, consulting, operations, and product management, specializing in logistics systems, fleet operations, and operational process optimization. Proven enterprise leader driving complex supply chain and platform roadmaps across engineering, operations, and external logistics partners: accelerated feature delivery velocity 4x at AOT Technologies, owned P&L for a $150M+ enterprise decisioning portfolio at IBM, and launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities at Odotrack resulting in a 30% operational efficiency improvement. Developer foundation in Python and Go. Focused on bridging operational stakeholders and engineering execution.",
  markdownText: TAILORED_RESUME_V2_MARKDOWN,
  plainText: TAILORED_RESUME_V2_MARKDOWN,
  keyChanges: [
    "Revision incorporating user guidance: intensified emphasis on cross-functional logistics collaboration between operations and engineering.",
    "Elevated Odotrack route optimization and ELD compliance earlier in the summary framing.",
    "Added 'Logistics Systems & Fleet Operations' and 'Process Optimization' to domain competencies while preserving strict fact provenance.",
    "Maintained absolute omission of unevidenced NetSuite/Anaplan/Oracle TMS claims.",
  ],
  remainingGaps: TAILORED_RESUME_V1_FIXTURE.remainingGaps,
  comparisonMetrics: TAILORED_RESUME_V1_FIXTURE.comparisonMetrics,
};
