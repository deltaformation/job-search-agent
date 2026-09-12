import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { candidateFacts } from "../db/schema/candidates";
import { jobAnalyses } from "../db/schema/analysis";
import {
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeReviews,
  resumeVersions,
  type ResumeVersion,
} from "../db/schema/resumes";
import { casJobTailoringState, getTailoringJob, type TailoringJobRow } from "../db/tailoring";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import { checkRowVersion } from "../domain/board";
import { canonicalJson } from "../domain/canonical";
import { EntityId, IsoUtcDateTime, RowVersion } from "../domain/fields";
import { planReviewTransition } from "../domain/review";
import { planTailoringTransition } from "../domain/tailoring";
import type { ReviewState, TailoringState } from "../domain/enums";
import { resolveArtifactPath } from "../security/paths";
import { requestRevisionRun } from "../tailoring/enqueue";
import { approveTailored, type WorkflowCommandFailure } from "./workflow";

/**
 * Resume review commands and read model (R4-F).
 *
 * Approval is exact-version and human-only: the service re-hashes the three
 * stored artifacts from disk, verifies every binding (job NEW, tailoring
 * AWAITING_REVIEW, active pointer, version AWAITING_REVIEW), records an
 * append-only review binding resume/content/artifact hashes, and lets the
 * R3-A Tailored gate move the card — all in one transaction. A revision
 * request records a REVISION_REQUESTED review and enqueues a follow-up
 * TAILOR run in the same transaction, so every revision leads to a new
 * child version.
 *
 * The actor is pinned to `human` at the schema level, and routes force it
 * server-side: no request body can approve as an agent. Filesystem reads
 * happen outside the transaction; the transaction itself only re-verifies
 * database state, writes review rows, and runs the gate.
 */

const HumanActor = z.literal("human");

const ReviewNote = z.string().trim().min(1).max(4000);

const OptionalReviewNote = z.string().trim().max(4000).optional();

export const ApproveResumeInput = z
  .object({
    jobId: EntityId,
    resumeVersionId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    note: OptionalReviewNote,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type ApproveResumeInput = z.infer<typeof ApproveResumeInput>;

export const RequestRevisionInput = z
  .object({
    jobId: EntityId,
    resumeVersionId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    /** The human must say what is wrong; the note persists on the review. */
    note: ReviewNote,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type RequestRevisionInput = z.infer<typeof RequestRevisionInput>;

export type ReviewCommandError =
  | "unknown-job"
  | "unknown-version"
  | "conflict"
  | "forbidden"
  | "stale-version"
  | "tailored-binding"
  | "artifact-incomplete"
  | "artifact-unreadable"
  | "artifact-mismatch";

export interface ReviewCommandFailure {
  ok: false;
  error: ReviewCommandError;
  detail: string;
  currentRowVersion?: number;
}

function failure(
  error: ReviewCommandError,
  detail: string,
  currentRowVersion?: number,
): ReviewCommandFailure {
  return currentRowVersion === undefined
    ? { ok: false, error, detail }
    : { ok: false, error, detail, currentRowVersion };
}

export type ApproveResumeResult =
  | {
      ok: true;
      jobId: string;
      resumeVersionId: string;
      version: number;
      reviewId: string;
      eventId: string;
      newRowVersion: number;
      resumeHash: string;
      contentHash: string;
      artifactHashes: { markdown: string; docx: string; pdf: string };
    }
  | ReviewCommandFailure;

export type RequestRevisionResult =
  | {
      ok: true;
      jobId: string;
      resumeVersionId: string;
      version: number;
      reviewId: string;
      workItemId: string;
      /** True when the follow-up run already existed (retried command). */
      deduped: boolean;
      newRowVersion: number;
    }
  | ReviewCommandFailure;

/**
 * Lineage-binding resume hash recorded on every review. `contentHash`
 * identifies the rendered bytes; `resumeHash` identifies the exact version
 * row those bytes came from — id, job, number, parent, analysis, and every
 * template/ranker/policy/config lineage field — so a review row alone
 * proves what was approved without trusting a bare version id.
 */
export function resumeIdentityHash(version: {
  id: string;
  jobId: string;
  version: number;
  parentVersionId: string | null;
  analysisId: string;
  templateId: string;
  templateVersion: string;
  templateHash: string;
  rankerVersion: string;
  policyVersion: string;
  configVersion: string;
  renderSchemaVersion: string;
  contentHash: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: "resume-identity/v1",
        resumeVersionId: version.id,
        jobId: version.jobId,
        version: version.version,
        parentVersionId: version.parentVersionId,
        analysisId: version.analysisId,
        templateId: version.templateId,
        templateVersion: version.templateVersion,
        templateHash: version.templateHash,
        rankerVersion: version.rankerVersion,
        policyVersion: version.policyVersion,
        configVersion: version.configVersion,
        renderSchemaVersion: version.renderSchemaVersion,
        contentHash: version.contentHash,
      }),
      "utf8",
    )
    .digest("hex");
}

interface ReviewTarget {
  job: TailoringJobRow;
  version: ResumeVersion;
}

type TargetResult = { ok: true; target: ReviewTarget } | { ok: false; failure: ReviewCommandFailure };

/**
 * Load the job and version and verify they belong together with the
 * version as the job's active pointer. A version from another job, or a
 * superseded version, is `stale-version`: reviewing anything but the
 * current active version would approve or revise the wrong output.
 */
function loadReviewTarget(
  handle: DatabaseHandle,
  jobId: string,
  resumeVersionId: string,
): TargetResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return { ok: false, failure: failure("unknown-job", `job ${jobId} does not exist`) };
  }
  const version = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, resumeVersionId))
    .get();
  if (version === undefined || version.jobId !== jobId) {
    return {
      ok: false,
      failure: failure("unknown-version", `resume version ${resumeVersionId} does not exist`),
    };
  }
  if (job.activeResumeVersionId !== resumeVersionId) {
    return {
      ok: false,
      failure: failure(
        "stale-version",
        `resume v${version.version} is not the job's active version`,
        job.rowVersion,
      ),
    };
  }
  return { ok: true, target: { job, version } };
}

