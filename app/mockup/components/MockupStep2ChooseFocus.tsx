"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  Edit2,
  ExternalLink,
  Eye,
  FileText,
  GripVertical,
  Quote,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Star,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  JD_WORD_CLOUD_KEYWORDS,
} from "../fixtures/keywordAnalytics";
import { MASTER_RESUME_FIXTURE } from "../fixtures/masterResume";
import { MockupMasterViewer } from "./MockupViewers";

export interface TailoringFocusState {
  careerProfile: string;
  positioningTheme: string;
  checkedKeywords: string[];
  summaryText: string;
  mappedPhrases: Record<string, string[]>;
  additionalGuidance: string;
}

export const MASTER_EXPERIENCE_ROLES = [
  {
    id: "role-aot",
    company: "AOT Technologies",
    title: "Lead Product Manager",
    period: "Jul 2025 – Present",
    location: "Toronto, Canada",
    bullets: [
      "Recruited to solve converting bespoke consulting assets into a scalable SaaS product; established first product management function.",
      "Refocused delivery in mature engineering-centric org: moved from 2 annual releases to quarterly releases, 4x delivery velocity.",
      "+22-point NPS gain and 20% month-over-month SaaS revenue growth in first year.",
      "Shipped AI capabilities into core platform, including AI application builder and hosted MCP server.",
    ],
  },
  {
    id: "role-ibm",
    company: "IBM",
    title: "Senior Product Manager, AI Decisioning Portfolio",
    period: "Aug 2021 – Jul 2025",
    location: "Toronto, Canada",
    bullets: [
      "Owned strategy, GTM, and P&L for $150M+ annual revenue portfolio of AI/ML decisioning and automation products.",
      "Drove 20% average year-over-year revenue growth by integrating predictive analytics into decisioning workflows at global BFSI clients.",
      "Led transition from legacy rules-based automation to agentic AI workflows: 45% cycle-time reduction at 98% compliance.",
      "Built and mentored team of 8 product managers and designers; cut product-to-market latency by 3 months.",
    ],
  },
  {
    id: "role-odotrack",
    company: "Odotrack",
    title: "Product Manager",
    period: "Nov 2019 – Aug 2021",
    location: "Montreal, Canada",
    bullets: [
      "Grew last-mile delivery tracking platform into a broader fleet operations B2B SaaS product.",
      "Launched route optimization, ELD compliance, and electronic proof-of-delivery capabilities for trucks and fleets.",
      "Owned backlog and roadmap for B2B SaaS platform, translating customer feedback into prioritized initiatives.",
      "Shipped features improving operational efficiency and user experience by 30%.",
    ],
  },
  {
    id: "role-myr",
    company: "MYR POS",
    title: "Head of Operations (Product & Growth)",
    period: "Nov 2017 – Dec 2019",
    location: "Montreal, Canada",
    bullets: [
      "Led product and growth through 400% year-over-year customer acquisition growth at fintech POS startup.",
      "Identified operational inefficiencies through data modeling and deployed automation that reduced costs by 65%.",
    ],
  },
  {
    id: "role-allagma",
    company: "Allagma Technologies",
    title: "Consultant",
    period: "Apr 2013 – Nov 2017",
    location: "Montreal, Canada",
    bullets: [
      "Translated customer problems into product requirements and led phased POS deployments for national retail client.",
    ],
  },
  {
    id: "role-freelance",
    company: "Freelance",
    title: "Backend Developer",
    period: "Jul 2010 – Jun 2013",
    location: "Remote",
    bullets: [
      "Engineered automation solutions in Python and Go, distributed scrapers, and database automation frameworks.",
    ],
  },
];

export const AVAILABLE_JD_PHRASES = [
  {
    id: "phr-strategy",
    text: "Define product strategy by understanding supply chain market trends, logistics needs, and emerging technologies",
    domain: "Strategy & Market",
  },
  {
    id: "phr-processes",
    text: "Understand and map complex supply chain, order management, and distribution business processes",
    domain: "Process & Ops",
  },
  {
    id: "phr-engineering",
    text: "Work closely with engineering to create release plans, define MVP, and drive delivery of supply chain initiatives",
    domain: "Delivery & Agile",
  },
  {
    id: "phr-kpis",
    text: "Define and track key product performance metrics (KPIs) to assess success and process efficiency",
    domain: "Metrics & Data",
  },
  {
    id: "phr-tracking",
    text: "Stay up-to-date with emerging supply chain technologies (real-time tracking, automated warehousing, advanced analytics)",
    domain: "Logistics Tech",
  },
];

