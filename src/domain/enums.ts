import { z } from "zod";

/**
 * Shared state enums. Each list mirrors an R1-B SQLite CHECK constraint
 * exactly; if a value is added to one side it must be added to the other.
 * Services validate untrusted input with these schemas before touching the
 * database so violations fail fast with readable errors.
 */

export const BoardStatus = z.enum([
  "NEW",
  "TAILORED",
  "APPLIED",
  "INTERVIEWED",
  "REJECTED",
]);
export type BoardStatus = z.infer<typeof BoardStatus>;

export const ScrapeState = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
]);
export type ScrapeState = z.infer<typeof ScrapeState>;

export const TailoringState = z.enum([
  "PENDING",
  "READY",
  "BLOCKED",
  "RUNNING",
  "AWAITING_REVIEW",
  "APPROVED",
  "REVISION_REQUESTED",
  "DECLINED",
  "FAILED",
]);
export type TailoringState = z.infer<typeof TailoringState>;

/** Lifecycle of one immutable resume version row. */
export const ReviewState = z.enum([
  "DRAFT",
  "AWAITING_REVIEW",
  "APPROVED",
  "REVISION_REQUESTED",
  "DECLINED",
  "FAILED",
]);
export type ReviewState = z.infer<typeof ReviewState>;

export const WorkKind = z.enum(["SCRAPE", "TAILOR", "PREPARE"]);
export type WorkKind = z.infer<typeof WorkKind>;

export const WorkState = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type WorkState = z.infer<typeof WorkState>;

/** Shared by `scrape_attempts.outcome` and `work_attempts.result`. */
export const AttemptResult = z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]);
export type AttemptResult = z.infer<typeof AttemptResult>;

/**
 * Stored `work_attempts.result` (WO-1.2-D §6): claims INSERT the row as
 * RUNNING so mid-run output can reference it; completion and recovery
 * finish it to a terminal `AttemptResult` exactly once. Completion
 * input still takes `AttemptResult` only — callers can never file
 * RUNNING as an outcome.
 */
export const WorkAttemptState = z.enum(["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"]);
export type WorkAttemptState = z.infer<typeof WorkAttemptState>;

export const IntakeOutcome = z.enum([
  "PENDING",
  "ENQUEUED",
  "INVALID",
  "DUPLICATE",
  "BLOCKED",
]);
export type IntakeOutcome = z.infer<typeof IntakeOutcome>;

export const SourceArtifactKind = z.enum(["HTML", "TEXT", "JSONLD"]);
export type SourceArtifactKind = z.infer<typeof SourceArtifactKind>;

export const ResumeArtifactKind = z.enum(["MARKDOWN", "DOCX", "PDF"]);
export type ResumeArtifactKind = z.infer<typeof ResumeArtifactKind>;

export const Arrangement = z.enum(["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"]);
export type Arrangement = z.infer<typeof Arrangement>;

export const Verification = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type Verification = z.infer<typeof Verification>;

export const ReviewAction = z.enum(["APPROVED", "REVISION_REQUESTED", "DECLINED"]);
export type ReviewAction = z.infer<typeof ReviewAction>;

/** `applications.recorded_by`: only humans record applications. */
export const RecordedBy = z.literal("human");
export type RecordedBy = z.infer<typeof RecordedBy>;

/**
 * How a profile source document entered the store (R-ADR-016).
 * Mirrors `candidate_sources_origin`; reconstructed/legacy mark
 * backfilled bytes that were never an original upload.
 */
export const SourceOrigin = z.enum([
  "upload",
  "paste",
  "form",
  "copy",
  "cli",
  "reconstructed",
  "legacy",
]);
export type SourceOrigin = z.infer<typeof SourceOrigin>;

/** Salary-expectation period (work-preferences JSON only; no CHECK). */
export const SalaryPeriod = z.enum(["HOURLY", "MONTHLY", "ANNUAL"]);
export type SalaryPeriod = z.infer<typeof SalaryPeriod>;

/** Minimum reason-code vocabulary (architecture section 6). */
export const ReasonCode = z.enum([
  "INVALID_URL",
  "DUPLICATE_URL",
  "PRIVATE_NETWORK",
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "ACCESS_DENIED",
  "TIMEOUT",
  "EXTRACTION_INCOMPLETE",
  "UNSUPPORTED_PAGE",
  "PROFILE_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "STALE_INPUT",
  // R4-E: deterministic document rendering failed (page budget, minimum
  // text, or cross-format containment). Widening only; stored codes stay valid.
  "RENDER_FAILED",
  // WO-1.2-D: the active version was declined by explicit human command.
  // Widening only; stored codes stay valid.
  "VERSION_DECLINED",
  // WO-1.3-F: v1.3 worker failure codes. terminalFail persists the
  // precise Failure code as both the job reason and the request error
  // code, so Step 3 and transaction R classify from actual codes.
  // Widening only; stored codes stay valid.
  "CONFIGURATION",
  "AUTHENTICATION",
  "RATE_LIMIT",
  "NETWORK",
  "PROVIDER_TIMEOUT",
  "LOCAL_LAUNCH",
  "INVALID_RESPONSE",
  "INPUT_STALE",
  "PROFILE_UNAVAILABLE",
  "CLAIM_VALIDATION",
  "PUBLISH_FAILED",
  "INTERNAL",
  // WO-1.3-F: recovery-side exhaustion marker. Only the dispatcher
  // (never the lease-losing worker itself) persists this reason, when
  // stale recovery finished a run's last attempt. Widening only.
  "LEASE_LOST",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;
