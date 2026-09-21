export interface JDPhraseChip {
  id: string;
  phrase: string;
  status: "supported" | "requires_evidence" | "gap";
  isSelectable: boolean;
  sourceSection: string;
  evidenceReference?: string;
  popoverContent: string;
}

export const JD_PHRASE_CHIPS: JDPhraseChip[] = [
  {
    id: "chip-supply-chain-roadmap",
    phrase: "Lead the creation and execution of the supply chain product roadmap",
    status: "supported",
    isSelectable: true,
    sourceSection: "What You'll Do",
    evidenceReference: "fact_aot_001, fact_ibm_001",
    popoverContent:
      "Direct match: Supported by Mouad’s proven track record owning multi-product roadmaps at AOT and a $150M+ portfolio at IBM.",
  },
  {
    id: "chip-route-optimization",
    phrase: "Real-time tracking, automated warehousing, advanced analytics",
    status: "supported",
    isSelectable: true,
    sourceSection: "What You'll Do",
    evidenceReference: "fact_odo_001, fact_ibm_002",
    popoverContent:
      "Supported: Odotrack route optimization & ELD telematics directly aligns with real-time tracking and logistics automation.",
  },
  {
    id: "chip-engineering-delivery",
    phrase: "Work closely with engineering to create release plans, define MVP, and drive delivery",
    status: "supported",
    isSelectable: true,
    sourceSection: "What You'll Do",
    evidenceReference: "fact_aot_002",
    popoverContent:
      "Supported: Demonstrated 4x feature delivery velocity acceleration through disciplined quarterly Agile releases at AOT.",
  },
  {
    id: "chip-operational-kpis",
    phrase: "Define and track key product performance metrics (KPIs)",
    status: "supported",
    isSelectable: true,
    sourceSection: "What You'll Do",
    evidenceReference: "fact_ibm_003, fact_odo_003",
    popoverContent:
      "Supported: 45% cycle time reduction (IBM), +22 NPS gain (AOT), and 30% operational efficiency improvement (Odotrack).",
  },
  {
    id: "chip-voice-of-customer",
    phrase: "Serve as the voice of the customer and business operations",
    status: "supported",
    isSelectable: true,
    sourceSection: "What You'll Do",
    evidenceReference: "fact_odo_001, fact_ibm_005",
    popoverContent:
      "Supported: Qualitative customer interviews and support-ticket churn analysis translated into prioritized product backlog.",
  },
  {
    id: "chip-agile-scrum",
    phrase: "Leading cross-functional product development in an Agile/Scrum environment",
    status: "supported",
    isSelectable: true,
    sourceSection: "About You",
    evidenceReference: "Skills: Agile, Scrum, and Kanban (10 years verified)",
    popoverContent:
      "Supported: 10 years of verified Agile/Scrum leadership across engineering and product squads.",
  },
  {
    id: "chip-process-mapping",
    phrase: "Understand and map complex supply chain, order management, and distribution business processes",
    status: "requires_evidence",
    isSelectable: true,
    sourceSection: "What You'll Do",
    popoverContent:
      "Partially evidenced: Workflow automation and last-mile dispatch processes verified; upstream order management mapping requires interview elaboration.",
  },
  {
    id: "chip-procurement-collab",
    phrase: "Collaborate with procurement, inventory management, logistics, and operations teams",
    status: "requires_evidence",
    isSelectable: true,
    sourceSection: "What You'll Do",
    popoverContent:
      "Transferable: Extensive cross-functional collaboration with sales, engineering, and ops teams; specific physical procurement collaboration should be framed honestly.",
  },
  {
    id: "chip-netsuite",
    phrase: "Demonstrated expertise in NetSuite ERP, NetSuite Inventory Management, and NetSuite WMS",
    status: "gap",
    isSelectable: false,
    sourceSection: "About You",
    popoverContent:
      "TOOL GAP: NetSuite ERP/WMS is explicitly required by Lime, but not documented in candidate facts. Per truthfulness rules, this cannot be claimed on the resume.",
  },
  {
    id: "chip-anaplan-oracle",
    phrase: "Demand planning systems, such as Anaplan, and transportation management systems, such as Oracle TMS",
    status: "gap",
    isSelectable: false,
    sourceSection: "About You",
    popoverContent:
      "TOOL GAP: Anaplan & Oracle TMS are nice-to-have qualifications. Neither tool appears in candidate facts. Omitted from resume claims.",
  },
];

export const DIRECTION_STARTERS = [
  "Highlight Odotrack route optimization & proof-of-delivery metrics",
  "Emphasize cross-functional delivery between operations and engineering",
  "Frame AOT platform transformation as operational scaling",
];

export const FOCUS_TOGGLE_OPTIONS = [
  {
    id: "focus-logistics-prominent",
    label: "Make logistics experience more prominent",
    description: "Surface Odotrack fleet telemetry and route optimization early in summary and experience.",
    defaultChecked: true,
  },
  {
    id: "focus-roadmap-delivery",
    label: "Emphasize roadmap ownership and engineering delivery",
    description: "Highlight AOT’s 4x release velocity and IBM’s enterprise portfolio management.",
    defaultChecked: true,
  },
  {
    id: "focus-operational-kpis",
    label: "Highlight documented operational improvements",
    description: "Focus on 30% efficiency gains, 45% cycle time reduction, and NPS improvements.",
    defaultChecked: true,
  },
  {
    id: "focus-enterprise-governance",
    label: "Retain enterprise governance and scalability",
    description: "Emphasize regulatory compliance and BFSI scale as transferable to supply chain audit rigor.",
    defaultChecked: false,
  },
  {
    id: "focus-ai-platforms",
    label: "Keep AI platforms as the main positioning theme",
    description: "De-emphasize logistics to lead with generative AI and agentic decisioning workflows.",
    defaultChecked: false,
  },
];
