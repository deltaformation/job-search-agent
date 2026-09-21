import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseHandle } from "../db/client";
import { parseStoredPlan, parseStoredValidation } from "../db/step2";
import type { ResumeVersion } from "../db/schema/resumes";
import type { StoredProfilePayload } from "../domain/candidate";
import type { TailoringJobRow } from "../db/tailoring";
import { CandidateSnapshotV1 } from "../domain/candidate";
import { assessmentDelta } from "../domain/assessment";
import {
  deriveStep2Segments,
  masterBulletsByRole,
  Step2EditedInputsV1,
  type Step2DerivedSegment,
  type Step2DraftOperationV1,
} from "../domain/step2";
import {
  deriveCorrectionSegments,
  Step2EditedInputsV2,
  type Step2DraftOperationV2,
} from "../domain/step2Correction";
import {
  AssessmentV1,
  FocusV1,
  RecommendationV1,
  type AssessmentMeasureV1,
  type MeasureSide,
} from "../domain/tailoringWorkspace";
import {
  WorkflowReviewV2,
  type WorkflowReviewAllowedActions,
  type WorkflowReviewFormat,
  type WorkflowReviewInsight,
  type WorkflowReviewOperation,
  type WorkflowReviewSegment,
  type WorkflowReviewSummaryOrigin,
} from "../domain/workflowReview";

/**
 * Exact-version review read model (WO-1.3-G). Builds the strict
 * `workflow-review/v2` extension served alongside the v1 view.
 *
 * Sourcing: exactly ONE batched SQL statement over immutable frozen
 * rows (request, request inputs, step2 inputs, validation, plan,
 * assessment, application, parent version, profile number, snapshot
 * payload, live-run EXISTS) plus the already-loaded version/job/
 * analysis/artifact rows from the v1 view. The tailored markdown
 * comes from the immutable artifact bytes (hash-verified); without
 * an artifacts root the text reports "unchecked". Nothing reads the
 * mutable workspace, the active profile pointer, the browser, or
 * provider assertions. Legacy rows validate with explicit nulls;
 * the server never substitutes current master bytes for a missing
 * frozen baseline.
 *
 * `allowedActions` is read-time advisory (TOCTOU): Approve/Decline
 * POSTs re-verify everything authoritatively, including captured-
 * evidence freshness (which needs profile reads outside the review
 * statement budget). Read-time checks — version state, job status,
 * live run, extraction currency — never false-block on evidence.
 */

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ExtensionRow {
  requestId: string | null;
  requestKind: string | null;
  requestParentVersionId: string | null;
  revisionNote: string | null;
  requestExtractionId: string | null;
  requestProfileId: string | null;
  requestProfileVersionId: string | null;
  masterText: string | null;
  masterTextHash: string | null;
  focusJson: string | null;
  recommendationsJson: string | null;
  inputsCandidateSnapshotId: string | null;
  step2PlanId: string | null;
  step2PlanHash: string | null;
  step2DraftHash: string | null;
  step2ValidationId: string | null;
  editedInputsJson: string | null;
  verdictJson: string | null;
  validationPolicyVersion: string | null;
  planJson: string | null;
  measuresJson: string | null;
  appliedAt: string | null;
  applicationVersionId: string | null;
  parentId: string | null;
  parentVersion: number | null;
  markdownRelPath: string | null;
  markdownByteSize: number | null;
  markdownSha256: string | null;
  profileVersionNumber: number | null;
  snapshotJson: string | null;
  liveRequest: number;
  liveWork: number;
}