function checkVersionFreshness(
  target: ReviewTarget,
  observedRowVersion: number,
): ReviewCommandFailure | null {
  const version = checkRowVersion(target.job.rowVersion, observedRowVersion);
  if (!version.ok) {
    return failure(
      "conflict",
      `stale client: observed row_version ${version.observedRowVersion}, current is ${version.currentRowVersion}`,
      version.currentRowVersion,
    );
  }
  return null;
}

export interface ArtifactDigests {
  markdown: string;
  docx: string;
  pdf: string;
}

type ArtifactVerifyResult =
  | { ok: true; digests: ArtifactDigests }
  | { ok: false; failure: ReviewCommandFailure };

/**
 * Re-hash the version's three artifacts from disk and compare against the
 * recorded digests and byte sizes. Any drift — tampering, truncation, or
 * a replaced file — fails the approval loudly instead of binding the
 * wrong bytes. Callers must run this outside any transaction: it performs
 * filesystem reads.
 */
export function verifyVersionArtifacts(
  handle: DatabaseHandle,
  resumeVersionId: string,
  artifactsDir: string,
): ArtifactVerifyResult {
  const rows = handle.db
    .select()
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, resumeVersionId))
    .all();
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const markdown = byKind.get("MARKDOWN");
  const docx = byKind.get("DOCX");
  const pdf = byKind.get("PDF");
  if (markdown === undefined || docx === undefined || pdf === undefined) {
    const kinds = [...byKind.keys()].sort().join(", ") || "none";
    return {
      ok: false,
      failure: failure(
        "artifact-incomplete",
        `resume artifacts are incomplete (have: ${kinds}); all of MARKDOWN, DOCX, PDF are required`,
      ),
    };
  }
  const digests: ArtifactDigests = { markdown: "", docx: "", pdf: "" };
  for (const row of [markdown, docx, pdf] as const) {
    let absolute: string;
    try {
      absolute = resolveArtifactPath(artifactsDir, row.relativePath);
    } catch {
      return {
        ok: false,
        failure: failure(
          "artifact-unreadable",
          `${row.kind} artifact path is rejected by the data-root policy`,
        ),
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      return {
        ok: false,
        failure: failure(
          "artifact-unreadable",
          `${row.kind} artifact bytes are missing from the artifact store`,
        ),
      };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256 || bytes.length !== row.byteSize) {
      return {
        ok: false,
        failure: failure(
          "artifact-mismatch",
          `${row.kind} artifact bytes do not match the recorded digest`,
        ),
      };
    }
    if (row.kind === "MARKDOWN") {
      digests.markdown = sha256;
    } else if (row.kind === "DOCX") {
      digests.docx = sha256;
    } else {
      digests.pdf = sha256;
    }
  }
  return { ok: true, digests };
}

