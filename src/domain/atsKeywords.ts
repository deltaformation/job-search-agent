/**
 * ATS keyword suggestions (WO-1.2-E). Pure deterministic ranking over the
 * extracted job description — no provider calls, no stemming, no
 * synonyms, no padding. Every suggestion carries its source location so
 * the UI can show *why* a term was suggested before generation.
 *
 * Deterministic signals, in order:
 *
 * 1. Curated phrases (technical + business/domain): case-insensitive
 *    substring matches with term-character boundaries. A hyphen counts
 *    as a term character, so short tokens never match inside hyphenated
 *    compounds ("Go" matches standalone Go, never the "go-to-market"
 *    prefix — the F5 reproduction).
 * 2. Longest span wins: when curated matches nest ("REST" inside
 *    "REST APIs", "Spring" inside "Spring Boot"), only the longest span
 *    survives. Counts reflect surviving spans, so nested duplicates
 *    never inflate a term or appear twice.
 * 3. Rank: curated phrases first, backfill after; each ordered by
 *    frequency desc, then first JD occurrence asc (earlier-introduced
 *    terms rank higher — deterministic and source-grounded).
 * 4. Backfill: frequent substantive tokens (length ≥ 4, non-numeric,
 *    count ≥ 2) ranked the same way, skipping stopwords, boilerplate
 *    ("leverage", "synergy"; "team" was already a stopword), and
 *    anything covered by a picked curated phrase. Sparse sources
 *    honestly yield few or zero suggestions — backfill never pads to
 *    the limit.
 */
export const TOP_ATS_SUGGESTION_LIMIT = 10;

/** Scan cap inherited from the original extractor (offset/excerpt bound). */
const MAX_SCAN_CHARS = 50_000;

/** Curated technical lexicon (display form; matching is case-insensitive). */
const TECH_LEXICON: readonly string[] = [
  "Python",
  "TypeScript",
  "JavaScript",
  "Java",
  "Go",
  "Rust",
  "C++",
  "C#",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "Scala",
  "SQL",
  ".NET",
  "React",
  "Next.js",
  "Vue",
  "Angular",
  "Svelte",
  "Tailwind",
  "GraphQL",
  "REST APIs",
  "REST",
  "gRPC",
  "Node.js",
  "Django",
  "Flask",
  "FastAPI",
  "Spring",
  "Spring Boot",
  "Rails",
  "Express",
  "Laravel",
  ".NET Core",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "Elasticsearch",
  "Cassandra",
  "DynamoDB",
  "Kafka",
  "RabbitMQ",
  "Spark",
  "Airflow",
  "dbt",
  "Snowflake",
  "BigQuery",
  "Redshift",
  "Pandas",
  "NumPy",
  "TensorFlow",
  "PyTorch",
  "scikit-learn",
  "Hugging Face",
  "OpenAI",
  "LLMs",
  "Machine Learning",
  "Deep Learning",
  "NLP",
  "Computer Vision",
  "MLOps",
  "AWS",
  "Azure",
  "GCP",
  "Kubernetes",
  "Docker",
  "Terraform",
  "Jenkins",
  "GitHub Actions",
  "GitLab CI",
  "ArgoCD",
  "Helm",
  "Prometheus",
  "Grafana",
  "Datadog",
  "Linux",
  "Nginx",
  "CI/CD",
  "Microservices",
  "Distributed Systems",
  "System Design",
  "Event-Driven",
  "Serverless",
  "OAuth",
  "SAML",
  "JWT",
  "SOC 2",
  "GDPR",
  "HIPAA",
  "PCI DSS",
  "Agile",
  "Scrum",
  "TDD",
  "iOS",
  "Android",
  "React Native",
  "Flutter",
  "Figma",
  "Tableau",
  "Power BI",
  "Excel",
  "Salesforce",
  "Jira",
  "Git",
];

/**
 * Curated business/domain phrases (WO-1.2-E). Same matching and ranking
 * rules as the technical lexicon; display forms follow the fixtures'
 * natural casing. Deliberately small: every entry is a maintained
 * precision claim pinned by the cross-cutting keywords.json manifest.
 */