const EXTENSION_SQL = `
SELECT
  r.id AS requestId,
  r.request_kind AS requestKind,
  r.parent_version_id AS requestParentVersionId,
  r.revision_note AS revisionNote,
  r.extraction_id AS requestExtractionId,
  r.profile_id AS requestProfileId,
  r.profile_version_id AS requestProfileVersionId,
  i.master_text AS masterText,
  i.master_text_hash AS masterTextHash,
  i.focus_json AS focusJson,
  i.recommendations_json AS recommendationsJson,
  i.candidate_snapshot_id AS inputsCandidateSnapshotId,
  s.plan_id AS step2PlanId,
  s.plan_hash AS step2PlanHash,
  s.draft_hash AS step2DraftHash,
  s.validation_id AS step2ValidationId,
  s.edited_inputs_json AS editedInputsJson,
  d.verdict_json AS verdictJson,
  d.policy_version AS validationPolicyVersion,
  p.plan_json AS planJson,
  a.measures_json AS measuresJson,
  ap.applied_at AS appliedAt,
  ap.resume_version_id AS applicationVersionId,
  parent.id AS parentId,
  parent.version AS parentVersion,
  (SELECT relative_path FROM resume_artifacts WHERE resume_version_id = v.id AND kind = 'MARKDOWN' LIMIT 1) AS markdownRelPath,
  (SELECT byte_size FROM resume_artifacts WHERE resume_version_id = v.id AND kind = 'MARKDOWN' LIMIT 1) AS markdownByteSize,
  (SELECT sha256 FROM resume_artifacts WHERE resume_version_id = v.id AND kind = 'MARKDOWN' LIMIT 1) AS markdownSha256,
  (SELECT version FROM candidate_profile_versions WHERE id = r.profile_version_id) AS profileVersionNumber,
  (SELECT canonical_json FROM candidate_snapshots WHERE id = i.candidate_snapshot_id) AS snapshotJson,
  EXISTS(SELECT 1 FROM generation_requests g WHERE g.job_id = v.job_id AND g.status IN ('QUEUED','RUNNING')) AS liveRequest,
  EXISTS(SELECT 1 FROM work_items w WHERE w.job_id = v.job_id AND w.kind = 'TAILOR' AND w.state IN ('QUEUED','RUNNING')) AS liveWork
FROM resume_versions v
LEFT JOIN generation_requests r ON r.id = v.generation_request_id
LEFT JOIN tailoring_request_inputs i ON i.request_id = r.id
LEFT JOIN step2_generation_inputs s ON s.request_id = r.id
LEFT JOIN step2_draft_validations d ON d.id = s.validation_id
LEFT JOIN step2_plans p ON p.id = s.plan_id
LEFT JOIN resume_assessments a ON a.resume_version_id = v.id
LEFT JOIN applications ap ON ap.job_id = v.job_id
LEFT JOIN resume_versions parent ON parent.id = v.parent_version_id
WHERE v.id = ?
`;

