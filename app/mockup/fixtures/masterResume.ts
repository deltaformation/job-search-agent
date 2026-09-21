export interface MasterResumeEmployment {
  id: string;
  company: string;
  role: string;
  location: string;
  startDate: string;
  endDate?: string;
  isCurrent: boolean;
  description?: string;
  bullets: string[];
}

export interface MasterResumeFixture {
  identity: {
    fullName: string;
    headline: string;
    email: string;
    phone: string;
    location: string;
  };
  summary: string;
  employment: MasterResumeEmployment[];
  skillsByCategory: Record<string, string[]>;
  education: {
    degree: string;
    fieldOfStudy: string;
    institution: string;
    startDate: string;
    endDate: string;
  }[];
  markdownText: string;
  plainText: string;
}

/**
 * NOTE ON MASTER HTML RESUME:
 * If an authentic standalone HTML master resume file is later supplied,
 * its contents can be assigned to MASTER_RESUME_RAW_HTML below.
 * Currently, structured master data and text derivations are used.
 */
export const MASTER_RESUME_RAW_HTML: string | null = null;

export const MASTER_RESUME_FIXTURE: MasterResumeFixture = {
  identity: {
    fullName: "Mouad Atfi",
    headline: "Senior Product Manager",
    email: "ma170789@gmail.com",
    phone: "+1 (416) 828-7602",
    location: "Pickering, ON, Canada",
  },
  summary:
    "Product leader with 15+ years across engineering, consulting, operations, and product management. Owned P&L for a $150M+ AI decisioning portfolio at IBM serving the world’s largest banks and retailers, and currently leading the productization of an engineering-centric organization at AOT Technologies: first product framework, first design and marketing hires, 4x delivery velocity, and 20% month-over-month SaaS revenue growth. Hands-on developer roots in Python and Go. Specialty: taking AI from demo to deployed, then navigating the organization so it actually moves revenue, retention, and compliance outcomes.",
  employment: [
    {
      id: "emp-aot",
      company: "AOT Technologies",
      role: "Lead Product Manager",
      location: "Toronto, Canada",
      startDate: "Jul 2025",
      isCurrent: true,
      description:
        "Leading productization of an engineering-centric organization into a scalable SaaS platform.",
      bullets: [
        "Recruited to solve a problem the company had failed at multiple times: converting bespoke consulting assets into a scalable SaaS product. Established the first product management function, introducing structured discovery, data-driven roadmap prioritization, and the company’s inaugural Product Design and Product Marketing teams.",
        "Refocused delivery in a mature, engineering-centric org: consolidated disparate core products into a SaaS-first platform and moved from two annual releases across three deployment flavors to consistent quarterly releases, a 4x increase in feature delivery velocity within six months.",
        "Improved product-market fit with measurable first-year results: +22-point NPS gain and 20% month-over-month SaaS revenue growth.",
        "Shipped AI capabilities into the core platform, including an AI-driven application builder and a hosted MCP server for agentic integrations.",
      ],
    },
    {
      id: "emp-ibm",
      company: "IBM",
      role: "Senior Product Manager, AI Decisioning Portfolio",
      location: "Toronto, Canada",
      startDate: "Aug 2021",
      endDate: "Jul 2025",
      isCurrent: false,
      description:
        "Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio of AI/ML decisioning and automation products.",
      bullets: [
        "Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio of AI/ML decisioning and automation products serving global BFSI and enterprise retail clients; started by leading a single product and earned ownership of the full portfolio.",
        "Drove 20% average year-over-year revenue growth by integrating predictive analytics into decisioning workflows at the world’s largest banking and retail institutions.",
        "Led the portfolio’s transition from legacy rules-based automation to agentic AI workflows: 45% reduction in operational cycle times for BFSI clients while maintaining a 98% compliance rate across regulatory audits.",
        "Built and mentored a team of 8 product managers and designers; implemented outcome-over-output frameworks that cut product-to-market latency by 3 months.",
        "Uncovered a correlation between migration patterns and client churn through support-ticket analysis, and pivoted the roadmap to protect retention on the portfolio’s largest accounts.",
        "Shaped AI decisioning features tied directly to the portfolio’s largest banking renewals and expansions; authored executive narratives that informed quarterly and annual portfolio planning.",
      ],
    },
    {
      id: "emp-odotrack",
      company: "Odotrack",
      role: "Product Manager",
      location: "Montreal, Canada",
      startDate: "Nov 2019",
      endDate: "Aug 2021",
      isCurrent: false,
      description:
        "Grew last-mile delivery tracking platform into a broader fleet operations B2B SaaS product.",
      bullets: [
        "Grew a last-mile delivery tracking platform into a broader fleet operations product: identified expansion opportunities through qualitative interviews and quantitative usage analysis, then launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.",
        "Owned backlog and roadmap for the B2B SaaS platform, translating market segmentation and customer feedback into prioritized initiatives aligned with executive objectives.",
        "Delivered wireframes, user stories, and acceptance criteria that shipped features improving operational efficiency and user experience by 30%.",
      ],
    },
    {
      id: "emp-myr",
      company: "MYR POS",
      role: "Head of Operations (Product & Growth)",
      location: "Montreal, Canada",
      startDate: "Nov 2017",
      endDate: "Dec 2019",
      isCurrent: false,
      description:
        "Led product and growth through 400% YoY customer acquisition growth at fintech POS startup.",
      bullets: [
        "Led product and growth through 400% year-over-year customer acquisition growth at a fintech POS startup, driving the hard prioritization and scaling decisions that kept the product and team ahead of demand.",
        "Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.",
      ],
    },
    {
      id: "emp-allagma",
      company: "Allagma Technologies",
      role: "Consultant",
      location: "Montreal, Canada",
      startDate: "Apr 2013",
      endDate: "Nov 2017",
      isCurrent: false,
      description:
        "Translated customer problems into product requirements and led phased POS system deployments.",
      bullets: [
        "First client-facing role: translated customer problems into product requirements and led phased POS system deployments for a national retail client, delivering incremental value on schedule.",
      ],
    },
    {
      id: "emp-freelance",
      company: "Freelance",
      role: "Backend Developer",
      location: "Remote",
      startDate: "Jul 2010",
      endDate: "Jun 2013",
      isCurrent: false,
      description:
        "Engineered automation solutions in Python and Go, distributed web scrapers, crawlers, and database automation frameworks.",
      bullets: [
        "Engineered automation solutions in Python and Go, including distributed web scrapers, decentralized crawlers, and database automation frameworks; the technical foundation behind later AI and automation product work.",
      ],
    },
  ],
  skillsByCategory: {
    "Product Leadership": [
      "Product Strategy and Vision",
      "Portfolio Management & P&L Ownership",
      "Roadmap Prioritization",
      "Go-to-Market (GTM)",
      "Pricing and Packaging",
      "OKRs & Executive Communication",
      "Team Building & Mentorship",
    ],
    "AI and ML": [
      "AI Decisioning",
      "Agentic Workflows and Orchestration",
      "Generative AI and LLMs",
      "RAG",
      "Model Context Protocol (MCP)",
      "ML Product Lifecycle & Model Monitoring",
      "Predictive Analytics",
    ],
    "Discovery and Delivery": [
      "Customer Discovery & User Interviews",
      "Experimentation and A/B Testing",
      "Product Analytics",
      "Prototyping",
      "Agile, Scrum, and Kanban",
    ],
    Domain: [
      "Banking and Financial Services (BFSI)",
      "Fintech",
      "Regulatory Compliance and Data Governance",
      "Enterprise Workflow Automation",
      "B2B SaaS",
      "Point of Sale (POS)",
    ],
    Technical: [
      "SQL",
      "Python",
      "Go",
      "Git",
      "JIRA",
      "Confluence",
      "Aha!",
      "Figma",
      "Notion",
      "n8n",
      "Make",
    ],
    Languages: ["English", "French"],
  },
  education: [
    {
      degree: "Bachelor's",
      fieldOfStudy: "Information Science",
      institution: "Concordia University",
      startDate: "2010-09-01",
      endDate: "2013-05-31",
    },
  ],
  markdownText: `# Mouad Atfi

Pickering, ON, Canada | +1 (416) 828-7602 | ma170789@gmail.com

## Summary

Product leader with 15+ years across engineering, consulting, operations, and product management. Owned P&L for a $150M+ AI decisioning portfolio at IBM serving the world’s largest banks and retailers, and currently leading the productization of an engineering-centric organization at AOT Technologies: first product framework, first design and marketing hires, 4x delivery velocity, and 20% month-over-month SaaS revenue growth. Hands-on developer roots in Python and Go. Specialty: taking AI from demo to deployed, then navigating the organization so it actually moves revenue, retention, and compliance outcomes.

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
**Domain:** Banking and Financial Services (BFSI), Fintech, Regulatory Compliance and Data Governance, Enterprise Workflow Automation, B2B SaaS, Point of Sale (POS)
**Technical:** SQL, Python, Go, Git, JIRA, Confluence, Aha!, Figma, Notion, n8n, Make
**Languages:** English, French

## Education

- Bachelor's in Information Science, Concordia University (2013-05-31)
`,
  plainText: `MOUAD ATFI
Pickering, ON, Canada | +1 (416) 828-7602 | ma170789@gmail.com

SUMMARY
Product leader with 15+ years across engineering, consulting, operations, and product management. Owned P&L for a $150M+ AI decisioning portfolio at IBM serving the world’s largest banks and retailers, and currently leading the productization of an engineering-centric organization at AOT Technologies: first product framework, first design and marketing hires, 4x delivery velocity, and 20% month-over-month SaaS revenue growth. Hands-on developer roots in Python and Go. Specialty: taking AI from demo to deployed, then navigating the organization so it actually moves revenue, retention, and compliance outcomes.

PROFESSIONAL EXPERIENCE

AOT Technologies | Toronto, Canada
Lead Product Manager | Jul 2025 - Present
• Recruited to solve a problem the company had failed at multiple times: converting bespoke consulting assets into a scalable SaaS product. Established the first product management function, introducing structured discovery, data-driven roadmap prioritization, and the company’s inaugural Product Design and Product Marketing teams.
• Refocused delivery in a mature, engineering-centric org: consolidated disparate core products into a SaaS-first platform and moved from two annual releases across three deployment flavors to consistent quarterly releases, a 4x increase in feature delivery velocity within six months.
• Improved product-market fit with measurable first-year results: +22-point NPS gain and 20% month-over-month SaaS revenue growth.
• Shipped AI capabilities into the core platform, including an AI-driven application builder and a hosted MCP server for agentic integrations.

IBM | Toronto, Canada
Senior Product Manager, AI Decisioning Portfolio | Aug 2021 - Jul 2025
• Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio of AI/ML decisioning and automation products serving global BFSI and enterprise retail clients; started by leading a single product and earned ownership of the full portfolio.
• Drove 20% average year-over-year revenue growth by integrating predictive analytics into decisioning workflows at the world’s largest banking and retail institutions.
• Led the portfolio’s transition from legacy rules-based automation to agentic AI workflows: 45% reduction in operational cycle times for BFSI clients while maintaining a 98% compliance rate across regulatory audits.
• Built and mentored a team of 8 product managers and designers; implemented outcome-over-output frameworks that cut product-to-market latency by 3 months.
• Uncovered a correlation between migration patterns and client churn through support-ticket analysis, and pivoted the roadmap to protect retention on the portfolio’s largest accounts.
• Shaped AI decisioning features tied directly to the portfolio’s largest banking renewals and expansions; authored executive narratives that informed quarterly and annual portfolio planning.

Odotrack | Montreal, Canada
Product Manager | Nov 2019 - Aug 2021
• Grew a last-mile delivery tracking platform into a broader fleet operations product: identified expansion opportunities through qualitative interviews and quantitative usage analysis, then launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.
• Owned backlog and roadmap for the B2B SaaS platform, translating market segmentation and customer feedback into prioritized initiatives aligned with executive objectives.
• Delivered wireframes, user stories, and acceptance criteria that shipped features improving operational efficiency and user experience by 30%.

EARLIER CAREER

MYR POS | Montreal, Canada
Head of Operations (Product & Growth) | Nov 2017 - Dec 2019
• Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.
• Led product and growth through 400% year-over-year customer acquisition growth at a fintech POS startup, driving the hard prioritization and scaling decisions that kept the product and team ahead of demand.

Allagma Technologies | Montreal, Canada
Consultant | Apr 2013 - Nov 2017
• First client-facing role: translated customer problems into product requirements and led phased POS system deployments for a national retail client, delivering incremental value on schedule.

Freelance | Remote
Backend Developer | Jul 2010 - Jun 2013
• Engineered automation solutions in Python and Go, including distributed web scrapers, decentralized crawlers, and database automation frameworks; the technical foundation behind later AI and automation product work.

SKILLS
Product Leadership: Product Strategy and Vision, Portfolio Management & P&L Ownership, Roadmap Prioritization, Go-to-Market (GTM), Pricing and Packaging, OKRs & Executive Communication, Team Building & Mentorship
AI and ML: AI Decisioning, Agentic Workflows and Orchestration, Generative AI and LLMs, RAG, Model Context Protocol (MCP), ML Product Lifecycle & Model Monitoring, Predictive Analytics
Discovery and Delivery: Customer Discovery & User Interviews, Experimentation and A/B Testing, Product Analytics, Prototyping, Agile, Scrum, and Kanban
Domain: Banking and Financial Services (BFSI), Fintech, Regulatory Compliance and Data Governance, Enterprise Workflow Automation, B2B SaaS, Point of Sale (POS)
Technical: SQL, Python, Go, Git, JIRA, Confluence, Aha!, Figma, Notion, n8n, Make
Languages: English, French

EDUCATION
Bachelor's in Information Science, Concordia University (2013-05-31)`,
};