/**
 * Stored digests for revision reviews. A revision must be requestable even
 * when artifact bytes are damaged — damage is a reason to revise, not a
 * blocker — so this binds the recorded digests without touching disk.
 */
function storedArtifactDigests(
  handle: DatabaseHandle,
  resumeVersionId: string,
): ArtifactDigests | null {
  const rows = handle.db
    .select()
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, resumeVersionId))
    .all();
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const markdown = byKind.get("MARKDOWN");
  const docx = byKind.get("DOCX");
  const pdf = byKind.get("PDF");
  if (markdown === undefined || docx === undefined || pdf === undefined) {
    return null;
  }
  return { markdown: markdown.sha256, docx: docx.sha256, pdf: pdf.sha256 };
}

/** Thrown to roll back when the Tailored gate rejects after review writes. */
class GateRejected extends Error {
  readonly failure: WorkflowCommandFailure;

  constructor(failure: WorkflowCommandFailure) {
    super(`tailored gate rejected the approval: ${failure.error}`);
    this.name = "GateRejected";
    this.failure = failure;
  }
}

/**
 * Exact-version human approval. Verifies bindings and artifact bytes, then
 * in one transaction marks the version APPROVED, appends the review, and
 * runs the Tailored gate (board → TAILORED, tailoring → APPROVED, event).
 * A gate rejection throws `GateRejected` so the review writes roll back
 * with it — an approval either lands completely or writes nothing.
 */
export function approveResume(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps: { artifactsDir: string },
): ApproveResumeResult {
  const input = ApproveResumeInput.parse(rawInput);
  const now = input.now ?? utcNow();

  // Pre-transaction verification: filesystem reads must stay out of the
  // SQLite transaction. Every database predicate is re-verified inside.
  const pre = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
  if (!pre.ok) {
    return pre.failure;
  }
  const preFresh = checkVersionFreshness(pre.target, input.observedRowVersion);
  if (preFresh !== null) {
    return preFresh;
  }
  const preApprovable = checkApprovable(pre.target);
  if (preApprovable !== null) {
    return preApprovable;
  }
  const verified = verifyVersionArtifacts(handle, input.resumeVersionId, deps.artifactsDir);
  if (!verified.ok) {
    return verified.failure;
  }
  const resumeHash = resumeIdentityHash(pre.target.version);
  const contentHash = pre.target.version.contentHash;

  try {
    return withTransaction(handle.sqlite, () => {
      const loaded = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
      if (!loaded.ok) {
        return loaded.failure;
      }
      const fresh = checkVersionFreshness(loaded.target, input.observedRowVersion);
      if (fresh !== null) {
        return fresh;
      }
      const approvable = checkApprovable(loaded.target);
      if (approvable !== null) {
        return approvable;
      }
      handle.db
        .update(resumeVersions)
        .set({ reviewState: "APPROVED", updatedAt: now })
        .where(eq(resumeVersions.id, input.resumeVersionId))
        .run();
      const reviewId = newId();
      handle.db
        .insert(resumeReviews)
        .values({
          id: reviewId,
          resumeVersionId: input.resumeVersionId,
          action: "APPROVED",
          actor: "human",
          note: input.note ?? null,
          resumeHash,
          contentHash,
          artifactHashesJson: canonicalJson(verified.digests),
          createdAt: now,
        })
        .run();
      const gated = approveTailored(handle, {
        jobId: input.jobId,
        resumeVersionId: input.resumeVersionId,
        observedRowVersion: input.observedRowVersion,
        actor: "human",
        now,
      });
      if (!gated.ok) {
        throw new GateRejected(gated);
      }
      return {
        ok: true as const,
        jobId: input.jobId,
        resumeVersionId: input.resumeVersionId,
        version: loaded.target.version.version,
        reviewId,
        eventId: gated.eventId,
        newRowVersion: gated.newRowVersion,
        resumeHash,
        contentHash,
        artifactHashes: verified.digests,
      };
    });
  } catch (error: unknown) {
    if (error instanceof GateRejected) {
      const gated = error.failure;
      return gated.error === "conflict"
        ? failure(gated.error, gated.detail, gated.currentRowVersion)
        : failure(
            gated.error === "unknown-job" || gated.error === "tailored-binding"
              ? gated.error
              : "forbidden",
            gated.detail,
            gated.currentRowVersion,
          );
    }
    throw error;
  }
}