function readExtensionRow(
  handle: DatabaseHandle,
  versionId: string,
): ExtensionRow | null {
  const row = handle.sqlite.prepare(EXTENSION_SQL).get(versionId) as
    | ExtensionRow
    | undefined;
  return row ?? null;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type ParsedEditedInputs =
  | {
      kind: "v2";
      summaryText: string;
      summaryOrigin: "master" | "angle-1" | "angle-2";
      operations: Step2DraftOperationV2[];
      manifest: Array<{
        segmentId: string;
        kind: "summary" | "bullet";
        roleId: string | null;
        anchorFactIds: string[];
        priorityIds: string[];
        textHash: string;
        normalizedHash: string;
        provenance: "VERIFIED_SOURCE" | "USER_ACCEPTED_AI" | "USER_EDITED";
        sourceOperationId: string | null;
      }>;
    }
  | {
      kind: "v1";
      summaryText: string;
      summarySource: "master" | "angle-1" | "angle-2" | "edited";
      operations: Step2DraftOperationV1[];
    };

function parseEditedInputs(text: string | null): ParsedEditedInputs | null {
  const doc = parseJsonObject(text);
  if (doc === null) {
    return null;
  }
  const schemaVersion = doc["schemaVersion"];
  if (schemaVersion === "step2-edited-inputs/v2") {
    try {
      const parsed = Step2EditedInputsV2.parse(doc);
      return {
        kind: "v2",
        summaryText: parsed.summaryText,
        summaryOrigin: parsed.summaryOrigin,
        operations: parsed.operations,
        manifest: parsed.provenanceManifest,
      };
    } catch {
      return null;
    }
  }
  if (schemaVersion === "step2-edited-inputs/v1") {
    try {
      const parsed = Step2EditedInputsV1.parse(doc);
      return {
        kind: "v1",
        summaryText: parsed.summaryText,
        summarySource: parsed.summarySource,
        operations: parsed.operations,
      };
    } catch {
      return null;
    }
  }
  return null;
}

type AnyDraftOperation = Step2DraftOperationV2 | Step2DraftOperationV1;

function operationView(op: AnyDraftOperation): WorkflowReviewOperation | null {
  switch (op.op) {
    case "add":
      if (typeof op.suggestionId !== "string" || typeof op.roleId !== "string") {
        return null;
      }
      return {
        operationId: op.operationId,
        op: "add",
        detail: `Add ${op.suggestionId} to ${op.roleId}${op.editedText ? " (edited)" : ""}`.slice(0, 280),
        raw: op,
      };
    case "replace": {
      if (typeof op.targetFactId !== "string" || typeof op.roleId !== "string") {
        return null;
      }
      const detail =
        typeof op.suggestionId === "string"
          ? `Replace ${op.targetFactId} with ${op.suggestionId} in ${op.roleId}${op.editedText ? " (edited)" : ""}`
          : `Replace ${op.targetFactId} in ${op.roleId} with custom text`;
      return {
        operationId: op.operationId,
        op: "replace",
        detail: detail.slice(0, 280),
        raw: op,
      };
    }
    case "exclude":
      if (typeof op.targetFactId !== "string") {
        return null;
      }
      return {
        operationId: op.operationId,
        op: "exclude",
        detail: `Exclude ${op.targetFactId}`.slice(0, 280),
        raw: op,
      };
    case "edit": {
      if (op.target === undefined || typeof op.text !== "string") {
        return null;
      }
      const target =
        op.target.kind === "suggestion"
          ? `suggestion ${op.target.suggestionId ?? "?"}`
          : `bullet ${op.target.factId ?? "?"}`;
      return {
        operationId: op.operationId,
        op: "edit",
        detail: `Edit ${target}`.slice(0, 280),
        raw: op,
      };
    }
    default:
      return null;
  }
}

interface DerivedReviewData {
  format: WorkflowReviewFormat;
  summaryOrigin: WorkflowReviewSummaryOrigin | null;
  summaryText: string | null;
  operations: WorkflowReviewOperation[];
  segments: WorkflowReviewSegment[];
  excludedTexts: string[];
  focus:
    | {
        kind: "focus";
        selectedPhraseTexts: string[];
        themeId: string | null;
        mappingsCount: number;
        guidancePresent: boolean;
      }
    | {
        kind: "edited-plan";
        priorities: Array<{ id: string; quote: string; support: "supported" | "related" | "gap" }>;
        featuredPriorityIds: string[];
      }
    | { kind: "legacy" };
  validation: {
    id: string;
    policyVersion: string;
    planId: string | null;
    planHash: string | null;
    draftHash: string | null;
  } | null;
}

function emptyDerived(format: WorkflowReviewFormat): DerivedReviewData {
  return {
    format,
    summaryOrigin: null,
    summaryText: null,
    operations: [],
    segments: [],
    excludedTexts: [],
    focus: { kind: "legacy" },
    validation: null,
  };
}

function payloadFromSnapshot(snapshotJson: string | null): StoredProfilePayload | null {
  const doc = parseJsonObject(snapshotJson);
  if (doc === null) {
    return null;
  }
  try {
    return CandidateSnapshotV1.parse(doc).payload;
  } catch {
    return null;
  }
}

function deriveEditedPlanData(
  row: ExtensionRow,
  edited: ParsedEditedInputs,
): DerivedReviewData {
  const base: DerivedReviewData = {
    format: "edited-plan",
    summaryOrigin: null,
    summaryText: null,
    operations: [],
    segments: [],
    excludedTexts: [],
    focus: { kind: "legacy" },
    validation: null,
  };
  for (const op of edited.operations) {
    const view = operationView(op);
    if (view === null) {
      return { ...base, operations: [] };
    }
    base.operations.push(view);
  }
  if (edited.kind === "v2") {
    base.summaryOrigin = edited.summaryOrigin;
  } else {
    base.summaryOrigin = edited.summarySource === "edited" ? "edited" : edited.summarySource;
  }
  base.summaryText = edited.summaryText;
  if (row.planJson === null) {
    return base;
  }
  const storedPlan = parseStoredPlan(row.planJson);
  if (storedPlan === null) {
    return { ...base, operations: [] };
  }
  if (
    (storedPlan.version === 1 && edited.kind !== "v1") ||
    (storedPlan.version === 2 && edited.kind !== "v2")
  ) {
    return { ...base, operations: [] };
  }
  const payload = payloadFromSnapshot(row.snapshotJson);
  if (payload === null) {
    return base;
  }
  const priorities =
    storedPlan.version === 1
      ? storedPlan.plan.priorities
      : storedPlan.plan.priorities;
  base.focus = {
    kind: "edited-plan",
    priorities: priorities.map((priority) => ({
      id: priority.priorityId,
      quote: priority.quote.text,
      support: priority.support,
    })),
    featuredPriorityIds:
      storedPlan.version === 2 ? [...storedPlan.plan.featuredPriorityIds] : [],
  };
  if (row.verdictJson !== null) {
    const storedValidation = parseStoredValidation(row.verdictJson);
    if (
      storedValidation !== null &&
      ((storedValidation.version === 1 && edited.kind === "v1") ||
        (storedValidation.version === 2 && edited.kind === "v2"))
    ) {
      base.validation = {
        id: row.step2ValidationId ?? "",
        policyVersion:
          storedValidation.version === 2
            ? storedValidation.validation.policyVersion
            : storedValidation.validation.policyVersion,
        planId: row.step2PlanId,
        planHash: row.step2PlanHash,
        draftHash: row.step2DraftHash,
      };
    }
  }

  // Segment texts reconstruct through the worker's own pure
  // derivation over frozen bytes (ops + plan + snapshot payload),
  // then verify hash-by-hash against the frozen manifest/verdicts.
  // Any divergence fails the segments closed (no misattribution).
  const master = masterBulletsByRole(payload);
  const excludeTargets = new Set<string>();
  for (const op of edited.operations) {
    if (op.op === "exclude") {
      excludeTargets.add(op.targetFactId);
    }
  }
  const statementsByFact = new Map<string, string>();
  for (const achievement of payload.achievements) {
    if (!statementsByFact.has(achievement.factId)) {
      statementsByFact.set(achievement.factId, achievement.text);
    }
  }
  for (const factId of excludeTargets) {
    const text = statementsByFact.get(factId);
    if (text !== undefined && text !== "") {
      base.excludedTexts.push(text);
    }
  }

  if (edited.kind === "v2" && storedPlan.version === 2) {
    let derived: ReturnType<typeof deriveCorrectionSegments>;
    try {
      derived = deriveCorrectionSegments({
        plan: storedPlan.plan,
        master,
        masterSummary: payload.summary ?? "",
        summaryText: edited.summaryText,
        summaryOrigin: edited.summaryOrigin,
        operations: edited.operations,
      });
    } catch {
      return { ...base, segments: [] };
    }
    const manifestById = new Map(
      edited.manifest.map((entry) => [entry.segmentId, entry]),
    );
    const segments: WorkflowReviewSegment[] = [];
    for (const segment of derived) {
      const entry = manifestById.get(segment.segmentId);
      if (
        entry === undefined ||
        entry.kind !== segment.kind ||
        (entry.roleId ?? null) !== (segment.roleId ?? null) ||
        entry.textHash !== sha256HexUtf8(segment.text)
      ) {
        return { ...base, segments: [] };
      }
      segments.push({
        segmentId: segment.segmentId,
        kind: segment.kind,
        roleId: segment.roleId,
        text: segment.text,
        textHash: entry.textHash,
        provenance: entry.provenance,
        sourceOperationId: entry.sourceOperationId,
        anchorFactIds: [...entry.anchorFactIds],
        priorityIds: [...entry.priorityIds],
      });
    }
    base.segments = segments;
    return base;
  }
  if (edited.kind === "v1" && storedPlan.version === 1) {
    let derived: Step2DerivedSegment[];
    try {
      derived = deriveStep2Segments({
        plan: storedPlan.plan,
        master,
        summaryText: edited.summaryText,
        operations: edited.operations,
      });
    } catch {
      return { ...base, segments: [] };
    }
    const storedValidation =
      row.verdictJson === null ? null : parseStoredValidation(row.verdictJson);
    const verdictById =
      storedValidation !== null && storedValidation.version === 1
        ? new Map(
            storedValidation.validation.segments.map((verdict) => [
              verdict.segmentId,
              verdict,
            ]),
          )
        : new Map<string, { kind: string; roleId: string | null; textHash: string; factIds: string[] }>();
    const segments: WorkflowReviewSegment[] = [];
    for (const segment of derived) {
      const verdict = verdictById.get(segment.segmentId);
      if (
        verdict === undefined ||
        verdict.kind !== segment.kind ||
        (verdict.roleId ?? null) !== (segment.roleId ?? null) ||
        verdict.textHash !== sha256HexUtf8(segment.text)
      ) {
        return { ...base, segments: [] };
      }
      segments.push({
        segmentId: segment.segmentId,
        kind: segment.kind,
        roleId: segment.roleId,
        text: segment.text,
        textHash: verdict.textHash,
        provenance: "UNLABELED",
        sourceOperationId: null,
        anchorFactIds: [...verdict.factIds],
        priorityIds: [],
      });
    }
    base.segments = segments;
  }
  return base;
}

function deriveFocusData(row: ExtensionRow): DerivedReviewData {
  const base = emptyDerived("focus");
  const focusDoc = parseJsonObject(row.focusJson);
  const recsDoc = parseJsonObject(row.recommendationsJson);
  if (focusDoc === null || recsDoc === null) {
    return base;
  }
  try {
    const focus = FocusV1.parse(focusDoc);
    const recommendations = RecommendationV1.parse(recsDoc);
    const textsById = new Map(
      recommendations.phrases.map((phrase) => [phrase.id, phrase.text]),
    );
    base.summaryOrigin = "focus";
    base.focus = {
      kind: "focus",
      selectedPhraseTexts: focus.selectedPhraseIds.map(
        (id) => textsById.get(id) ?? id,
      ),
      themeId: focus.themeId,
      mappingsCount: focus.mappings.length,
      guidancePresent: focus.additionalGuidance.trim() !== "",
    };
    return base;
  } catch {
    return emptyDerived("focus");
  }
}

function deriveReviewData(row: ExtensionRow): DerivedReviewData {
  if (row.requestId === null || row.masterText === null) {
    return emptyDerived("legacy");
  }
  if (row.editedInputsJson !== null) {
    const edited = parseEditedInputs(row.editedInputsJson);
    if (edited === null) {
      return emptyDerived("legacy");
    }
    return deriveEditedPlanData(row, edited);
  }
  return deriveFocusData(row);
}

export interface TailoredTextRead {
  text: string;
  status: "ok" | "unchecked" | "missing" | "mismatch";
}

/**
 * Read the exact canonical markdown bytes for one version and
 * verify size + SHA-256 against the artifact row. Corrupt or
 * missing bytes report explicitly; without an artifacts root the
 * read reports "unchecked" (never guessed).
 */
export function readTailoredMarkdown(
  artifacts: Array<{
    kind: string;
    relativePath: string;
    byteSize: number;
    sha256: string;
  }>,
  artifactsDir: string | undefined,
): TailoredTextRead {
  if (artifactsDir === undefined) {
    return { text: "", status: "unchecked" };
  }
  const markdown = artifacts.find((artifact) => artifact.kind === "MARKDOWN");
  if (markdown === undefined) {
    return { text: "", status: "missing" };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(artifactsDir, markdown.relativePath));
  } catch {
    return { text: "", status: "missing" };
  }
  if (bytes.byteLength !== markdown.byteSize) {
    return { text: "", status: "mismatch" };
  }
  const digest = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(markdown.sha256, "hex");
  if (digest.byteLength !== expected.byteLength || !timingSafeEqual(digest, expected)) {
    return { text: "", status: "mismatch" };
  }
  return { text: bytes.toString("utf8"), status: "ok" };
}