const CATEGORIES: {
  id: "all" | "logistics" | "erp" | "product" | "tech";
  label: string;
  count: number;
}[] = [
  { id: "all", label: "All Keywords", count: JD_WORD_CLOUD_KEYWORDS.length },
  {
    id: "logistics",
    label: "Supply Chain & Fleet",
    count: JD_WORD_CLOUD_KEYWORDS.filter((k) => k.category === "logistics").length,
  },
  {
    id: "erp",
    label: "Enterprise & ERP",
    count: JD_WORD_CLOUD_KEYWORDS.filter((k) => k.category === "erp").length,
  },
  {
    id: "product",
    label: "Product & Ops",
    count: JD_WORD_CLOUD_KEYWORDS.filter((k) => k.category === "product").length,
  },
  {
    id: "tech",
    label: "Tech & Telematics",
    count: JD_WORD_CLOUD_KEYWORDS.filter((k) => k.category === "tech").length,
  },
];

function getKeywordCloudClasses(
  count: number,
  isSelected: boolean,
  isEmphasized: boolean,
  status: "matched" | "transferable" | "gap"
) {
  let sizeStyle = "text-xs font-normal px-2.5 py-1";
  if (count >= 10) {
    sizeStyle = "text-xl sm:text-2xl font-extrabold px-4 py-2";
  } else if (count >= 7) {
    sizeStyle = "text-lg sm:text-xl font-semibold px-3.5 py-1.5";
  } else if (count >= 5) {
    sizeStyle = "text-sm sm:text-base font-semibold px-3 py-1";
  } else if (count >= 4) {
    sizeStyle = "text-xs sm:text-sm font-medium px-2.5 py-1";
  }

  if (isSelected) {
    return cn(
      sizeStyle,
      "rounded-full ring-2 ring-primary bg-primary text-primary-foreground shadow-md scale-105 transition-all duration-150 z-10 font-semibold cursor-pointer"
    );
  }

  if (isEmphasized) {
    return cn(
      sizeStyle,
      "rounded-full ring-2 ring-primary/60 border border-primary bg-primary/10 text-foreground font-semibold  hover:bg-primary/20 transition-all cursor-pointer"
    );
  }

  if (status === "gap") {
    return cn(
      sizeStyle,
      "rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/60 transition-all cursor-pointer"
    );
  }

  if (status === "transferable") {
    return cn(
      sizeStyle,
      "rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-300 hover:bg-sky-500/20 hover:border-sky-500/60 transition-all cursor-pointer"
    );
  }

  return cn(
    sizeStyle,
    "rounded-full border border-border/80 bg-background text-foreground hover:bg-accent hover:border-primary/40 hover:text-foreground transition-all cursor-pointer"
  );
}

export interface Top5PhraseMatch {
  id: string;
  phrase: string;
  category: string;
  matchStatus: "Strong Match" | "Transferable" | "Candidate Gap";
  variant: "success" | "info" | "warning";
  evidenceFact: string;
  tailoringDirection: string;
}

export const TOP_5_PHRASES_MATCH: Top5PhraseMatch[] = [
  {
    id: "phr-roadmap",
    phrase:
      "Lead the creation and execution of the supply chain product roadmap, ensuring alignment with overall business and operational objectives.",
    category: "Roadmap Leadership & Business Objectives",
    matchStatus: "Strong Match",
    variant: "success",
    evidenceFact:
      "AOT: quarterly releases and 4x delivery velocity. IBM: $150M+ portfolio.",
    tailoringDirection:
      "Lead with roadmap ownership and delivery outcomes.",
  },
  {
    id: "phr-agile",
    phrase:
      "Demonstrated experience leading cross-functional product development in an Agile/Scrum environment... guiding iterative planning, prioritization, and delivery.",
    category: "Cross-functional Leadership & Agile/Scrum",
    matchStatus: "Strong Match",
    variant: "success",
    evidenceFact:
      "AOT: delivery cadence. IBM: product-team leadership.",
    tailoringDirection:
      "Emphasize delivery and team leadership; verify Scrum-specific evidence.",
  },
  {
    id: "phr-processes",
    phrase:
      "Understand and map complex supply chain, order management, and distribution business processes.",
    category: "Supply Chain & Order Distribution",
    matchStatus: "Transferable",
    variant: "info",
    evidenceFact:
      "Odotrack: routing and proof of delivery. MYR: POS operations.",
    tailoringDirection:
      "Position logistics experience as transferable.",
  },
  {
    id: "phr-telematics",
    phrase:
      "Stay up-to-date with emerging supply chain technologies (e.g., real-time tracking, automated warehousing, advanced analytics)...",
    category: "Real-time Telemetry & Smart Logistics",
    matchStatus: "Transferable",
    variant: "info",
    evidenceFact:
      "Odotrack: vehicle telemetry and ELD. IBM: predictive analytics.",
    tailoringDirection:
      "Highlight telemetry and analytics.",
  },
  {
    id: "phr-netsuite",
    phrase:
      "7+ years of experience as a product manager, with demonstrated expertise in NetSuite ERP, NetSuite Inventory Management, and NetSuite WMS...",
    category: "Enterprise ERP / WMS Suites",
    matchStatus: "Candidate Gap",
    variant: "warning",
    evidenceFact:
      "NetSuite ERP/WMS experience is not documented.",
    tailoringDirection:
      "Keep NetSuite as an evidence gap.",
  },
];