const BUSINESS_PHRASES: readonly string[] = [
  "product strategy",
  "roadmap prioritization",
  "customer discovery",
  "B2B SaaS",
  "stakeholder management",
  "go-to-market",
  "platform strategy",
  "pipeline generation",
  "enterprise accounts",
  "discovery calls",
  "forecast accuracy",
  "pricing",
  "experimentation",
];

const BACKFILL_STOPWORDS: ReadonlySet<string> = new Set(
  [
    "about",
    "across",
    "after",
    "again",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "being",
    "bonus",
    "both",
    "candidate",
    "company",
    "could",
    "daily",
    "description",
    "develop",
    "development",
    "doing",
    "each",
    "engineer",
    "engineering",
    "engineers",
    "etc",
    "every",
    "experience",
    "first",
    "from",
    "good",
    "great",
    "have",
    "help",
    "here",
    "high",
    "including",
    "into",
    "join",
    "just",
    "know",
    "knowledge",
    "large",
    "like",
    "looking",
    "make",
    "many",
    "more",
    "most",
    "must",
    "need",
    "new",
    "nice",
    "other",
    "over",
    "passion",
    "plus",
    "position",
    "preferred",
    "proficient",
    "required",
    "responsibilities",
    "responsible",
    "requirements",
    "role",
    "should",
    "skills",
    "some",
    "strong",
    "such",
    "take",
    "team",
    "teams",
    "that",
    "their",
    "them",
    "there",
    "these",
    "they",
    "things",
    "this",
    "those",
    "through",
    "user",
    "using",
    "want",
    "ways",
    "what",
    "when",
    "where",
    "which",
    "will",
    "with",
    "within",
    "work",
    "working",
    "would",
    "years",
    "your",
  ].map((word) => word.toLowerCase()),
);

/**
 * Boilerplate excluded even when frequent (WO-1.2-E, sales-business
 * manifest): genuine filler that would otherwise backfill on sparse
 * JD copy. Curated phrases are never boilerplate-filtered.
 */
const BOILERPLATE: ReadonlySet<string> = new Set(["leverage", "synergy"]);

/**
 * Fixed phrase-category dictionary (WO-1.3-D, contracts §3.1): curated
 * technical lexicon hits read "Technical", curated business/domain
 * phrases read "Business", and everything else (backfill tokens) falls
 * back to "Other". Lookup is case-insensitive over display forms; the
 * extractor never emits a backfill token that collides with a curated
 * entry, so the mapping is exact.
 */
export type AtsKeywordCategory = "Technical" | "Business" | "Other";

export function atsKeywordCategory(keyword: string): AtsKeywordCategory {
  const folded = keyword.toLowerCase();
  if (TECH_LEXICON.some((entry) => entry.toLowerCase() === folded)) {
    return "Technical";
  }
  if (BUSINESS_PHRASES.some((entry) => entry.toLowerCase() === folded)) {
    return "Business";
  }
  return "Other";
}

export interface AtsKeyword {
  keyword: string;
  count: number;
  curated: boolean;
  /** Source excerpt around the first match; null only when text is empty. */
  excerpt: string;
  /** Character offset of the first match in the original text. */
  offset: number;
}

function isTermChar(char: string | undefined): boolean {
  if (char === undefined || char === "") {
    return false;
  }
  // Hyphen counts as a term character so short tokens never match
  // inside hyphenated compounds ("Go" vs "go-to-market").
  return /[A-Za-z0-9_-]/.test(char);
}

interface MatchSpan {
  entry: string;
  start: number;
  end: number;
}

/** All boundary-checked occurrences of one entry (case-insensitive). */
function findSpans(haystack: string, lowered: string, entry: string): MatchSpan[] {
  const needle = entry.toLowerCase();
  const spans: MatchSpan[] = [];
  let from = 0;
  for (;;) {
    const index = lowered.indexOf(needle, from);
    if (index === -1) {
      return spans;
    }
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = haystack[index + needle.length];
    if (!isTermChar(before) && !isTermChar(after)) {
      spans.push({ entry, start: index, end: index + needle.length });
    }
    from = index + 1;
  }
}

const EXCERPT_RADIUS = 70;

