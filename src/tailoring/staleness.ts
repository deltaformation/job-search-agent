import { z } from "zod";
import { canonicalText } from "../domain/canonical";
import { sha256HexUtf8 } from "./hash";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { compareCodePoints } from "./text";
import { validateRequirements } from "./validator";

/**
 * Stale-input gate port (`generate_documents` preconditions 1–4).
 *
 * Pure functions over caller-resolved inputs: the R4-E worker supplies the
 * job description, the bound analysis row, JD snapshots keyed by hash, the
 * bound candidate snapshot row, the current profile hash (recorded by the
 * R4-A snapshot service), and the candidate id. Blocked results mirror the
 * oracle's status/message/blockers shapes exactly.
 *
 * New-model seams (documented, covered by parity carve-outs):
 * - JD text is canonicalized with the R4-A canonical form (NFC/LF plus the
 *   oracle's NUL-strip/trim), so hashes match the oracle byte-for-byte on
 *   plain-ASCII descriptions and follow arch section 3 elsewhere.
 * - A missed JD hash returns `new_jd_snapshot_hash` for R4-E to persist
 *   (the oracle returns the saved row id inline); the parity test maps the
 *   hash to the harness stub id.
 * - Per-requirement canonical parsing mirrors the pydantic model's rules
 *   but reports validator-style/model deterministic messages instead of
 *   pydantic prose; the parity test asserts status/blockers/prefix there.
 */

export interface CanonicalRequirement {
  requirement_id: string;
  jd_quote: string;
  description: unknown;
  category: string;
  importance: string;
  match_status: string;
  evidence_fact_ids: string[];
  evidence_quotes: string[];
  review_status: string;
  analysis_notes: unknown;
}

const VALID_MATCH_STATUS = ["matched", "partial", "gap", "unsupported"];
const VALID_IMPORTANCE = ["required", "preferred", "unspecified"];
const VALID_CATEGORIES = [
  "experience",
  "skill",
  "responsibility",
  "domain",
  "location",
  "compensation",
  "screening",
  "other",
];
const VALID_REVIEW_STATUS = ["proposed", "confirmed"];

function sortedAllowed(values: string[]): string {
  return `{${[...values]
    .sort(compareCodePoints)
    .map((value) => `'${value}'`)
    .join(", ")}}`;
}

function invalidRequirement(detail: string): BlockedResult {
  return {
    status: "blocked",
    message: `Invalid requirement in analysis: ${detail}`,
    blockers: ["INVALID_REQUIREMENT_ANALYSIS"],
  };
}

/**
 * Mirror of `CanonicalRequirement` parsing (aliases, defaults, evidence
 * contract) with deterministic messages. Returns the canonical record or a
 * detail string for the blocked result.
 */
function parseCanonicalRequirement(req: unknown): CanonicalRequirement | { detail: string } {
  if (!isRecord(req)) {
    return { detail: "Requirement must be an object." };
  }
  const rid = req["requirement_id"];
  if (typeof rid !== "string" || rid.trim() === "") {
    return { detail: "requirement_id must be a nonempty string." };
  }
  const quote = req["jd_quote"];
  if (typeof quote !== "string" || quote.trim() === "") {
    return { detail: "jd_quote must be a nonempty string." };
  }
  const status =
    "match_status" in req ? req["match_status"] : ("status" in req ? req["status"] : "unsupported");
  if (typeof status !== "string" || !VALID_MATCH_STATUS.includes(status)) {
    return {
      detail:
        `Requirement '${rid}' has an invalid match_status: '${pyString(status)}'. ` +
        `Allowed: ${sortedAllowed(VALID_MATCH_STATUS)}`,
    };
  }
  const checkEnum = (
    key: string,
    fallback: string,
    valid: string[],
    label: string,
  ): string | { detail: string } => {
    const value = key in req ? req[key] : fallback;
    if (typeof value !== "string" || !valid.includes(value)) {
      return {
        detail:
          `Requirement '${rid}' has invalid ${label} '${pyString(value)}'. ` +
          `Allowed: ${sortedAllowed(valid)}`,
      };
    }
    return value;
  };
  const category = checkEnum("category", "experience", VALID_CATEGORIES, "category");
  if (typeof category !== "string") {
    return category;
  }
  const importance = checkEnum("importance", "required", VALID_IMPORTANCE, "importance");
  if (typeof importance !== "string") {
    return importance;
  }
  const review = checkEnum("review_status", "proposed", VALID_REVIEW_STATUS, "review_status");
  if (typeof review !== "string") {
    return review;
  }
  const checkList = (key: string, alias?: string): string[] | { detail: string } => {
    const value = key in req ? req[key] : alias !== undefined && alias in req ? req[alias] : [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      return { detail: `${key} must contain only nonempty strings.` };
    }
    if (new Set(value).size !== value.length) {
      return { detail: `${key} must not contain duplicates.` };
    }
    return [...value];
  };
  const evidenceIds = checkList("evidence_fact_ids", "matched_fact_ids");
  if (!Array.isArray(evidenceIds)) {
    return evidenceIds;
  }
  const evidenceQuotes = checkList("evidence_quotes");
  if (!Array.isArray(evidenceQuotes)) {
    return evidenceQuotes;
  }
  if (status === "matched" || status === "partial") {
    if (evidenceIds.length === 0) {
      return {
        detail: `Requirement '${rid}' with status '${status}' requires at least one evidence_fact_id.`,
      };
    }
    if (evidenceQuotes.length === 0) {
      return {
        detail: `Requirement '${rid}' with status '${status}' requires non-empty evidence_quotes.`,
      };
    }
  } else {
    if (evidenceIds.length > 0) {
      return {
        detail: `Requirement '${rid}' with status '${status}' must not contain evidence_fact_ids.`,
      };
    }
    if (evidenceQuotes.length > 0) {
      return {
        detail: `Requirement '${rid}' with status '${status}' must not contain evidence_quotes.`,
      };
    }
  }
  return {
    requirement_id: rid,
    jd_quote: quote,
    description: "description" in req ? req["description"] : "",
    category,
    importance,
    match_status: status,
    evidence_fact_ids: evidenceIds,
    evidence_quotes: evidenceQuotes,
    review_status: review,
    analysis_notes: "analysis_notes" in req ? req["analysis_notes"] : null,
  };
}