export interface SummaryPositioningTheme {
  id: string;
  title: string;
  isRecommended?: boolean;
  description: string;
  summaryDraft: string;
}

export const SUMMARY_POSITIONING_THEMES: SummaryPositioningTheme[] = [
  {
    id: "theme-logistics",
    title: "Logistics & operations",
    isRecommended: true,
    description:
      "Odotrack fleet operations, routing, and measurable outcomes.",
    summaryDraft:
      "Product leader with 15+ years driving supply chain, fleet operations, and enterprise SaaS platforms. Led fleet tracking, route optimization, and ELD compliance at Odotrack delivering 30% operational efficiency gains; scaled AI and automation systems at IBM and AOT Technologies with 4x delivery velocity. Specialty: aligning cross-functional engineering and operations squads to translate complex logistics processes into scalable, high-adoption enterprise software.",
  },
  {
    id: "theme-erp-scale",
    title: "Enterprise platforms",
    isRecommended: false,
    description:
      "Platform scale, integrations, and cross-functional leadership.",
    summaryDraft:
      "Senior Product Manager with 15+ years leading enterprise systems, data pipeline integrations, and cross-functional teams. Owned P&L for a $150M+ portfolio at IBM and established core SaaS architecture at AOT Technologies, accelerating delivery velocity by 4x. Proven track record integrating complex business processes, procurement workflows, and transactional systems into unified enterprise platforms.",
  },
  {
    id: "theme-ai-velocity",
    title: "AI & delivery",
    isRecommended: false,
    description:
      "Predictive analytics, faster releases, and revenue growth.",
    summaryDraft:
      "Product leader with 15+ years experience transforming complex operational workflows through predictive analytics, machine learning, and rapid release cadences. Managed $150M+ annual revenue portfolio at IBM achieving 45% operational cycle-time reductions and 98% compliance. Expert in Agile/Scrum product delivery, establishing first-generation product frameworks, and driving 20% month-over-month growth.",
  },
];

export const DEFAULT_FOCUS_STATE: TailoringFocusState = {
  careerProfile: "Product Leadership (Default)",
  positioningTheme: "Logistics & operations",
  checkedKeywords: [
    "Supply Chain Systems",
    "ERP Integrations",
    "Fleet Operations",
    "Cross-functional Leadership",
    "Process Optimization",
  ],
  summaryText: SUMMARY_POSITIONING_THEMES[0].summaryDraft,
  mappedPhrases: {
    "role-odotrack": [
      "Define product strategy by understanding supply chain market trends, logistics needs, and emerging technologies",
      "Stay up-to-date with emerging supply chain technologies (real-time tracking, automated warehousing, advanced analytics)",
    ],
    "role-aot": [
      "Work closely with engineering to create release plans, define MVP, and drive delivery of supply chain initiatives",
    ],
  },
  additionalGuidance:
    "Emphasize quantitative business metrics, ROI, and operational scale.",
};

export const GENERIC_STARTERS = [
  "Emphasize quantitative business metrics, ROI, and operational scale.",
  "Prioritize cross-functional leadership, executive stakeholder alignment, and team mentorship.",
  "Keep bullet points concise, action-oriented, and focused on outcomes.",
  "Highlight system architecture, integrations, and operational reliability.",
];

interface MockupStep2ChooseFocusProps {
  state: TailoringFocusState;
  onChange: (updater: (prev: TailoringFocusState) => TailoringFocusState) => void;
  onBack: () => void;
  onGenerate: () => void;
  onPreviewMaster?: () => void;
}

