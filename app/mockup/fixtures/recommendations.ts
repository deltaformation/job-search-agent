export interface RecommendationItem {
  id: string;
  title: string;
  summary: string;
  evidencePoints: {
    label: string;
    source: string;
    quoteOrMetric: string;
  }[];
  notes?: string;
}

export interface RecommendationCategory {
  title: string;
  badge: string;
  tone: "success" | "warning" | "destructive";
  description: string;
  items: RecommendationItem[];
}

export const RECOMMENDED_DIRECTION = {
  heading: "Lead with logistics product experience and measurable operational improvements.",
  body: "Frame Mouad’s proven track record scaling Odotrack’s fleet operations and electronic proof-of-delivery platform as the primary domain anchor, backed by AOT Technologies’ 4x delivery acceleration and IBM’s $150M+ enterprise roadmap leadership. This grounds the application in tangible operational wins while positioning senior enterprise readiness.",
};

export const RECOMMENDATION_CATEGORIES: RecommendationCategory[] = [
  {
    title: "Strong Support",
    badge: "Strong Evidence",
    tone: "success",
    description: "Directly verified candidate facts matching Lime’s core requirements.",
    items: [
      {
        id: "rec-logistics",
        title: "Logistics Products & Fleet Operations",
        summary:
          "Demonstrated product ownership in last-mile delivery tracking, vehicle routing, and electronic proof-of-delivery.",
        evidencePoints: [
          {
            label: "Odotrack Platform Expansion",
            source: "Odotrack (Nov 2019 – Aug 2021) · fact_odo_001",
            quoteOrMetric:
              "Launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.",
          },
          {
            label: "Operational Efficiency Gain",
            source: "Odotrack · fact_odo_003",
            quoteOrMetric: "Shipped features improving operational efficiency and UX by 30%.",
          },
        ],
      },
      {
        id: "rec-roadmap",
        title: "Product Strategy & Roadmap Ownership",
        summary:
          "Extensive executive roadmapping and backlog prioritization across fast-paced B2B SaaS and global enterprise scale.",
        evidencePoints: [
          {
            label: "AOT First PM Function",
            source: "AOT Technologies (Jul 2025 – Present) · fact_aot_001",
            quoteOrMetric:
              "Established the first product management function, introducing structured discovery and data-driven roadmap prioritization.",
          },
          {
            label: "IBM $150M+ P&L Ownership",
            source: "IBM (Aug 2021 – Jul 2025) · fact_ibm_001",
            quoteOrMetric:
              "Owned strategy, GTM, and P&L for a $150M+ annual revenue portfolio serving global BFSI and enterprise retail clients.",
          },
        ],
      },
      {
        id: "rec-outcomes",
        title: "Documented Operational & Engineering Outcomes",
        summary: "Verified metrics proving execution speed, cycle time reductions, and scaling.",
        evidencePoints: [
          {
            label: "4x Feature Delivery Velocity",
            source: "AOT Technologies · fact_aot_002",
            quoteOrMetric:
              "Moved to quarterly releases, achieving a 4x increase in feature delivery velocity within six months.",
          },
          {
            label: "45% Cycle Time Reduction",
            source: "IBM · fact_ibm_003",
            quoteOrMetric:
              "45% reduction in operational cycle times for BFSI clients while maintaining 98% compliance in regulatory audits.",
          },
        ],
      },
      {
        id: "rec-education",
        title: "Relevant Academic Degree",
        summary: "Bachelor’s degree aligned with technical and information management requirements.",
        evidencePoints: [
          {
            label: "Concordia University",
            source: "Education · Concordia University (2010 – 2013)",
            quoteOrMetric: "Bachelor’s Degree in Information Science.",
          },
        ],
      },
    ],
  },
  {
    title: "Transferable Experience",
    badge: "Transferable",
    tone: "warning",
    description:
      "Parallel capabilities that address role responsibilities with different organizational context.",
    items: [
      {
        id: "rec-fleet-vs-supplychain",
        title: "Fleet Operations vs. End-to-End Supply Chain",
        summary:
          "Extensive experience in last-mile tracking, dispatch routing, and fleet telematics, but less documented evidence in upstream container shipping, customs, or multi-modal freight logistics.",
        evidencePoints: [
          {
            label: "Odotrack Delivery Workflows",
            source: "Odotrack · fact_odo_001",
            quoteOrMetric:
              "Deep expertise in vehicle telemetry, route optimization algorithms, and delivery confirmation workflows.",
          },
        ],
        notes:
          "Position fleet tracking and last-mile routing as practical, customer-facing logistics execution.",
      },
      {
        id: "rec-compliance",
        title: "Enterprise Governance vs. Global Trade Regulations",
        summary:
          "Demonstrated mastery of complex BFSI regulatory audits and SaaS data governance, transferable to cross-border logistics compliance.",
        evidencePoints: [
          {
            label: "IBM Regulatory Audits",
            source: "IBM · fact_ibm_003",
            quoteOrMetric: "Maintained a 98% compliance rate across stringent regulatory audits.",
          },
        ],
        notes:
          "Frame audit rigor as strong qualification for navigating supply chain trade and data compliance.",
      },
    ],
  },
  {
    title: "Not Documented",
    badge: "Not Documented in Facts",
    tone: "destructive",
    description:
      "Explicit JD qualifications without supporting candidate facts. (Note: absence of documentation is not confirmed absence of experience; do not invent claims).",
    items: [
      {
        id: "rec-gap-netsuite",
        title: "NetSuite ERP, Inventory Management & WMS",
        summary:
          "Lime explicitly asks for 7+ years PM experience with demonstrated expertise in NetSuite ERP/Inventory/WMS integrations and data pipelines.",
        evidencePoints: [
          {
            label: "Master Resume Audit",
            source: "Candidate Facts Verification",
            quoteOrMetric:
              "No NetSuite ERP, NetSuite WMS, or warehouse management experience documented in approved facts.",
          },
        ],
        notes:
          "Must NOT invent NetSuite experience on the resume. In interview discussions, candidate can discuss ERP integration concepts from a platform engineering perspective.",
      },
      {
        id: "rec-gap-anaplan-oracle",
        title: "Anaplan Demand Planning & Oracle TMS",
        summary:
          "JD lists Anaplan and Oracle TMS as additional advantages for transportation management and demand forecasting.",
        evidencePoints: [
          {
            label: "Master Resume Audit",
            source: "Candidate Facts Verification",
            quoteOrMetric:
              "Neither Anaplan nor Oracle TMS is cited in verified candidate credentials.",
          },
        ],
        notes: "Kept completely out of tailored resume content.",
      },
      {
        id: "rec-gap-procurement",
        title: "Direct Procurement & Physical Inventory Ownership",
        summary:
          "Lime emphasizes hands-on collaboration with physical procurement and warehouse inventory teams.",
        evidencePoints: [
          {
            label: "Master Resume Audit",
            source: "Candidate Facts Verification",
            quoteOrMetric:
              "Background is heavy in software SaaS, AI decisioning, and fleet telematics rather than physical warehouse inventory operations.",
          },
        ],
        notes: "Focus on cross-functional alignment and technical requirements gathering.",
      },
    ],
  },
];

export const PRACTICAL_CONSIDERATIONS = [
  {
    icon: "MapPin",
    title: "Residence & Location Requirement",
    text: "Lime strictly requires candidate to reside in Canada for remote collaboration. Mouad resides in Pickering, Ontario, Canada (fully compliant).",
  },
  {
    icon: "Banknote",
    title: "Compensation Alignment",
    text: "Base salary CA$126,000–CA$174,000 matches market standards for Canadian remote Lead Product Manager roles.",
  },
  {
    icon: "Clock",
    title: "Product Management Experience Depth",
    text: "Mouad has 15+ years overall tech experience and 6+ years direct PM leadership. The JD asks for 7+ years PM; framing earlier Allagma / MYR consulting & operations leadership accurately bridges the seniority expectations without inflating PM tenure.",
  },
];