/**
 * Deterministic source window around a match. Offsets address the
 * original text; the window is sliced first and collapsed after, so
 * multi-line descriptions never shift the excerpt away from the match.
 */
function excerptFor(text: string, start: number, end: number): string {
  const begin = Math.max(0, start - EXCERPT_RADIUS);
  const finish = Math.min(text.length, end + EXCERPT_RADIUS);
  const window = text.slice(begin, finish).replace(/\s+/g, " ").trim();
  const prefix = begin > 0 ? "… " : "";
  const suffix = finish < text.length ? " …" : "";
  return `${prefix}${window}${suffix}`;
}

/**
 * Ranked ATS keyword suggestions with source locations. Curated
 * lexicon hits first, then frequent substantive tokens; ties break by
 * phrase length, then display name. Never pads: sparse sources yield
 * few or zero suggestions.
 */
export function extractAtsKeywords(
  jdText: string,
  limit: number = TOP_ATS_SUGGESTION_LIMIT,
): AtsKeyword[] {
  const bounded = Math.max(0, Math.min(50, Math.floor(limit)));
  if (bounded === 0) {
    return [];
  }
  const text = jdText.slice(0, MAX_SCAN_CHARS);
  // Longest span wins across the whole curated lexicon: nested
  // matches ("REST" inside "REST APIs") never double-count.
  const lowered = text.toLowerCase();
  const candidates: MatchSpan[] = [];
  for (const entry of TECH_LEXICON) {
    candidates.push(...findSpans(text, lowered, entry));
  }
  for (const entry of BUSINESS_PHRASES) {
    candidates.push(...findSpans(text, lowered, entry));
  }
  candidates.sort(
    (left, right) =>
      right.end - right.start - (left.end - left.start) || left.start - right.start,
  );
  const accepted: MatchSpan[] = [];
  for (const span of candidates) {
    const nested = accepted.some(
      (other) =>
        other.start <= span.start &&
        other.end >= span.end &&
        other.end - other.start > span.end - span.start,
    );
    if (!nested) {
      accepted.push(span);
    }
  }
  const byEntry = new Map<string, MatchSpan[]>();
  for (const span of accepted) {
    const list = byEntry.get(span.entry) ?? [];
    list.push(span);
    byEntry.set(span.entry, list);
  }
  const curated: AtsKeyword[] = [...byEntry.entries()].map(([keyword, spans]) => {
    spans.sort((left, right) => left.start - right.start);
    const first = spans[0] as MatchSpan;
    return {
      keyword,
      count: spans.length,
      curated: true,
      excerpt: excerptFor(text, first.start, first.end),
      offset: first.start,
    };
  });

  const picked = new Set(curated.map((entry) => entry.keyword.toLowerCase()));
  const seen = new Set<string>();
  const backfill: AtsKeyword[] = [];
  for (const token of text.split(/[^A-Za-z0-9+#]+/)) {
    const word = token.toLowerCase();
    if (
      word.length < 4 ||
      /^\\d+$/.test(word) ||
      BACKFILL_STOPWORDS.has(word) ||
      BOILERPLATE.has(word) ||
      seen.has(word)
    ) {
      continue;
    }
    seen.add(word);
    if (picked.has(word)) {
      continue;
    }
    // Boundary-checked occurrences only, mirroring curated matching.
    const spans = findSpans(text, lowered, word);
    if (spans.length < 2) {
      continue;
    }
    // Never duplicate a picked curated phrase with a fragment token.
    let covered = false;
    for (const keyword of picked) {
      if (keyword.includes(word) || word.includes(keyword)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      const first = spans[0] as MatchSpan;
      backfill.push({
        keyword: word,
        count: spans.length,
        curated: false,
        excerpt: excerptFor(text, first.start, first.end),
        offset: first.start,
      });
    }
  }

  // Curated phrases first, backfill after; each ranked by frequency
  // desc, then first JD occurrence asc.
  const rank = (left: AtsKeyword, right: AtsKeyword): number =>
    right.count - left.count || left.offset - right.offset;
  curated.sort(rank);
  backfill.sort(rank);
  return [...curated, ...backfill].slice(0, bounded);
}