export default function MockupStep2ChooseFocus({
  state,
  onChange,
  onBack,
  onGenerate,
  onPreviewMaster,
}: MockupStep2ChooseFocusProps) {
  // Master Resume Preview Dialog State
  const [localMasterViewerOpen, setLocalMasterViewerOpen] = useState(false);

  const handlePreviewMaster = () => {
    if (onPreviewMaster) {
      onPreviewMaster();
    } else {
      setLocalMasterViewerOpen(true);
    }
  };

  // Word Cloud State
  const [selectedKeywordId, setSelectedKeywordId] = useState<string>("kw-supply-chain");
  const [selectedCategory, setSelectedCategory] = useState<
    "all" | "logistics" | "erp" | "product" | "tech"
  >("all");
  const [keywordSearch, setKeywordSearch] = useState("");

  // Summary & Theme State
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [summaryInputText, setSummaryInputText] = useState(state.summaryText);

  // Drag-and-drop state
  const [draggedPhraseText, setDraggedPhraseText] = useState<string | null>(null);
  const [dragOverRoleId, setDragOverRoleId] = useState<string | null>(null);

  const filteredKeywords = JD_WORD_CLOUD_KEYWORDS.filter((kw) => {
    const matchesCategory =
      selectedCategory === "all" || kw.category === selectedCategory;
    const matchesSearch =
      !keywordSearch.trim() ||
      kw.term.toLowerCase().includes(keywordSearch.toLowerCase().trim());
    return matchesCategory && matchesSearch;
  });

  const selectedKeyword =
    JD_WORD_CLOUD_KEYWORDS.find((kw) => kw.id === selectedKeywordId) ||
    filteredKeywords[0] ||
    JD_WORD_CLOUD_KEYWORDS[0];

  // Toggle Keyword Checkmark
  const handleToggleKeyword = (kw: string) => {
    onChange((prev) => {
      const exists = prev.checkedKeywords.includes(kw);
      return {
        ...prev,
        checkedKeywords: exists
          ? prev.checkedKeywords.filter((k) => k !== kw)
          : [...prev.checkedKeywords, kw],
      };
    });
  };

  // Apply a positioning theme as an option for improving the summary
  const handleApplyThemeToSummary = (theme: SummaryPositioningTheme) => {
    onChange((prev) => ({
      ...prev,
      positioningTheme: theme.title,
      summaryText: theme.summaryDraft,
    }));
    setSummaryInputText(theme.summaryDraft);
    setIsEditingSummary(false);
  };

  // Save changes
  const handleSaveSummary = () => {
    onChange((prev) => ({ ...prev, summaryText: summaryInputText.trim() || prev.summaryText }));
    setIsEditingSummary(false);
  };

  // Reset Summary back to Master Default
  const handleResetSummary = () => {
    const masterSummary =
      "Product leader with 15+ years across engineering, consulting, operations, and product management. Owned P&L for a $150M+ AI decisioning portfolio at IBM serving the world's largest banks and retailers, and currently leading the productization of an engineering-centric organization at AOT Technologies: first product framework, first design and marketing hires, 4x delivery velocity, and 20% month-over-month SaaS revenue growth. Hands-on developer roots in Python and Go. Specialty: taking AI from demo to deployed, then navigating the organization so it actually moves revenue, retention, and compliance outcomes.";
    setSummaryInputText(masterSummary);
    onChange((prev) => ({ ...prev, summaryText: masterSummary }));
    setIsEditingSummary(false);
  };

  // Add Phrase to Role
  const handleAddPhraseToRole = (roleId: string, phraseText: string) => {
    onChange((prev) => {
      const existing = prev.mappedPhrases[roleId] || [];
      if (existing.includes(phraseText)) return prev;
      return {
        ...prev,
        mappedPhrases: {
          ...prev.mappedPhrases,
          [roleId]: [...existing, phraseText],
        },
      };
    });
  };

  // Remove Phrase from Role
  const handleRemovePhraseFromRole = (roleId: string, phraseText: string) => {
    onChange((prev) => {
      const existing = prev.mappedPhrases[roleId] || [];
      return {
        ...prev,
        mappedPhrases: {
          ...prev.mappedPhrases,
          [roleId]: existing.filter((p) => p !== phraseText),
        },
      };
    });
  };

  // Append generic starter to guidance
  const handleAppendStarter = (starter: string) => {
    onChange((prev) => {
      const current = prev.additionalGuidance.trim();
      const next = current ? `${current}\n${starter}` : starter;
      return { ...prev, additionalGuidance: next };
    });
  };

  return (
    <div className="w-full space-y-8">
      {/* 1. Candidate Profile Selection & Actions */}
      <section
        aria-labelledby="candidate-profile-heading"
        className="rounded-xl border border-border/50 bg-card p-5 sm:p-6"
      >
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <User className="size-4 text-primary" aria-hidden="true" />
              <h3 id="candidate-profile-heading" className="text-base font-semibold text-foreground sm:text-lg">
                Candidate profile
              </h3>
            </div>
            <label htmlFor="candidate-profile-select" className="sr-only">
              Candidate profile
            </label>
            <select
              id="candidate-profile-select"
              value={state.careerProfile}
              onChange={(e) => onChange((prev) => ({ ...prev, careerProfile: e.target.value }))}
              className="rounded-lg border border-border/80 bg-background px-3 py-1.5 text-xs font-semibold text-foreground shadow-xs focus:border-primary focus:outline-hidden"
            >
              <option value="Product Leadership (Default)">Product Leadership (Default)</option>
              <option value="Senior Technical Product Manager">Senior Technical Product Manager</option>
              <option value="Operations & Logistics Product Manager">Operations & Logistics Product Manager</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePreviewMaster}
              className="gap-1.5 text-xs cursor-pointer"
            >
              <Eye className="size-3.5 text-primary" aria-hidden="true" />
              <span>Preview master resume</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              asChild
              className="gap-1.5 text-xs"
            >
              <a href="/master-resume" target="_blank" rel="noopener noreferrer">
                <span>Edit candidate profile</span>
                <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* 2. Keywords */}
      <section
        aria-labelledby="word-cloud-analytics-heading"
        className="rounded-xl border border-border/50 bg-card p-5  sm:p-6"
      >
        <div className="flex flex-col gap-4 border-b border-border/40 pb-4">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <BarChart3 className="size-4" />
                </div>
                <h3
                  id="word-cloud-analytics-heading"
                  className="text-lg font-semibold tracking-tight text-foreground"
                >
                  Keywords
                </h3>
                <Badge variant="outline" className="text-[11px] font-medium">
                  28 terms
                </Badge>
              </div>

            </div>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-emerald-500" />
                <span>Direct Match</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-sky-500" />
                <span>Transferable</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-amber-500" />
                <span>Flagged Gap</span>
              </span>
            </div>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((cat) => (
              <Button
                key={cat.id}
                type="button"
                size="sm"
                variant={selectedCategory === cat.id ? "default" : "outline"}
                onClick={() => setSelectedCategory(cat.id)}
                className="h-7 text-xs cursor-pointer gap-1.5"
              >
                <span>{cat.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[10px]",
                    selectedCategory === cat.id
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {cat.count}
                </span>
              </Button>
            ))}
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter cloud terms..."
              value={keywordSearch}
              onChange={(e) => setKeywordSearch(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* The Word Cloud Canvas */}
        <div
          role="region"
          aria-label="Keyword Word Cloud"
          className="mt-4 flex min-h-[220px] flex-wrap items-center justify-center gap-2.5 rounded-xl border border-border/40 bg-muted/10 p-6 sm:gap-3 sm:p-8"
        >
          {filteredKeywords.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No keywords match your search query &quot;{keywordSearch}&quot;.
            </div>
          ) : (
            filteredKeywords.map((kw) => {
              const isSelected = selectedKeyword?.id === kw.id;
              const isEmphasized = state.checkedKeywords.includes(kw.term);
              return (
                <button
                  key={kw.id}
                  type="button"
                  onClick={() => setSelectedKeywordId(kw.id)}
                  aria-pressed={isSelected}
                  aria-label={`${kw.term}, mentioned ${kw.count} times, status: ${kw.status}`}
                  className={getKeywordCloudClasses(kw.count, isSelected, isEmphasized, kw.status)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {kw.status === "gap" && (
                      <AlertTriangle
                        className={cn(
                          "size-3 shrink-0",
                          isSelected
                            ? "text-primary-foreground"
                            : "text-amber-600 dark:text-amber-400"
                        )}
                      />
                    )}
                    {isEmphasized && !isSelected && (
                      <Check className="size-3 shrink-0 text-primary" />
                    )}
                    <span>{kw.term}</span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-mono leading-none",
                        isSelected
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : kw.status === "gap"
                          ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                          : kw.status === "transferable"
                          ? "bg-sky-500/20 text-sky-800 dark:text-sky-300"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {kw.count}x
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Selected Keyword Inspector Detail Card */}
        {selectedKeyword && (
          <div className="mt-5 rounded-xl border border-border/80 bg-card p-4 sm:p-5 ">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
              <div className="flex flex-wrap items-center gap-2">

                <span className="text-base font-semibold text-foreground">
                  {selectedKeyword.term}
                </span>
                <Badge variant="outline" className="font-mono text-xs">
                  {selectedKeyword.count}x mentions
                </Badge>
                <Badge
                  variant={
                    selectedKeyword.status === "matched"
                      ? "success"
                      : selectedKeyword.status === "transferable"
                      ? "info"
                      : "warning"
                  }
                  className="text-[11px] capitalize"
                >
                  {selectedKeyword.status === "matched"
                    ? "Direct match"
                    : selectedKeyword.status === "transferable"
                    ? "Transferable"
                    : "Evidence gap"}
                </Badge>
                <Badge variant="secondary" className="text-[11px]">
                  {selectedKeyword.importance} Priority
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={state.checkedKeywords.includes(selectedKeyword.term) ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleToggleKeyword(selectedKeyword.term)}
                  className="h-7 text-xs gap-1.5 cursor-pointer"
                >
                  {state.checkedKeywords.includes(selectedKeyword.term) ? (
                    <>
                      <Check className="size-3 text-primary-foreground" />
                      <span>Selected</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-3 text-amber-500" />
                      <span>Select keyword</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              {/* Candidate Evidence */}
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Resume evidence</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {selectedKeyword.matchEvidence}
                </p>
              </div>

              {/* Lime JD Context */}
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <FileText className="size-3.5 text-sky-600 dark:text-sky-400" />
                  <span>Job excerpt</span>
                </div>
                <p className="mt-2 text-xs italic leading-relaxed text-muted-foreground">
                  &quot;{selectedKeyword.jdSnippet}&quot;
                </p>
              </div>

              {/* Tailoring Action */}
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Sparkles className="size-3.5 text-amber-500" />
                  <span>Suggested emphasis</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {selectedKeyword.tailoringAction}
                </p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 3. Top 5 Scraped JD Phrases & Evidence Match */}
      <section aria-labelledby="top-phrases-match-heading" className="space-y-4">
        <div className="flex items-center gap-2">
          <Quote className="size-4 text-primary" aria-hidden="true" />
          <h3 id="top-phrases-match-heading" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            Priority phrases
          </h3>
        </div>

        {/* Strategic Tailoring Direction Callout */}
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4  sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" aria-hidden="true" />
            </div>
            <div>
              <span className="text-[11px] font-semibold tracking-wide text-primary">
                Recommended focus
              </span>
              <h4 className="mt-0.5 text-base font-semibold text-foreground">
                Fleet logistics & operational outcomes
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Lead with Odotrack logistics and AOT delivery outcomes. NetSuite, Anaplan, and TMS remain evidence gaps.
              </p>
            </div>
          </div>
        </div>

        {/* 5 Phrases Structured List */}
        <div className="space-y-3">
          {TOP_5_PHRASES_MATCH.map((item, index) => {
            const isStrong = item.matchStatus === "Strong Match";
            const isTransferable = item.matchStatus === "Transferable";
            const isGap = item.matchStatus === "Candidate Gap";

            return (
              <div
                key={item.id}
                className={cn(
                  "rounded-xl border p-4  transition-all",
                  isStrong
                    ? "border-emerald-500/40 bg-card"
                    : isTransferable
                    ? "border-sky-500/40 bg-card"
                    : "border-amber-500/40 bg-card"
                )}
              >
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold",
                        isStrong
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                          : isTransferable
                          ? "bg-sky-500/20 text-sky-700 dark:text-sky-400"
                          : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                      )}
                    >
                      {index + 1}
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {item.category}
                        </span>
                        <Badge variant={item.variant} className="text-[10px] font-semibold">
                          {isStrong
                            ? "✓ Strong Match"
                            : isTransferable
                            ? "↔ Transferable"
                            : "⚠ Candidate Gap"}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-xs italic font-medium leading-relaxed text-foreground sm:text-sm">
                        &ldquo;{item.phrase}&rdquo;
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 pt-3 border-t border-border/50 md:grid-cols-2 text-xs">
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      {isGap ? (
                        <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      )}
                      <span>Evidence</span>
                    </span>
                    <p className="mt-1 text-muted-foreground leading-relaxed">
                      {item.evidenceFact}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Sparkles className="size-3.5 text-primary" />
                      <span>Emphasis</span>
                    </span>
                    <p className="mt-1 text-muted-foreground leading-relaxed">
                      {item.tailoringDirection}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 4. Executive Summary & Positioning Themes */}
      <section
        aria-labelledby="summary-positioning-heading"
        className="rounded-xl border border-border/50 bg-card p-5  sm:p-6"
      >
        <div className="border-b border-border/50 pb-4">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden="true" />
                <h3 id="summary-positioning-heading" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
                  Positioning
                </h3>

              </div>

            </div>
          </div>
        </div>

        {/* Options for Improving Summary: 3 Positioning Themes */}
        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground">
              Choose a theme
            </span>

          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SUMMARY_POSITIONING_THEMES.map((theme, idx) => {
              const isSelected = state.positioningTheme === theme.title;
              return (
                <div
                  key={theme.id}
                  className={cn(
                    "relative flex flex-col justify-between rounded-xl border p-4 transition-all",
                    isSelected
                      ? "border-primary bg-primary/10  ring-1 ring-primary/40"
                      : "border-border/60 bg-muted/20 hover:border-border"
                  )}
                >
                  <div>
                    <div className="flex items-start gap-1.5">
                      {theme.isRecommended && (
                        <Star className="size-4 fill-amber-500 text-amber-500 shrink-0 mt-0.5" aria-label="Recommended" />
                      )}
                      <div>
                        <span className="text-xs font-semibold text-foreground leading-snug">
                          {theme.title}
                        </span>
                        {theme.isRecommended && (
                          <Badge variant="outline" className="mt-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px]">
                            Recommended
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="mt-2.5 text-[11px] text-muted-foreground leading-relaxed">
                      {theme.description}
                    </p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between">
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      onClick={() => handleApplyThemeToSummary(theme)}
                      className="h-7 text-xs gap-1 cursor-pointer"
                    >
                      {isSelected ? (
                        <>
                          <Check className="size-3" />
                          <span>Selected</span>
                        </>
                      ) : (
                        <span>Use theme</span>
                      )}
                    </Button>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      Option {idx + 1} of 3
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Active Executive Summary Display & Editor */}
        <div className="mt-6 rounded-xl border border-border/70 bg-muted/10 p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-2 border-b border-border/40 pb-3 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-foreground">Summary</span>
              <Badge variant="secondary" className="text-[11px] font-normal">
                Theme: <strong className="ml-1 font-semibold">{state.positioningTheme}</strong>
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {!isEditingSummary ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSummaryInputText(state.summaryText);
                      setIsEditingSummary(true);
                    }}
                    className="h-7 gap-1.5 text-xs cursor-pointer"
                  >
                    <Edit2 className="size-3" />
                    <span>Edit</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleResetSummary}
                    className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <RotateCcw className="size-3" />
                    <span>Reset</span>
                  </Button>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsEditingSummary(false)}
                    className="h-7 text-xs cursor-pointer"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSaveSummary}
                    className="h-7 gap-1 text-xs cursor-pointer"
                  >
                    <Save className="size-3" />
                    <span>Save</span>
                  </Button>
                </div>
              )}
            </div>
          </div>

          {isEditingSummary ? (
            <div className="mt-3">
              <textarea
                rows={5}
                value={summaryInputText}
                onChange={(e) => setSummaryInputText(e.target.value)}
                className="w-full rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-foreground focus:border-primary focus:outline-hidden"
              />
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-border/50 bg-background/60 p-4">
              <p className="text-xs leading-relaxed text-foreground font-medium sm:text-sm">
                &ldquo;{state.summaryText}&rdquo;
              </p>
            </div>
          )}
        </div>
      </section>

      {/* 5. Selectable JD Phrases Mapped to Previous Experience Roles */}
      <section
        aria-labelledby="experience-mapping-heading"
        className="rounded-xl border border-border/50 bg-card p-5  sm:p-6"
      >
        <div className="border-b border-border/50 pb-3">
          <h3 id="experience-mapping-heading" className="text-base font-semibold tracking-tight text-foreground">
            Experience mapping
          </h3>
          <p className="text-xs text-muted-foreground">
            Drag a phrase to a role, or use Assign.
          </p>
        </div>

        {/* Draggable Phrase Chips Bank */}
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 p-4">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground">
            Job phrases
          </span>
          <div className="mt-2.5 flex flex-wrap gap-2" role="group" aria-label="Selectable JD phrases">
            {AVAILABLE_JD_PHRASES.map((phr) => (
              <div
                key={phr.id}
                draggable
                onDragStart={() => setDraggedPhraseText(phr.text)}
                onDragEnd={() => setDraggedPhraseText(null)}
                className="group flex items-center gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-xs text-foreground  hover:border-primary cursor-grab active:cursor-grabbing"
              >
                <GripVertical className="size-3 text-muted-foreground group-hover:text-primary" />
                <span className="max-w-[320px] truncate">&ldquo;{phr.text}&rdquo;</span>
                <select
                  aria-label={`Assign phrase "${phr.text}" to role`}
                  onChange={(e) => {
                    if (e.target.value) {
                      handleAddPhraseToRole(e.target.value, phr.text);
                      e.target.value = "";
                    }
                  }}
                  className="ml-1 rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <option value="">+ Assign...</option>
                  {MASTER_EXPERIENCE_ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.company}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Experience Roles List */}
        <div className="mt-5 space-y-4">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground">
            Master Resume Experience ({MASTER_EXPERIENCE_ROLES.length} Roles)
          </span>

          <div className="space-y-4">
            {MASTER_EXPERIENCE_ROLES.map((role) => {
              const mapped = state.mappedPhrases[role.id] || [];
              const isOver = dragOverRoleId === role.id;

              return (
                <div
                  key={role.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverRoleId(role.id);
                  }}
                  onDragLeave={() => setDragOverRoleId(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverRoleId(null);
                    if (draggedPhraseText) {
                      handleAddPhraseToRole(role.id, draggedPhraseText);
                    }
                  }}
                  className={`rounded-lg border p-4 transition-all ${
                    isOver
                      ? "border-primary bg-primary/10 shadow-md ring-2 ring-primary"
                      : "border-border/60 bg-muted/10 hover:border-border"
                  }`}
                >
                  <div className="flex flex-col justify-between gap-1 border-b border-border/40 pb-2 sm:flex-row sm:items-center">
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">
                        {role.company} — <span className="font-medium text-muted-foreground">{role.title}</span>
                      </h4>
                      <p className="text-[11px] text-muted-foreground">
                        {role.location} · {role.period}
                      </p>
                    </div>
                    {mapped.length > 0 && (
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {mapped.length} Targeted JD {mapped.length === 1 ? "Phrase" : "Phrases"} Added
                      </Badge>
                    )}
                  </div>

                  {/* Standard Master Bullets */}
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground pl-4 list-disc">
                    {role.bullets.map((b, idx) => (
                      <li key={idx} className="leading-relaxed">
                        {b}
                      </li>
                    ))}
                  </ul>

                  {/* Added JD Phrases at the bottom of the list of bullets */}
                  {mapped.length > 0 && (
                    <div className="mt-3 pt-2 border-t border-border/40 space-y-1.5">
                      <span className="text-[10px] font-semibold tracking-wide text-primary">
                        Assigned phrases
                      </span>
                      {mapped.map((phrase, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between rounded border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs text-foreground"
                        >
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="size-3 text-primary shrink-0" />
                            <span className="italic">&ldquo;{phrase}&rdquo;</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemovePhraseFromRole(role.id, phrase)}
                            className="text-muted-foreground hover:text-rose-600 p-0.5 cursor-pointer"
                            title="Remove phrase"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Droppable indicator area at bottom */}
                  <div className="mt-3 rounded border border-dashed border-border/60 p-2 text-center text-[11px] text-muted-foreground/80">
                    Drop phrase here
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 6. Additional direction (Generic Quick Starters) */}
      <section
        aria-labelledby="guidance-heading"
        className="rounded-xl border border-border/50 bg-card p-5  sm:p-6"
      >
        <div className="border-b border-border/50 pb-3">
          <h3 id="guidance-heading" className="text-base font-semibold tracking-tight text-foreground">
            Additional direction
          </h3>

        </div>

        {/* Generic Starters Chips */}
        <div className="mt-3 flex flex-wrap gap-2">
          {GENERIC_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => handleAppendStarter(starter)}
              className="rounded-lg border border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground cursor-pointer transition-colors"
            >
              + &ldquo;{starter}&rdquo;
            </button>
          ))}
        </div>

        {/* Guidance Textarea */}
        <div className="mt-3">
          <textarea
            rows={3}
            value={state.additionalGuidance}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, additionalGuidance: e.target.value }))
            }
            placeholder="Focus on route optimization, delivery metrics, and cross-functional leadership..."
            className="w-full rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-foreground focus:border-primary focus:outline-hidden"
          />
        </div>
      </section>

      {/* 7. Bottom Actions */}
      <section className="rounded-xl border border-border/50 bg-card p-4">
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            className="gap-1.5 text-xs cursor-pointer"
          >
            <ArrowLeft className="size-3.5" />
            <span>Back</span>
          </Button>
          <Button
            type="button"
            onClick={onGenerate}
            className="gap-2 cursor-pointer"
          >
            <span>Generate resume</span>
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      {/* Master Resume Viewer Dialog */}
      <MockupMasterViewer
        open={localMasterViewerOpen}
        onOpenChange={setLocalMasterViewerOpen}
        master={MASTER_RESUME_FIXTURE}
      />
    </div>
  );
}
