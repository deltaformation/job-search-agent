/**
 * Deterministic ATS keyword suggestions from job description text.
 *
 * Pure domain module (safe to import from client components): no I/O,
 * no randomness, no time. Extraction ranks a curated technology lexicon
 * by occurrence count, then backfills with frequent substantive tokens.
 * Every ordering has an explicit tiebreak, so the same text always
 * yields the same list. Suggestions steer the user's tailoring guidance
 * only — selected keywords never become resume claims without approved
 * fact evidence.
 */

export interface AtsKeyword {
  keyword: string;
  /** Occurrence count in the scanned text (lexicon hits or token count). */
  count: number;
  /** True when the keyword came from the curated lexicon. */
  curated: boolean;
}

export const TOP_ATS_SUGGESTION_LIMIT = 10;

/** Upper bound on scanned input; JDs beyond this are truncated. */
const MAX_SCAN_CHARS = 50_000;

/** Canonical display forms; matching is case-insensitive. */
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

/** Boilerplate excluded from frequency backfill (lowercase). */
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
 * Characters that may not touch a lexicon hit on either side. Alnum-only
 * by design: sentence punctuation ("Docker.") must not block a match,
 * while "Java" inside "JavaScript" still fails on the `S`.
 */
function isTermChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

/** Count whole-term occurrences of `term` in `lower` (both lowercase). */
function countOccurrences(lower: string, term: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = lower.indexOf(term, from);
    if (at === -1) {
      return count;
    }
    const before = at === 0 ? undefined : lower[at - 1];
    const after = at + term.length >= lower.length ? undefined : lower[at + term.length];
    if (!isTermChar(before) && !isTermChar(after)) {
      count += 1;
    }
    from = at + term.length;
  }
}

/**
 * Top ATS keyword suggestions for JD text: lexicon hits ranked by count
 * (ties by canonical form), backfilled with frequent substantive tokens
 * (ties alphabetical) up to `limit`. Deterministic for identical input.
 */
export function extractAtsKeywords(jdText: string, limit: number = TOP_ATS_SUGGESTION_LIMIT): AtsKeyword[] {
  const bounded = Math.max(0, Math.min(50, Math.floor(limit)));
  if (bounded === 0) {
    return [];
  }
  const lower = jdText.slice(0, MAX_SCAN_CHARS).toLowerCase();
  if (lower.trim() === "") {
    return [];
  }
  const seen = new Set<string>();
  const curated: AtsKeyword[] = [];
  for (const term of TECH_LEXICON) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const count = countOccurrences(lower, key);
    if (count > 0) {
      curated.push({ keyword: term, count, curated: true });
    }
  }
  curated.sort((a, b) => b.count - a.count || (a.keyword < b.keyword ? -1 : 1));
  const picked = curated.slice(0, bounded);
  if (picked.length >= bounded) {
    return picked;
  }
  // Backfill: frequent substantive tokens not already covered. A token is
  // covered when it contains or is contained in a picked keyword, so
  // "postgres" never duplicates "PostgreSQL".
  const covered = (token: string): boolean =>
    picked.some((entry) => {
      const keyword = entry.keyword.toLowerCase();
      return keyword.includes(token) || token.includes(keyword);
    });
  const counts = new Map<string, number>();
  for (const token of lower.split(/[^a-z0-9+#]+/)) {
    if (
      token.length < 4 ||
      BACKFILL_STOPWORDS.has(token) ||
      /^\d+$/.test(token) ||
      covered(token)
    ) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const backfill = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([keyword, count]) => ({ keyword, count, curated: false }))
    .sort((a, b) => b.count - a.count || (a.keyword < b.keyword ? -1 : 1));
  return [...picked, ...backfill].slice(0, bounded);
}