function measureByKey(
  assessment: { measures: AssessmentMeasureV1[] } | null,
  key: AssessmentMeasureV1["key"],
): AssessmentMeasureV1 | null {
  if (assessment === null) {
    return null;
  }
  return assessment.measures.find((measure) => measure.key === key) ?? null;
}

function notAssessedPhrase(side: MeasureSide): string {
  if (side.status === "assessed") {
    return "assessed";
  }
  switch (side.reason) {
    case "NO_ELIGIBLE_ITEMS":
      return "no eligible items";
    case "BASELINE_UNAVAILABLE":
      return "baseline unavailable";
    case "CHECK_NOT_APPLICABLE":
      return "check not applicable";
    default:
      return "not assessed";
  }
}

export interface InsightInputs {
  format: WorkflowReviewFormat;
  derived: DerivedReviewData;
  assessment: { measures: AssessmentMeasureV1[] } | null;
  gapKeys: string[];
}

const MAX_INSIGHT_TEXT = 500;

function clipInsight(text: string): string {
  return text.length > MAX_INSIGHT_TEXT
    ? `${text.slice(0, MAX_INSIGHT_TEXT - 1)}…`
    : text;
}

/**
 * Deterministic provenance-aware insights over frozen records.
 * Fixed templates only: counts come from the persisted measures,
 * gaps from frozen plan/analysis rows, provenance from frozen
 * segments, length from frozen segment tallies (advisory). Copy
 * never calls user text verified, proven, or newly gained, and
 * never converts a gap into coverage.
 */
