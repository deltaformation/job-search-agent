import { canonicalJson } from "../domain/canonical";
import { CandidateSnapshotV1 } from "../domain/candidate";
import type { DatabaseHandle } from "../db/client";
import { parseVersionedPayload } from "../domain/envelopes";
import { ReasonCode } from "../domain/enums";
import {
  getCandidateSnapshotById,
  getJdSnapshotById,
  getJobSalaryState,
  getTailoringJob,
} from "../db/tailoring";
import { utcNow } from "../db/utils";
import type { HandlerOutcome, WorkHandler, WorkHandlerContext } from "../queue/dispatch";
import { loadDocxTemplateBytes } from "../resumes/docx";
import { renderPdf as renderPdfWithBrowser } from "../resumes/pdf";
import type { BrowserSupplier } from "../scraping/browser";
import { createLogger } from "../security/logger";
import { adaptSnapshotProfile } from "./adapt";
import {
  RESUME_PROPOSAL_SCHEMA_VERSION,
  TAILOR_PROMPT_VERSION,
  type TailoringProvider,
} from "./contract";
import { TAILOR_PAYLOAD_VERSION, TailorPayloadV1 } from "./enqueue";
import { orchestrateTailoring } from "./orchestrate";
import {
  attachResumeVersion,
  beginTailorRun,
  failTailorRun,
  nextResumeVersion,
  recordAnalysis,
  type RunStart,
} from "./persist";
import { sha256HexUtf8 } from "./hash";
import { publishArtifacts } from "./publish";
import {
  backfillJobSalary,
  runSalaryFallback,
  type SalaryFallbackConfig,
} from "./salaryFallback";

const log = createLogger("tailor-handler");

/**
 * TAILOR queue handler: parse the payload, open a fenced run, resolve
 * snapshots, run the deterministic orchestration, persist the analysis,
 * publish artifacts, and attach an immutable resume version. Provider
 * work and rendering run outside any SQLite transaction; every database
 * write is a short fenced transaction.
 */

export interface TailorHandlerDeps {
  artifactsDir: string;
  /** Null when no provider is configured: runs report BLOCKED. */
  provider: TailoringProvider | null;
  /**
   * R4-G salary sidecar. When set, runs missing salary text but existing
   * extraction text trigger one best-effort AI backfill before the fenced
   * run begins. Unset skips the step entirely (existing tests, offline use).
   */
  salaryFallback?: SalaryFallbackConfig;
  browser?: BrowserSupplier;
  /** Test seam; defaults to Chromium rendering through `browser`. */
  renderPdf?: (html: string) => Promise<{ bytes: Buffer }>;
  /** Test seam; defaults to the checked-in DOCX template. */
  docxTemplateBytes?: Buffer;
  clock?: () => string;
}

function blockJob(
  handle: DatabaseHandle,
  jobId: string,
  reason: string,
  detail: string,
  now: string,
): HandlerOutcome {
  const job = getTailoringJob(handle, jobId);
  if (job !== null) {
    failTailorRun(handle, {
      jobId,
      rowVersion: job.rowVersion,
      to: "BLOCKED",
      reasonCode: ReasonCode.parse(reason),
      now,
    });
  }
  return { result: "BLOCKED", errorCode: reason, errorDetail: detail };
}

function failJob(
  handle: DatabaseHandle,
  jobId: string,
  rowVersion: number,
  reason: string,
  detail: string,
  now: string,
): HandlerOutcome {
  failTailorRun(handle, {
    jobId,
    rowVersion,
    to: "FAILED",
    reasonCode: ReasonCode.parse(reason),
    now,
  });
  return { result: "FAILED", errorCode: reason, errorDetail: detail };
}

/**
 * R4-G Step-2 pre-step. Best-effort and outcome-neutral: every guard
 * miss, sidecar failure, and write skip returns quietly so salary can
 * never fail (or delay fencing for) the tailoring run it precedes.
 */
async function backfillMissingSalary(
  handle: DatabaseHandle,
  jobId: string,
  extractionId: string,
  config: SalaryFallbackConfig,
): Promise<void> {
  let state;
  try {
    state = getJobSalaryState(handle, jobId);
  } catch {
    return;
  }
  if (state === null) {
    return;
  }
  if (state.activeExtractionId !== extractionId) {
    return;
  }
  if (state.salaryText !== null && state.salaryText.trim() !== "") {
    return;
  }
  if (state.descriptionText === null || state.descriptionText.trim() === "") {
    return;
  }
  const facts = await runSalaryFallback({
    config,
    request: {
      jobTitle: state.title,
      company: state.company,
      location: state.location,
      jdText: state.descriptionText,
    },
    onDiagnostic: (message) => log.warn("salary fallback skipped run input", { jobId, message }),
  });
  if (facts === null) {
    return;
  }
  try {
    const outcome = backfillJobSalary(handle, { jobId, extractionId, facts });
    if (outcome === "written") {
      log.info("salary fallback backfilled job", { jobId, model: facts.model });
    }
  } catch {
    // Best-effort: a write fault must not fail the tailoring run.
  }
}