export interface GateInputs {
  job: unknown;
  profile: unknown;
  analysis: unknown;
  jdSnapshotsByHash: Record<string, unknown>;
  candidateSnapshot: unknown;
  currentProfileHash: string;
  candidateId: string;
}

export interface GateSuccess {
  status: "ok";
  jd_snapshot_id: string;
  candidate_snapshot_id: string;
  requirements: CanonicalRequirement[];
  snapshot_profile: Record<string, unknown>;
  cited_fact_ids: string[];
}

export interface BlockedResult {
  status: "blocked";
  message: string;
  blockers: string[];
  errors?: string[];
  new_jd_snapshot_hash?: string;
  new_jd_snapshot_id?: string;
}

export type GateResult = GateSuccess | BlockedResult;

const GateEnvelope = z.object({
  job: z.unknown(),
  profile: z.unknown(),
  analysis: z.unknown(),
  jdSnapshotsByHash: z.record(z.string(), z.unknown()),
  candidateSnapshot: z.unknown(),
  currentProfileHash: z.string(),
  candidateId: z.string(),
});

function blocked(message: string, blockers: string[], extra?: Partial<BlockedResult>): BlockedResult {
  return { status: "blocked", message, blockers, ...extra };
}

/** Port of the `generate_documents` precondition chain (pre-success path). */
export function checkGenerationInputs(input: GateInputs): GateResult {
  const envelope = GateEnvelope.parse(input);
  if (!pyTruthy(envelope.job) || !pyTruthy(envelope.profile)) {
    throw new Error("Job or candidate profile not found.");
  }

  const description = isRecord(envelope.job) ? envelope.job["description"] : undefined;
  const rawJd = typeof description === "string" ? canonicalText(description) : "";
  if (rawJd === "") {
    return blocked(
      "Job description is empty. Cannot generate tailored resume without a valid job description.",
      ["EMPTY_JD"],
    );
  }

  if (!isRecord(envelope.analysis) && pyTruthy(envelope.analysis)) {
    throw new z.ZodError([
      { code: "custom", message: "analysis must be an object or null", path: ["analysis"] },
    ]);
  }
  const analysis = isRecord(envelope.analysis) ? envelope.analysis : null;
  if (analysis === null || !pyTruthy(analysis["id"])) {
    return blocked(
      "Resume generation requires a validated analysis bound to current JD and candidate profile snapshots.",
      ["ANALYSIS_REQUIRED"],
    );
  }

  const currentHash = sha256HexUtf8(rawJd);
  const jdSnapshot = envelope.jdSnapshotsByHash[currentHash];
  const jdRecord = isRecord(jdSnapshot) ? jdSnapshot : null;
  if (jdRecord === null) {
    return blocked(
      "Job description has changed since the current analysis was created. A new analysis is required.",
      ["STALE_ANALYSIS_JD", "NEW_ANALYSIS_REQUIRED"],
      { new_jd_snapshot_hash: currentHash },
    );
  }
  const currentJdId = pyString(jdRecord["id"] ?? null);
  if (pyString(analysis["jd_snapshot_id"] ?? null) !== currentJdId) {
    return blocked(
      "Job description has changed since the current analysis was created. A new analysis is required.",
      ["STALE_ANALYSIS_JD", "NEW_ANALYSIS_REQUIRED"],
      { new_jd_snapshot_id: currentJdId },
    );
  }

  if (envelope.candidateSnapshot !== null && envelope.candidateSnapshot !== undefined && !isRecord(envelope.candidateSnapshot)) {
    throw new z.ZodError([
      { code: "custom", message: "candidateSnapshot must be an object or null", path: ["candidateSnapshot"] },
    ]);
  }
  const candSnap = isRecord(envelope.candidateSnapshot) ? envelope.candidateSnapshot : null;
  if (candSnap === null) {
    return blocked("Bound candidate profile snapshot not found.", ["CANDIDATE_SNAPSHOT_NOT_FOUND"]);
  }
  if (pyString(candSnap["candidate_id"] ?? null) !== envelope.candidateId) {
    return blocked("Bound candidate profile snapshot belongs to a different candidate.", [
      "CANDIDATE_SNAPSHOT_MISMATCH",
    ]);
  }

  if (pyString(candSnap["snapshot_hash"] ?? null) !== envelope.currentProfileHash) {
    return blocked(
      "Candidate profile has changed since analysis was performed. A new analysis is required.",
      ["STALE_ANALYSIS_PROFILE", "NEW_ANALYSIS_REQUIRED"],
    );
  }

  const snapProfileRaw = candSnap["profile_data"];
  let snapProfile: Record<string, unknown> | null = null;
  if (typeof snapProfileRaw === "string") {
    try {
      const parsed: unknown = JSON.parse(snapProfileRaw);
      snapProfile = isRecord(parsed) ? parsed : null;
    } catch {
      return blocked("Bound candidate profile snapshot contains invalid JSON.", [
        "INVALID_CANDIDATE_SNAPSHOT",
      ]);
    }
    if (snapProfile === null) {
      return blocked("Bound candidate profile snapshot is not a profile object.", [
        "INVALID_CANDIDATE_SNAPSHOT",
      ]);
    }
  } else if (isRecord(snapProfileRaw)) {
    snapProfile = snapProfileRaw;
  } else {
    return blocked("Bound candidate profile snapshot is not a profile object.", [
      "INVALID_CANDIDATE_SNAPSHOT",
    ]);
  }

  const factsRaw = pyTruthy(snapProfile["verified_facts"]) ? snapProfile["verified_facts"] : [];
  if (!Array.isArray(factsRaw)) {
    return blocked("Bound candidate profile snapshot has an invalid verified-facts inventory.", [
      "INVALID_CANDIDATE_SNAPSHOT",
    ]);
  }
  const approvedInSnapshot = new Map<string, Record<string, unknown>>();
  for (const fact of factsRaw) {
    if (isRecord(fact) && typeof fact["fact_id"] === "string" && fact["verification_status"] === "approved") {
      approvedInSnapshot.set(fact["fact_id"], fact);
    }
  }

  const rawRequirements = analysis["requirements"] ?? [];
  if (!Array.isArray(rawRequirements)) {
    return blocked("Analysis requirements must be a list.", ["INVALID_REQUIREMENT_ANALYSIS"]);
  }
  const canonical: CanonicalRequirement[] = [];
  const cited: string[] = [];
  for (const req of rawRequirements) {
    const parsed = parseCanonicalRequirement(req);
    if (!isCanonical(parsed)) {
      return invalidRequirement(parsed.detail);
    }
    canonical.push(parsed);
    cited.push(...parsed.evidence_fact_ids);
  }
  for (const fid of cited) {
    if (!approvedInSnapshot.has(fid)) {
      return blocked(
        `Analysis cites fact '${fid}' which does not exist or is not approved in the candidate snapshot.`,
        ["UNAPPROVED_OR_UNKNOWN_FACT"],
      );
    }
  }

  const cleaned = jdRecord["cleaned_text"];
  const raw = jdRecord["raw_text"];
  const jdText =
    typeof cleaned === "string" && cleaned !== ""
      ? cleaned
      : typeof raw === "string" && raw !== ""
        ? raw
        : "";
  const validated = validateRequirements({ profile: snapProfile, requirements: canonical, jdText });
  if (!validated.valid) {
    return blocked(
      "Analysis requirements do not match their bound snapshots.",
      ["INVALID_REQUIREMENT_ANALYSIS"],
      { errors: validated.errors },
    );
  }

  return {
    status: "ok",
    jd_snapshot_id: currentJdId,
    candidate_snapshot_id: pyString(analysis["candidate_snapshot_id"] ?? null),
    requirements: canonical,
    snapshot_profile: snapProfile,
    cited_fact_ids: cited,
  };
}

function isCanonical(value: CanonicalRequirement | { detail: string }): value is CanonicalRequirement {
  return (value as CanonicalRequirement).requirement_id !== undefined;
}