function checkApprovable(target: ReviewTarget): ReviewCommandFailure | null {
  if (target.job.status !== "NEW") {
    return failure(
      "forbidden",
      `approval moves only NEW jobs to TAILORED (job is ${target.job.status})`,
      target.job.rowVersion,
    );
  }
  if (target.job.tailoringState !== "AWAITING_REVIEW") {
    return failure(
      "forbidden",
      `job tailoring is ${target.job.tailoringState}, not AWAITING_REVIEW`,
      target.job.rowVersion,
    );
  }
  const planned = planReviewTransition(target.version.reviewState as ReviewState, {
    to: "APPROVED",
  });
  if (!planned.ok) {
    return failure(
      "forbidden",
      `resume v${target.version.version} is ${target.version.reviewState}: ${planned.detail}`,
      target.job.rowVersion,
    );
  }
  return null;
}

/**
 * Human revision request. In one transaction: fence the job, mark the
 * version REVISION_REQUESTED, append the review with the human note bound
 * to the stored digests, move tailoring to REVISION_REQUESTED, and enqueue
 * the follow-up TAILOR run — so the request atomically leads to a new
 * child version. The compare-and-swap runs before any write: a lost race
 * returns `conflict` with nothing written.
 */
export function requestRevision(
  handle: DatabaseHandle,
  rawInput: unknown,
): RequestRevisionResult {
  const input = RequestRevisionInput.parse(rawInput);
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const loaded = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
    if (!loaded.ok) {
      return loaded.failure;
    }
    const { job, version } = loaded.target;
    const fresh = checkVersionFreshness(loaded.target, input.observedRowVersion);
    if (fresh !== null) {
      return fresh;
    }
    if (job.status === "REJECTED") {
      return failure(
        "forbidden",
        "rejected jobs cannot request revision; correct the job back first",
        job.rowVersion,
      );
    }
    const tailorPlanned = planTailoringTransition(job.tailoringState as TailoringState, {
      to: "REVISION_REQUESTED",
    });
    if (!tailorPlanned.ok) {
      return failure(
        "forbidden",
        `job tailoring is ${job.tailoringState}: ${tailorPlanned.detail}`,
        job.rowVersion,
      );
    }
    const planned = planReviewTransition(version.reviewState as ReviewState, {
      to: "REVISION_REQUESTED",
    });
    if (!planned.ok) {
      return failure(
        "forbidden",
        `resume v${version.version} is ${version.reviewState}: ${planned.detail}`,
        job.rowVersion,
      );
    }
    if (job.activeExtractionId === null) {
      return failure(
        "stale-version",
        "job has no active extraction for the follow-up revision run",
        job.rowVersion,
      );
    }
    const digests = storedArtifactDigests(handle, version.id);
    if (digests === null) {
      return failure(
        "artifact-incomplete",
        "resume artifacts are incomplete; the review cannot bind its digests",
        job.rowVersion,
      );
    }
    // Fence first: claim the row_version bump before writing anything, so
    // a concurrent writer turns this into a clean conflict instead of a
    // half-recorded revision with no follow-up run.
    const fenced = casJobTailoringState(handle, {
      jobId: job.id,
      rowVersion: job.rowVersion,
      tailoringState: "REVISION_REQUESTED",
      reasonCode: null,
      now,
    });
    if (!fenced) {
      const current = getTailoringJob(handle, job.id);
      return failure(
        "conflict",
        `stale client: observed row_version ${input.observedRowVersion}`,
        current?.rowVersion ?? job.rowVersion,
      );
    }
    handle.db
      .update(resumeVersions)
      .set({ reviewState: "REVISION_REQUESTED", updatedAt: now })
      .where(eq(resumeVersions.id, version.id))
      .run();
    const reviewId = newId();
    handle.db
      .insert(resumeReviews)
      .values({
        id: reviewId,
        resumeVersionId: version.id,
        action: "REVISION_REQUESTED",
        actor: "human",
        note: input.note,
        resumeHash: resumeIdentityHash(version),
        contentHash: version.contentHash,
        artifactHashesJson: canonicalJson(digests),
        createdAt: now,
      })
      .run();
    const enqueued = requestRevisionRun(handle, {
      jobId: job.id,
      extractionId: job.activeExtractionId,
      parentVersionId: version.id,
    });
    return {
      ok: true,
      jobId: job.id,
      resumeVersionId: version.id,
      version: version.version,
      reviewId,
      workItemId: enqueued.workItemId,
      deduped: enqueued.deduped,
      newRowVersion: job.rowVersion + 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Review read model
// ---------------------------------------------------------------------------

export interface ReviewRequirementView {
  requirementId: string;
  jdQuote: string;
  category: string;
  importance: string;
  matchStatus: string;
  evidenceFactIds: string[];
  reviewStatus: string;
}

export interface ReviewGapView {
  requirementId: string;
  jdQuote: string;
  category: string;
  importance: string;
  matchStatus: string;
}

export interface ReviewClaimView {
  id: string;
  claimText: string;
  requirementRef: string | null;
  derivationKind: string | null;
  facts: Array<{ factId: string; statement: string; kind: string }>;
}

export interface ReviewContentView {
  summaryStrategy: string;
  omittedUnsupported: string[];
  changeSummary: {
    addedBullets: string[];
    removedBullets: string[];
    summaryChanged: boolean;
    baselineLines: number;
    tailoredLines: number;
  } | null;
  audit: {
    requirementsTotal: number;
    supportedCount: number;
    gapCount: number;
    validatedClaims: number;
    totalClaims: number;
    rationale: string;
    questions: string[];
  } | null;
}

export interface ResumeReviewArtifactView {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface ResumeReviewRowView {
  id: string;
  action: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface ResumeReviewView {
  job: {
    id: string;
    status: string;
    rowVersion: number;
    tailoringState: string;
    activeResumeVersionId: string | null;
  };
  version: {
    id: string;
    jobId: string;
    version: number;
    parentVersionId: string | null;
    reviewState: string;
    contentHash: string;
    templateId: string;
    templateVersion: string;
    rankerVersion: string;
    policyVersion: string;
    configVersion: string;
    renderSchemaVersion: string;
    createdAt: string;
  };
  /** Null when the analysis row is missing or unparseable. */
  analysis: {
    id: string;
    requirements: ReviewRequirementView[];
    gaps: ReviewGapView[];
    rationale: string | null;
    provider: string | null;
    model: string | null;
    promptVersion: string;
  } | null;
  claims: ReviewClaimView[];
  /** Null when the stored content envelope is unparseable. */
  content: ReviewContentView | null;
  artifacts: ResumeReviewArtifactView[];
  reviews: ResumeReviewRowView[];
  actions: {
    canApprove: boolean;
    canRequestRevision: boolean;
    reason: string | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? [...value]
    : null;
}

function parseRequirement(entry: unknown): ReviewRequirementView | null {
  const record = asRecord(entry);
  const requirementId = record === null ? null : asString(record["requirement_id"]);
  const jdQuote = record === null ? null : asString(record["jd_quote"]);
  if (requirementId === null || jdQuote === null) {
    return null;
  }
  const evidence = record !== null ? asStringArray(record["evidence_fact_ids"]) : null;
  return {
    requirementId,
    jdQuote,
    category: asString(record?.["category"]) ?? "unknown",
    importance: asString(record?.["importance"]) ?? "unknown",
    matchStatus: asString(record?.["match_status"]) ?? "unknown",
    evidenceFactIds: evidence ?? [],
    reviewStatus: asString(record?.["review_status"]) ?? "unknown",
  };
}

function parseGap(entry: unknown): ReviewGapView | null {
  const record = asRecord(entry);
  const requirementId = record === null ? null : asString(record["requirement_id"]);
  const jdQuote = record === null ? null : asString(record["jd_quote"]);
  if (requirementId === null || jdQuote === null) {
    return null;
  }
  return {
    requirementId,
    jdQuote,
    category: asString(record?.["category"]) ?? "unknown",
    importance: asString(record?.["importance"]) ?? "unknown",
    matchStatus: asString(record?.["match_status"]) ?? "unknown",
  };
}

function parseChangeSummary(value: unknown): ReviewContentView["changeSummary"] {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const added = asStringArray(record["addedBullets"]);
  const removed = asStringArray(record["removedBullets"]);
  const summaryChanged = record["summaryChanged"];
  const baselineLines = record["baselineLines"];
  const tailoredLines = record["tailoredLines"];
  if (
    added === null ||
    removed === null ||
    typeof summaryChanged !== "boolean" ||
    typeof baselineLines !== "number" ||
    typeof tailoredLines !== "number"
  ) {
    return null;
  }
  return { addedBullets: added, removedBullets: removed, summaryChanged, baselineLines, tailoredLines };
}

function parseAudit(value: unknown): ReviewContentView["audit"] {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const numbers = [
    "requirementsTotal",
    "supportedCount",
    "gapCount",
    "validatedClaims",
    "totalClaims",
  ].map((key) => record[key]);
  if (!numbers.every((entry): entry is number => typeof entry === "number")) {
    return null;
  }
  const rationale = asString(record["rationale"]);
  const questions = asStringArray(record["questions"]);
  if (rationale === null || questions === null) {
    return null;
  }
  const [requirementsTotal, supportedCount, gapCount, validatedClaims, totalClaims] =
    numbers as [number, number, number, number, number];
  return {
    requirementsTotal,
    supportedCount,
    gapCount,
    validatedClaims,
    totalClaims,
    rationale,
    questions,
  };
}

/**
 * Side-by-side review projection for one resume version: proposal
 * requirements with evidence, explicit gaps, claim-level fact citations,
 * the deterministic change summary, and artifact handles. Plain
 * synchronous SELECTs with fail-soft JSON parsing — one corrupt row
 * nulls its section instead of failing the review.
 */
export function getResumeReviewView(
  handle: DatabaseHandle,
  resumeVersionId: string,
): ResumeReviewView | null {
  const version = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, resumeVersionId))
    .get();
  if (version === undefined) {
    return null;
  }
  const job = getTailoringJob(handle, version.jobId);
  if (job === null) {
    return null;
  }
  const analysis = handle.db
    .select()
    .from(jobAnalyses)
    .where(eq(jobAnalyses.id, version.analysisId))
    .get();

  let analysisView: ResumeReviewView["analysis"] = null;
  if (analysis !== undefined) {
    try {
      const requirementsDoc = asRecord(JSON.parse(analysis.requirementsJson));
      const gapsDoc = asRecord(JSON.parse(analysis.gapsJson));
      const requirementEntries = Array.isArray(requirementsDoc?.["requirements"])
        ? (requirementsDoc?.["requirements"] as unknown[])
        : null;
      const gapEntries = Array.isArray(gapsDoc?.["gaps"]) ? (gapsDoc?.["gaps"] as unknown[]) : null;
      if (requirementEntries !== null && gapEntries !== null) {
        const requirements: ReviewRequirementView[] = [];
        const gaps: ReviewGapView[] = [];
        let malformed = false;
        for (const entry of requirementEntries) {
          const parsed = parseRequirement(entry);
          if (parsed === null) {
            malformed = true;
            break;
          }
          requirements.push(parsed);
        }
        if (!malformed) {
          for (const entry of gapEntries) {
            const parsed = parseGap(entry);
            if (parsed === null) {
              malformed = true;
              break;
            }
            gaps.push(parsed);
          }
        }
        if (!malformed) {
          analysisView = {
            id: analysis.id,
            requirements,
            gaps,
            rationale: analysis.rationale,
            provider: analysis.provider,
            model: analysis.model,
            promptVersion: analysis.promptVersion,
          };
        }
      }
    } catch {
      analysisView = null;
    }
  }

  const claimRows = handle.db
    .select()
    .from(resumeClaims)
    .where(eq(resumeClaims.resumeVersionId, version.id))
    .orderBy(asc(resumeClaims.createdAt), asc(resumeClaims.id))
    .all();
  const claims: ReviewClaimView[] = claimRows.map((claim) => {
    const links = handle.db
      .select({ factId: resumeClaimFacts.factId })
      .from(resumeClaimFacts)
      .where(eq(resumeClaimFacts.claimId, claim.id))
      .all();
    const facts: ReviewClaimView["facts"] = [];
    for (const link of links) {
      const fact = handle.db
        .select({
          factId: candidateFacts.factId,
          statement: candidateFacts.statement,
          kind: candidateFacts.kind,
        })
        .from(candidateFacts)
        .where(eq(candidateFacts.factId, link.factId))
        .get();
      if (fact !== undefined) {
        facts.push(fact);
      }
    }
    return {
      id: claim.id,
      claimText: claim.claimText,
      requirementRef: claim.requirementRef,
      derivationKind: claim.derivationKind,
      facts,
    };
  });

  let contentView: ResumeReviewView["content"] = null;
  try {
    const doc = asRecord(JSON.parse(version.contentJson));
    if (doc !== null) {
      const summaryStrategy = asString(doc["summaryStrategy"]);
      const omittedUnsupported = asStringArray(doc["omittedUnsupported"]);
      if (summaryStrategy !== null && omittedUnsupported !== null) {
        contentView = {
          summaryStrategy,
          omittedUnsupported,
          changeSummary: parseChangeSummary(doc["changeSummary"]),
          audit: parseAudit(doc["audit"]),
        };
      }
    }
  } catch {
    contentView = null;
  }

  const artifacts = handle.db
    .select({
      id: resumeArtifacts.id,
      kind: resumeArtifacts.kind,
      mediaType: resumeArtifacts.mediaType,
      byteSize: resumeArtifacts.byteSize,
      sha256: resumeArtifacts.sha256,
    })
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, version.id))
    .orderBy(resumeArtifacts.kind)
    .all();

  const reviews = handle.db
    .select({
      id: resumeReviews.id,
      action: resumeReviews.action,
      actor: resumeReviews.actor,
      note: resumeReviews.note,
      createdAt: resumeReviews.createdAt,
    })
    .from(resumeReviews)
    .where(eq(resumeReviews.resumeVersionId, version.id))
    .orderBy(asc(resumeReviews.createdAt), asc(resumeReviews.id))
    .all();

  const isActive = job.activeResumeVersionId === version.id;
  const liveReview = version.reviewState === "AWAITING_REVIEW";
  const liveTailoring = job.tailoringState === "AWAITING_REVIEW";
  const canRequestRevision =
    isActive && liveReview && liveTailoring && job.status !== "REJECTED";
  const canApprove = canRequestRevision && job.status === "NEW";
  let reason: string | null = null;
  if (!isActive) {
    reason = "A newer resume version is active; this version is read-only.";
  } else if (!liveReview) {
    reason = `This version is ${version.reviewState}; only versions awaiting review can be decided.`;
  } else if (!liveTailoring) {
    reason = `A follow-up run is already in progress (${job.tailoringState}).`;
  } else if (job.status === "REJECTED") {
    reason = "Rejected jobs cannot be approved or revised.";
  } else if (job.status !== "NEW") {
    reason = `This job already moved to ${job.status}; approval only moves NEW jobs to Tailored.`;
  }

  return {
    job: {
      id: job.id,
      status: job.status,
      rowVersion: job.rowVersion,
      tailoringState: job.tailoringState,
      activeResumeVersionId: job.activeResumeVersionId,
    },
    version: {
      id: version.id,
      jobId: version.jobId,
      version: version.version,
      parentVersionId: version.parentVersionId,
      reviewState: version.reviewState,
      contentHash: version.contentHash,
      templateId: version.templateId,
      templateVersion: version.templateVersion,
      rankerVersion: version.rankerVersion,
      policyVersion: version.policyVersion,
      configVersion: version.configVersion,
      renderSchemaVersion: version.renderSchemaVersion,
      createdAt: version.createdAt,
    },
    analysis: analysisView,
    claims,
    content: contentView,
    artifacts,
    reviews,
    actions: { canApprove, canRequestRevision, reason },
  };
}

/** Artifact file metadata for the preview/download route (no paths leak). */
export function getResumeArtifact(
  handle: DatabaseHandle,
  artifactId: string,
): {
  id: string;
  resumeVersionId: string;
  kind: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
} | null {
  const row = handle.db
    .select({
      id: resumeArtifacts.id,
      resumeVersionId: resumeArtifacts.resumeVersionId,
      kind: resumeArtifacts.kind,
      relativePath: resumeArtifacts.relativePath,
      mediaType: resumeArtifacts.mediaType,
      byteSize: resumeArtifacts.byteSize,
      sha256: resumeArtifacts.sha256,
    })
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.id, artifactId))
    .get();
  return row ?? null;
}