export function buildWorkflowInsights(input: InsightInputs): WorkflowReviewInsight[] {
  const insights: WorkflowReviewInsight[] = [];
  const keywords = measureByKey(input.assessment, "selected_keywords");
  if (keywords === null) {
    insights.push({
      id: "keyword-coverage",
      kind: "keyword-coverage",
      text: "Keyword matches: not assessed (this version predates assessment).",
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  } else {
    const { original, tailored, itemIds } = keywords;
    if (tailored.status !== "assessed") {
      insights.push({
        id: "keyword-coverage",
        kind: "keyword-coverage",
        text: `Keyword matches: not assessed (${notAssessedPhrase(tailored)}).`,
        citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
      });
    } else {
      const delta = assessmentDelta(original, tailored);
      const master =
        original.status === "assessed"
          ? `master: ${original.numerator} of ${original.denominator}`
          : "master: not assessed";
      const noun = input.format === "edited-plan" ? "priority phrases" : "selected phrases";
      insights.push({
        id: "keyword-coverage",
        kind: "keyword-coverage",
        text: clipInsight(
          `Keyword matches: ${tailored.numerator} of ${tailored.denominator} ${noun} appear in the tailored resume (${master}${delta === null ? "" : `; ${delta >= 0 ? "+" : ""}${delta} points`}).`,
        ),
        citations: {
          priorityIds: input.format === "edited-plan" ? itemIds.slice(0, 20) : [],
          requirementIds: [],
          segmentIds: [],
          checkIds: [],
        },
      });
    }
  }
  const requirements = measureByKey(input.assessment, "supported_requirements");
  if (requirements === null) {
    insights.push({
      id: "requirement-coverage",
      kind: "requirement-coverage",
      text: "Supported requirements: not assessed (this version predates assessment).",
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  } else {
    const { tailored, itemIds } = requirements;
    insights.push({
      id: "requirement-coverage",
      kind: "requirement-coverage",
      text:
        tailored.status === "assessed"
          ? `Supported requirements: ${tailored.numerator} of ${tailored.denominator} link to verified resume claims (master: not assessed).`
          : `Supported requirements: not assessed (${notAssessedPhrase(tailored)}).`,
      citations: {
        priorityIds: [],
        requirementIds: tailored.status === "assessed" ? itemIds.slice(0, 100) : [],
        segmentIds: [],
        checkIds: [],
      },
    });
  }
  const checks = measureByKey(input.assessment, "document_checks");
  if (checks === null) {
    insights.push({
      id: "document-checks",
      kind: "document-checks",
      text: "Document checks: not assessed (this version predates assessment).",
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  } else {
    const { tailored, itemIds } = checks;
    insights.push({
      id: "document-checks",
      kind: "document-checks",
      text:
        tailored.status === "assessed"
          ? `Document checks: ${tailored.numerator} of ${tailored.denominator} passed (content, contact, page budget, cross-format parity).`
          : `Document checks: not assessed (${notAssessedPhrase(tailored)}).`,
      citations: {
        priorityIds: [],
        requirementIds: [],
        segmentIds: [],
        checkIds: tailored.status === "assessed" ? itemIds.slice(0, 10) : [],
      },
    });
  }
  const evidence = measureByKey(input.assessment, "evidence_integrity");
  if (evidence === null) {
    insights.push({
      id: "evidence-integrity",
      kind: "evidence-integrity",
      text: "Evidence integrity: not assessed (this version predates assessment).",
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  } else {
    const { tailored } = evidence;
    insights.push({
      id: "evidence-integrity",
      kind: "evidence-integrity",
      text:
        tailored.status === "assessed"
          ? `Evidence integrity: ${tailored.numerator} of ${tailored.denominator} evidence-backed claims cite only facts present and approved in the frozen snapshot.`
          : `Evidence integrity: not assessed (${notAssessedPhrase(tailored)}).`,
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  }

  if (input.derived.focus.kind === "edited-plan") {
    for (const priority of input.derived.focus.priorities) {
      if (priority.support !== "gap") {
        continue;
      }
      const quote =
        priority.quote.length > 80 ? `${priority.quote.slice(0, 79)}…` : priority.quote;
      insights.push({
        id: `gap-${priority.id}`,
        kind: "requirement-gap",
        text: `“${quote}” remains a gap — no resume claim covers it.`,
        citations: {
          priorityIds: [priority.id],
          requirementIds: [],
          segmentIds: [],
          checkIds: [],
        },
      });
    }
  } else if (input.format !== "legacy") {
    for (const gapKey of input.gapKeys.slice(0, 20)) {
      const shortKey = gapKey.length > 80 ? `${gapKey.slice(0, 79)}…` : gapKey;
      insights.push({
        id: `gap-${gapKey.slice(0, 120)}`,
        kind: "requirement-gap",
        text: `Gap “${shortKey}” remains uncovered — no resume claim covers it.`,
        citations: {
          priorityIds: [],
          requirementIds: [gapKey].slice(0, 100),
          segmentIds: [],
          checkIds: [],
        },
      });
    }
  }

  const segments = input.derived.segments;
  if (segments.length > 0) {
    const verified = segments.filter((s) => s.provenance === "VERIFIED_SOURCE");
    const accepted = segments.filter((s) => s.provenance === "USER_ACCEPTED_AI");
    const edited = segments.filter((s) => s.provenance === "USER_EDITED");
    const unlabeled = segments.filter((s) => s.provenance === "UNLABELED");
    if (unlabeled.length > 0) {
      insights.push({
        id: "provenance-note",
        kind: "provenance-note",
        text: `Included segments (${segments.length}) predate machine-provenance labels and are shown unlabeled, never as verified.`,
        citations: {
          priorityIds: [],
          requirementIds: [],
          segmentIds: segments.map((s) => s.segmentId).slice(0, 100),
          checkIds: [],
        },
      });
    } else {
      const parts = [
        `${verified.length} verified source`,
        `${accepted.length} accepted AI suggestion${accepted.length === 1 ? "" : "s"}`,
        `${edited.length} user edit${edited.length === 1 ? "" : "s"}`,
      ];
      insights.push({
        id: "provenance-note",
        kind: "provenance-note",
        text: `Included segments: ${parts.join(", ")}. Accepted and edited text is preserved verbatim and is not counted as verified.`,
        citations: {
          priorityIds: [],
          requirementIds: [],
          segmentIds: [...accepted, ...edited].map((s) => s.segmentId).slice(0, 100),
          checkIds: [],
        },
      });
    }
    const bullets = segments.filter((s) => s.kind === "bullet");
    const roles = new Set(
      bullets.map((s) => s.roleId).filter((role): role is string => role !== null),
    );
    const guideline = 14;
    const over = bullets.length > guideline;
    insights.push({
      id: "length-advisory",
      kind: "length-advisory",
      text: over
        ? `Resume length: ${bullets.length} bullets across ${roles.size} roles (guideline ${guideline} total) — advisory only; every kept bullet generated. This could exceed two pages.`
        : `Resume length: ${bullets.length} bullets across ${roles.size} roles (guideline ${guideline} total) — advisory only; every kept bullet generated.`,
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  } else if (input.format === "focus") {
    insights.push({
      id: "provenance-note",
      kind: "provenance-note",
      text: "All rendered claims are evidence-built from approved facts under the frozen focus.",
      citations: { priorityIds: [], requirementIds: [], segmentIds: [], checkIds: [] },
    });
  }
  return insights.slice(0, 40);
}

export interface AllowedActionsInput {
  reviewState: string;
  jobStatus: string;
  liveRun: boolean;
  /** False when the request extraction no longer matches the job's active one. */
  extractionCurrent: boolean;
  /** True when the version is the job's active (latest) draft. */
  isActive: boolean;
  /**
   * True for correction-format (claims/2) versions, whose Step 2
   * editor round-trip accepts older parents. Previous-format rows
   * (focus, claims/1, legacy) revise only from the active draft
   * through the immediate v1 command.
   */
  isCorrection: boolean;
}

const DECIDABLE_JOB_STATUSES = new Set([
  "NEW",
  "TAILORED",
  "APPLIED",
  "INTERVIEWED",
]);

/**
 * Read-time allowed actions (advisory; POSTs re-verify). Exact rule:
 * Approve/Decline need an awaiting version, a decidable job, no
 * live run, and a current extraction. Revise needs an awaiting
 * version on a non-rejected job that is either the active draft
 * (v1 immediate revise) or a correction-format version (Step 2
 * editor round-trip, which accepts older parents); older
 * previous-format versions decide (approve/decline) but do not
 * fork. New version needs a non-rejected job plus a terminal
 * version or a stale awaiting version (the recovery path).
 */
export function computeWorkflowAllowedActions(
  input: AllowedActionsInput,
): WorkflowReviewAllowedActions {
  const awaiting = input.reviewState === "AWAITING_REVIEW";
  const rejected = input.jobStatus === "REJECTED";
  const terminal =
    input.reviewState === "APPROVED" || input.reviewState === "DECLINED";
  const failedVersion = input.reviewState === "FAILED";
  const approve =
    awaiting &&
    DECIDABLE_JOB_STATUSES.has(input.jobStatus) &&
    !input.liveRun &&
    input.extractionCurrent;
  const decline = approve;
  const revise = awaiting && !rejected && (input.isActive || input.isCorrection);
  const newVersion =
    !rejected &&
    (terminal || failedVersion || (awaiting && !input.extractionCurrent));
  let reason: string | null = null;
  if (!approve) {
    if (!awaiting) {
      reason =
        terminal || failedVersion
          ? "This version is already decided and cannot be decided again."
          : input.reviewState === "REVISION_REQUESTED"
            ? "A revision is already queued for this version."
            : "This version is not awaiting review.";
    } else if (rejected || !DECIDABLE_JOB_STATUSES.has(input.jobStatus)) {
      reason = "This job is rejected; decisions are closed.";
    } else if (input.liveRun) {
      reason = "A tailoring run is live for this job; decisions unlock when it finishes.";
    } else if (!input.extractionCurrent) {
      reason =
        "The job description changed since this version was generated; generate a new version.";
    }
  } else if (!revise || !newVersion) {
    reason = null;
  }
  if (reason !== null && reason.length > 280) {
    reason = reason.slice(0, 280);
  }
  return { approve, revise, decline, newVersion, reason };
}

export interface WorkflowReviewDeps {
  version: ResumeVersion;
  job: TailoringJobRow;
  gapKeys: string[];
  artifactsDir?: string;
}

/**
 * Build the strict workflow-review/v2 extension. Returns null only
 * when the version row itself is gone (the caller already checked)
 * or the extension row cannot load; every frozen-data problem
 * inside renders as explicit nulls/empties under the strict shape.
 */
export function buildWorkflowReview(
  handle: DatabaseHandle,
  deps: WorkflowReviewDeps,
): WorkflowReviewV2 | null {
  const row = readExtensionRow(handle, deps.version.id);
  if (row === null) {
    return null;
  }
  const derived = deriveReviewData(row);
  const assessment = (() => {
    if (row.measuresJson === null) {
      return null;
    }
    try {
      return AssessmentV1.parse(JSON.parse(row.measuresJson) as unknown);
    } catch {
      return null;
    }
  })();
  const tailored = readTailoredMarkdown(
    row.markdownRelPath === null ||
      row.markdownByteSize === null ||
      row.markdownSha256 === null
      ? []
      : [
          {
            kind: "MARKDOWN",
            relativePath: row.markdownRelPath,
            byteSize: row.markdownByteSize,
            sha256: row.markdownSha256,
          },
        ],
    deps.artifactsDir,
  );
  const liveRun = row.liveRequest === 1 || row.liveWork === 1;
  const extractionCurrent =
    row.requestExtractionId === null ||
    deps.job.activeExtractionId === null ||
    row.requestExtractionId === deps.job.activeExtractionId;
  const allowedActions = computeWorkflowAllowedActions({
    reviewState: deps.version.reviewState,
    jobStatus: deps.job.status,
    liveRun,
    extractionCurrent,
    isActive: deps.job.activeResumeVersionId === deps.version.id,
    isCorrection:
      derived.format === "edited-plan" &&
      derived.validation?.policyVersion === "step2-claims/2",
  });
  const insights = buildWorkflowInsights({
    format: derived.format,
    derived,
    assessment,
    gapKeys: deps.gapKeys,
  });
  const review = {
    schemaVersion: "workflow-review/v2",
    format: derived.format,
    version: {
      id: deps.version.id,
      version: deps.version.version,
      reviewState: deps.version.reviewState,
      parentVersionId: deps.version.parentVersionId,
      contentHash: deps.version.contentHash,
      createdAt: deps.version.createdAt,
    },
    request:
      row.requestId === null ||
      (row.requestKind !== "INITIAL" &&
        row.requestKind !== "NEW_VERSION" &&
        row.requestKind !== "REVISION")
        ? null
        : {
            id: row.requestId,
            kind: row.requestKind,
            parentVersionId: row.requestParentVersionId,
            revisionNote: row.revisionNote,
          },
    parent:
      row.parentId === null || row.parentVersion === null
        ? null
        : { id: row.parentId, version: row.parentVersion },
    profile:
      row.requestProfileId === null || row.requestProfileVersionId === null
        ? null
        : {
            profileId: row.requestProfileId,
            profileVersionId: row.requestProfileVersionId,
            profileVersionNumber: row.profileVersionNumber,
          },
    master:
      row.masterText === null || row.masterTextHash === null
        ? null
        : { text: row.masterText, hash: row.masterTextHash },
    summaryOrigin: derived.summaryOrigin,
    summaryText: derived.summaryText,
    operations: derived.operations,
    validation: derived.validation,
    policies: {
      templateId: deps.version.templateId,
      templateVersion: deps.version.templateVersion,
      rankerVersion: deps.version.rankerVersion,
      policyVersion: deps.version.policyVersion,
      configVersion: deps.version.configVersion,
      renderSchemaVersion: deps.version.renderSchemaVersion,
    },
    segments: derived.segments,
    excludedTexts: derived.excludedTexts,
    focus: derived.focus,
    assessment,
    assessmentLineage:
      assessment === null || row.requestId === null || row.masterTextHash === null
        ? null
        : {
            requestId: row.requestId,
            validationId: row.step2ValidationId,
            masterHash: row.masterTextHash,
            contentHash: deps.version.contentHash,
          },
    insights,
    allowedActions,
    markers: {
      latestPublished: deps.job.activeResumeVersionId === deps.version.id,
      selectedApproved: deps.job.selectedResumeVersionId === deps.version.id,
      isApplicationVersion: row.applicationVersionId === deps.version.id,
      appliedAt: row.applicationVersionId === deps.version.id ? row.appliedAt : null,
    },
    tailoredText: tailored.text,
    tailoredTextStatus: tailored.status,
  };
  return WorkflowReviewV2.parse(review);
}