export function createTailorHandler(deps: TailorHandlerDeps): WorkHandler {
  const clock = deps.clock ?? utcNow;
  const docxTemplateBytes = deps.docxTemplateBytes ?? loadDocxTemplateBytes();
  const renderPdf =
    deps.renderPdf ??
    (async (html: string) => {
      if (deps.browser === undefined) {
        throw new Error("no PDF renderer configured");
      }
      return renderPdfWithBrowser(html, await deps.browser());
    });
  return async (context: WorkHandlerContext): Promise<HandlerOutcome> => {
    const now = clock();
    let rawPayload: unknown;
    try {
      rawPayload =
        context.item.payloadJson === null ? null : (JSON.parse(context.item.payloadJson) as unknown);
    } catch {
      rawPayload = undefined;
    }
    const parsed = parseVersionedPayload(
      { [TAILOR_PAYLOAD_VERSION]: TailorPayloadV1 },
      rawPayload,
    );
    if (!parsed.ok) {
      log.error("tailor payload failed to parse", {
        workItemId: context.item.id,
        error: parsed.error,
      });
      return {
        result: "FAILED",
        errorCode: "STALE_INPUT",
        errorDetail: `queue payload is unusable (${parsed.error}): ${parsed.detail}`,
      };
    }
    const payload = parsed.value as TailorPayloadV1;

    if (deps.provider === null) {
      return blockJob(
        context.handle,
        payload.jobId,
        "PROVIDER_UNAVAILABLE",
        "no tailoring provider is configured; set TAILOR_PROVIDER_ARGV and retry",
        now,
      );
    }
    const provider = deps.provider;

    if (!context.heartbeat()) {
      return { result: "FAILED", errorCode: "LEASE_EXPIRED", errorDetail: "lease lost before run" };
    }
    if (deps.salaryFallback !== undefined) {
      await backfillMissingSalary(
        context.handle,
        payload.jobId,
        payload.extractionId,
        deps.salaryFallback,
      );
      if (!context.heartbeat()) {
        return {
          result: "FAILED",
          errorCode: "LEASE_EXPIRED",
          errorDetail: "lease lost during salary fallback",
        };
      }
    }
    const begun = beginTailorRun(context.handle, {
      jobId: payload.jobId,
      extractionId: payload.extractionId,
      now,
      profileId: payload.profileId,
    });
    if (!begun.ok) {
      if (begun.error === "job-not-found") {
        return { result: "FAILED", errorCode: "STALE_INPUT", errorDetail: begun.detail };
      }
      if (begun.error === "fenced") {
        // No state write: a newer run or an explicit rejection owns the job.
        return { result: "BLOCKED", errorCode: "STALE_INPUT", errorDetail: begun.detail };
      }
      return blockJob(context.handle, payload.jobId, begun.reason ?? "STALE_INPUT", begun.detail, now);
    }
    const start: RunStart = begun.start;

    const jdSnapshot = getJdSnapshotById(context.handle, start.jdSnapshotId);
    const candidateSnapshot = getCandidateSnapshotById(context.handle, start.candidateSnapshotId);
    if (jdSnapshot === null || candidateSnapshot === null) {
      return failJob(
        context.handle,
        payload.jobId,
        start.fenceVersion,
        "STALE_INPUT",
        "bound snapshots vanished mid-run",
        now,
      );
    }
    let profile: ReturnType<typeof adaptSnapshotProfile>;
    try {
      const snapshot = CandidateSnapshotV1.parse(
        JSON.parse(candidateSnapshot.canonicalJson) as unknown,
      );
      if (sha256HexUtf8(canonicalJson(snapshot)) !== candidateSnapshot.sha256) {
        throw new Error("snapshot bytes do not match the recorded hash");
      }
      profile = adaptSnapshotProfile(snapshot);
    } catch (error: unknown) {
      return failJob(
        context.handle,
        payload.jobId,
        start.fenceVersion,
        "STALE_INPUT",
        `bound candidate snapshot is corrupt: ${(error as Error).message}`,
        now,
      );
    }

    if (!context.heartbeat()) {
      return { result: "FAILED", errorCode: "LEASE_EXPIRED", errorDetail: "lease lost before provider" };
    }
    const orchestrated = await orchestrateTailoring(
      {
        jobId: payload.jobId,
        jobTitle: start.job.title,
        jobCompany: start.job.company,
        // The bound snapshot text — not the live row — is the generation
        // input; live-row drift is caught by fencing at attach time.
        jobDescription: jdSnapshot.jdText,
        profile,
        jdSnapshot: { id: jdSnapshot.id, jdText: jdSnapshot.jdText, createdAt: jdSnapshot.createdAt },
        candidateSnapshot: {
          id: candidateSnapshot.id,
          snapshotHash: candidateSnapshot.sha256,
          createdAt: candidateSnapshot.createdAt,
        },
        profileId: payload.profileId,
        selectedKeywords: payload.selectedKeywords,
        directives: payload.directives,
      },
      { provider, renderPdf, docxTemplateBytes },
    );

    let analysisId: string | null = null;
    const accepted = orchestrated.ok ? orchestrated.value : orchestrated.proposal;
    if (accepted !== null) {
      try {
        analysisId = recordAnalysis(context.handle, {
          jobId: payload.jobId,
          jdSnapshotId: start.jdSnapshotId,
          candidateSnapshotId: start.candidateSnapshotId,
          proposal: accepted,
          providerId: provider.providerId,
          promptVersion: TAILOR_PROMPT_VERSION,
          proposalSchemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
        });
      } catch (error: unknown) {
        log.error("analysis persist failed", {
          workItemId: context.item.id,
          jobId: payload.jobId,
          detail: (error as Error).message,
        });
        return failJob(
          context.handle,
          payload.jobId,
          start.fenceVersion,
          "STALE_INPUT",
          `analysis persist failed: ${(error as Error).message}`,
          clock(),
        );
      }
    }

    if (!orchestrated.ok) {
      const reason = orchestrated.reason;
      const hashes =
        accepted === null
          ? {}
          : { inputHash: accepted.inputHash, outputHash: accepted.proposalHash };
      return {
        ...failJob(context.handle, payload.jobId, start.fenceVersion, reason, orchestrated.detail, clock()),
        ...hashes,
      };
    }
    const value = orchestrated.value;

    if (!context.heartbeat()) {
      return {
        result: "FAILED",
        errorCode: "LEASE_EXPIRED",
        errorDetail: "lease lost before artifact publish",
        inputHash: value.inputHash,
        outputHash: value.contentHash,
      };
    }
    if (analysisId === null) {
      throw new Error("internal: analysis missing after successful orchestration");
    }
    // Reserve the next version before publishing: byte paths embed the
    // version, and the fenced attach re-verifies this reservation.
    const reserved = nextResumeVersion(context.handle, payload.jobId);
    let published: ReturnType<typeof publishArtifacts>;
    try {
      published = publishArtifacts({
        artifactsDir: deps.artifactsDir,
        jobKey: payload.jobId,
        versionNumber: reserved.versionNumber,
        contentHash: value.contentHash,
        markdown: value.markdown,
        docx: value.docx,
        pdf: value.pdf,
      });
    } catch (error: unknown) {
      return {
        ...failJob(
          context.handle,
          payload.jobId,
          start.fenceVersion,
          "STALE_INPUT",
          `artifact publish failed: ${(error as Error).message}`,
          clock(),
        ),
        inputHash: value.inputHash,
        outputHash: value.contentHash,
      };
    }

    const attached = attachResumeVersion(context.handle, {
      start,
      extractionId: payload.extractionId,
      analysisId,
      result: value,
      artifacts: published.records,
      expectedVersion: reserved,
      now: clock(),
    });
    if (!attached.ok) {
      return {
        result: "BLOCKED",
        errorCode: "STALE_INPUT",
        errorDetail: attached.detail,
        inputHash: value.inputHash,
        outputHash: value.contentHash,
      };
    }
    if (attached.reused && attached.versionNumber !== reserved.versionNumber) {
      // Idempotent rerun: ensure the existing version's files are
      // present (identical bytes are reused, never rewritten).
      try {
        publishArtifacts({
          artifactsDir: deps.artifactsDir,
          jobKey: payload.jobId,
          versionNumber: attached.versionNumber,
          contentHash: value.contentHash,
          markdown: value.markdown,
          docx: value.docx,
          pdf: value.pdf,
        });
      } catch (error: unknown) {
        log.error("artifact re-verify failed after dedupe attach", {
          workItemId: context.item.id,
          jobId: payload.jobId,
          detail: (error as Error).message,
        });
      }
    }
    log.info("tailor run attached", {
      workItemId: context.item.id,
      jobId: payload.jobId,
      resumeVersionId: attached.resumeVersionId,
      versionNumber: attached.versionNumber,
      reused: attached.reused,
      analysisId,
    });
    return {
      result: "SUCCEEDED",
      inputHash: value.inputHash,
      outputHash: value.contentHash,
    };
  };
}
