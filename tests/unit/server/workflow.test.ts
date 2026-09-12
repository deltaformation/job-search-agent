import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  withTransaction,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import {
  applications,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshots,
  intakeBatches,
  intakeItems,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobNotes,
  jobs,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  workItems,
  workflowEvents,
} from "../../../src/db/schema";
import type { BoardStatus } from "../../../src/domain/enums";
import { parseWorkflowEventMetadata } from "../../../src/domain/workflow";
import {
  addNote,
  approveTailored,
  correctJob,
  moveJob,
  recordApplication,
  reorderJob,
} from "../../../src/server/workflow";

const NOW = "2026-09-11T12:00:00.000Z";
const APPLIED_AT = "2026-09-11T09:30:00.000Z";

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-workflow-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function seedJob(
  handle: DatabaseHandle,
  overrides: {
    status?: BoardStatus;
    rank?: number;
    rowVersion?: number;
    activeResumeVersionId?: string | null;
  } = {},
): string {
  const id = newId();
  handle.db
    .insert(jobs)
    .values({
      id,
      status: overrides.status ?? "NEW",
      rank: overrides.rank ?? 0,
      rowVersion: overrides.rowVersion ?? 1,
      activeResumeVersionId: overrides.activeResumeVersionId ?? null,
    })
    .run();
  return id;
}

function readJob(handle: DatabaseHandle, jobId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

function readEvents(handle: DatabaseHandle, jobId: string) {
  return handle.db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.jobId, jobId))
    .all();
}

let seedProfileVersion = 0;

/** Full resume-approval fixture chain for Tailored-gate tests. */
function seedApprovalChain(
  handle: DatabaseHandle,
  jobId: string,
  overrides: {
    reviewState?: string;
    reviewAction?: string;
    reviewActor?: string;
    reviewContentHash?: string;
    versionContentHash?: string;
  } = {},
): { versionId: string; reviewId: string } {
  const attemptId = newId();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: NOW,
      finishedAt: NOW,
      outcome: "SUCCEEDED",
    })
    .run();
  const extractionId = newId();
  handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "generic",
      extractedJson: "{}",
    })
    .run();
  const jdSnapshotId = newId();
  handle.db
    .insert(jdSnapshots)
    .values({
      id: jdSnapshotId,
      jobId,
      extractionId,
      jdText: "Staff Engineer",
      canonicalSha256: "0".repeat(64),
    })
    .run();
  handle.db
    .insert(candidateProfiles)
    .values({ id: "local" })
    .onConflictDoNothing()
    .run();
  const profileVersionId = newId();
  seedProfileVersion += 1;
  handle.db
    .insert(candidateProfileVersions)
    .values({
      id: profileVersionId,
      profileId: "local",
      version: seedProfileVersion,
      payloadJson: "{}",
      payloadHash: "1".repeat(64),
      schemaVersion: "candidate-profile-v1",
    })
    .run();
  const candidateSnapshotId = newId();
  handle.db
    .insert(candidateSnapshots)
    .values({
      id: candidateSnapshotId,
      profileVersionId,
      canonicalJson: "{}",
      schemaVersion: "candidate-snapshot-v1",
      sha256: "2".repeat(64),
    })
    .run();
  const analysisId = newId();
  handle.db
    .insert(jobAnalyses)
    .values({
      id: analysisId,
      jobId,
      jdSnapshotId,
      candidateSnapshotId,
      requirementsJson: "[]",
      gapsJson: "[]",
      promptVersion: "prompt-v1",
      proposalSchemaVersion: "proposal-v1",
    })
    .run();
  const versionId = newId();
  const versionContentHash = overrides.versionContentHash ?? "3".repeat(64);
  handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId,
      version: 1,
      analysisId,
      templateId: "standard",
      templateVersion: "v1",
      templateHash: "4".repeat(64),
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      contentJson: "{}",
      contentHash: versionContentHash,
      reviewState: overrides.reviewState ?? "APPROVED",
    })
    .run();
  const reviewId = newId();
  handle.db
    .insert(resumeReviews)
    .values({
      id: reviewId,
      resumeVersionId: versionId,
      action: overrides.reviewAction ?? "APPROVED",
      actor: overrides.reviewActor ?? "human",
      resumeHash: "5".repeat(64),
      contentHash: overrides.reviewContentHash ?? versionContentHash,
      artifactHashesJson: "{}",
    })
    .run();
  handle.db
    .update(jobs)
    .set({ activeResumeVersionId: versionId })
    .where(eq(jobs.id, jobId))
    .run();
  return { versionId, reviewId };
}

function seedQueuedWork(
  handle: DatabaseHandle,
  overrides: {
    jobId?: string | null;
    intakeItemId?: string | null;
    state?: string;
  } = {},
): string {
  const id = newId();
  const state = overrides.state ?? "QUEUED";
  handle.db
    .insert(workItems)
    .values({
      id,
      kind: "SCRAPE",
      idempotencyKey: `probe:${id}`,
      jobId: overrides.jobId ?? null,
      intakeItemId: overrides.intakeItemId ?? null,
      state,
      // The lease CHECK requires RUNNING rows to hold a lease at insert.
      leaseToken: state === "RUNNING" ? `lease-${id}` : null,
      leasedAt: state === "RUNNING" ? NOW : null,
      leaseExpiresAt: state === "RUNNING" ? NOW : null,
    })
    .run();
  return id;
}

describe("ordinary moves", () => {
  it("moves TAILORED → APPLIED and records the application", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED", rank: 0 });
      seedJob(t.handle, { status: "APPLIED", rank: 2 });
      const result = moveJob(t.handle, {
        jobId,
        to: "APPLIED",
        observedRowVersion: 1,
        appliedAt: APPLIED_AT,
        confirmationNumber: "CONF-42",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({
        from: "TAILORED",
        to: "APPLIED",
        newRowVersion: 2,
        rank: 3,
        viaCorrection: false,
      });
      expect(result.applicationId).toBeTypeOf("string");
      const job = readJob(t.handle, jobId);
      expect(job?.status).toBe("APPLIED");
      expect(job?.rowVersion).toBe(2);
      expect(job?.rank).toBe(3);
      const application = t.handle.db
        .select()
        .from(applications)
        .where(eq(applications.jobId, jobId))
        .get();
      expect(application).toMatchObject({
        recordedBy: "human",
        appliedAt: APPLIED_AT,
        confirmationNumber: "CONF-42",
      });
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: "human",
        fromStatus: "TAILORED",
        toStatus: "APPLIED",
        rank: 3,
        rowVersion: 2,
        reason: "move",
      });
      expect(parseWorkflowEventMetadata(events[0].metadataJson)).toMatchObject({
        appliedAt: APPLIED_AT,
        confirmationNumber: "CONF-42",
      });
    });
  });

  it("requires a reason for ordinary REJECTED moves and writes nothing without one", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      const rejected = moveJob(t.handle, {
        jobId,
        to: "REJECTED",
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error).toBe("reason-required");
      expect(readJob(t.handle, jobId)?.rowVersion).toBe(1);
      expect(readEvents(t.handle, jobId)).toHaveLength(0);

      const accepted = moveJob(t.handle, {
        jobId,
        to: "REJECTED",
        observedRowVersion: 1,
        reason: "Role is onsite-only",
        actor: "human",
        now: NOW,
      });
      expect(accepted.ok).toBe(true);
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(parseWorkflowEventMetadata(events[0].metadataJson)).toMatchObject({
        reason: "Role is onsite-only",
      });
    });
  });

  it("rejects NEW → TAILORED without approval and commits nothing", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW" });
      const result = moveJob(t.handle, {
        jobId,
        to: "TAILORED",
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("approval-required");
      expect(readJob(t.handle, jobId)?.status).toBe("NEW");
      expect(readJob(t.handle, jobId)?.rowVersion).toBe(1);
      expect(readEvents(t.handle, jobId)).toHaveLength(0);
    });
  });

  it("returns conflicts with the current version for stale clients", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED", rowVersion: 4 });
      const result = moveJob(t.handle, {
        jobId,
        to: "APPLIED",
        observedRowVersion: 3,
        appliedAt: APPLIED_AT,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("conflict");
      expect(result.currentRowVersion).toBe(4);
      expect(readEvents(t.handle, jobId)).toHaveLength(0);
    });
  });

  it("returns unknown-job for missing jobs", () => {
    withDatabase((t) => {
      const result = moveJob(t.handle, {
        jobId: newId(),
        to: "REJECTED",
        observedRowVersion: 1,
        reason: "nope",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("unknown-job");
    });
  });

  it("honors explicit ranks and rejects non-finite ones", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "APPLIED", rank: 0 });
      const result = moveJob(t.handle, {
        jobId,
        to: "INTERVIEWED",
        observedRowVersion: 1,
        rank: 1.5,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rank).toBe(1.5);

      for (const rank of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          moveJob(t.handle, {
            jobId,
            to: "REJECTED",
            observedRowVersion: 2,
            rank,
            reason: "x",
            actor: "human",
            now: NOW,
          }),
        ).toThrow();
      }
      expect(() =>
        moveJob(t.handle, {
          jobId,
          to: "REJECTED",
          observedRowVersion: 2,
          reason: "x",
          actor: "agent",
          now: NOW,
        }),
      ).toThrow();
    });
  });
});

describe("corrections", () => {
  it("reopens APPLIED → NEW with a mirrored note", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "APPLIED" });
      const result = correctJob(t.handle, {
        jobId,
        to: "NEW",
        observedRowVersion: 1,
        note: "Withdrew the application; starting over",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({
        from: "APPLIED",
        to: "NEW",
        newRowVersion: 2,
        viaCorrection: true,
      });
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe("correction");
      expect(parseWorkflowEventMetadata(events[0].metadataJson)).toMatchObject({
        note: "Withdrew the application; starting over",
      });
      const notes = t.handle.db
        .select()
        .from(jobNotes)
        .where(eq(jobNotes.jobId, jobId))
        .all();
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe("Withdrew the application; starting over");
    });
  });

  it("reopens REJECTED → NEW", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "REJECTED" });
      const result = correctJob(t.handle, {
        jobId,
        to: "NEW",
        observedRowVersion: 1,
        note: "Recruiter called back; reopening",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      expect(readJob(t.handle, jobId)?.status).toBe("NEW");
    });
  });

  it("requires a note and keeps TAILORED approval-only", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "APPLIED" });
      expect(() =>
        correctJob(t.handle, {
          jobId,
          to: "TAILORED",
          observedRowVersion: 1,
          note: "   ",
          actor: "human",
          now: NOW,
        }),
      ).toThrow();
      const tailored = correctJob(t.handle, {
        jobId,
        to: "TAILORED",
        observedRowVersion: 1,
        note: "Trying to skip approval",
        actor: "human",
        now: NOW,
      });
      expect(tailored.ok).toBe(false);
      if (tailored.ok) return;
      expect(tailored.error).toBe("approval-required");
      const tailoredJob = seedJob(t.handle, { status: "TAILORED" });
      const applied = correctJob(t.handle, {
        jobId: tailoredJob,
        to: "APPLIED",
        observedRowVersion: 1,
        note: "Re-recording without a timestamp",
        actor: "human",
        now: NOW,
      });
      expect(applied.ok).toBe(false);
      if (applied.ok) return;
      expect(applied.error).toBe("application-data-required");
      expect(readEvents(t.handle, jobId)).toHaveLength(0);
      expect(readEvents(t.handle, tailoredJob)).toHaveLength(0);
    });
  });
});

describe("reorder", () => {
  it("reorders within a column with an audit event", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW", rank: 0 });
      const result = reorderJob(t.handle, {
        jobId,
        rank: 2.5,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({
        status: "NEW",
        newRowVersion: 2,
        rank: 2.5,
        moved: true,
      });
      expect(result.eventId).toBeTypeOf("string");
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: "NEW",
        toStatus: "NEW",
        rank: 2.5,
        rowVersion: 2,
        reason: "reorder",
      });
      expect(events[0].metadataJson).toBeNull();
    });
  });

  it("treats same-rank reorders as version-checked no-ops", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW", rank: 1 });
      const noop = reorderJob(t.handle, {
        jobId,
        rank: 1,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(noop).toMatchObject({ ok: true, moved: false, eventId: null });
      expect(readJob(t.handle, jobId)?.rowVersion).toBe(1);
      expect(readEvents(t.handle, jobId)).toHaveLength(0);

      const stale = reorderJob(t.handle, {
        jobId,
        rank: 1,
        observedRowVersion: 99,
        actor: "human",
        now: NOW,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error).toBe("conflict");
      expect(stale.currentRowVersion).toBe(1);
    });
  });

  it("shares the version counter with status moves", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      const moved = moveJob(t.handle, {
        jobId,
        to: "APPLIED",
        observedRowVersion: 1,
        appliedAt: APPLIED_AT,
        actor: "human",
        now: NOW,
      });
      expect(moved.ok).toBe(true);
      const stale = reorderJob(t.handle, {
        jobId,
        rank: 9,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error).toBe("conflict");
      expect(readJob(t.handle, jobId)?.rowVersion).toBe(2);
    });
  });
});

describe("recordApplication", () => {
  it("confirms TAILORED → APPLIED with the modal payload", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      const result = recordApplication(t.handle, {
        jobId,
        observedRowVersion: 1,
        appliedAt: APPLIED_AT,
        confirmationNumber: "  ",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({
        from: "TAILORED",
        newRowVersion: 2,
        appliedAt: APPLIED_AT,
      });
      expect(result.applicationId).toBeTypeOf("string");
      // Blank confirmation numbers normalize to null, not empty strings.
      const application = t.handle.db
        .select()
        .from(applications)
        .where(eq(applications.jobId, jobId))
        .get();
      expect(application?.confirmationNumber).toBeNull();
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(
        parseWorkflowEventMetadata(events[0].metadataJson),
      ).toMatchObject({ appliedAt: APPLIED_AT });
      expect(
        parseWorkflowEventMetadata(events[0].metadataJson),
      ).not.toHaveProperty("confirmationNumber");
    });
  });

  it("refuses jobs outside the ordinary APPLIED path", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW" });
      const result = recordApplication(t.handle, {
        jobId,
        observedRowVersion: 1,
        appliedAt: APPLIED_AT,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("correction-required");
      expect(readEvents(t.handle, jobId)).toHaveLength(0);
    });
  });

  it("re-entering APPLIED updates the single application row", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      const first = recordApplication(t.handle, {
        jobId,
        observedRowVersion: 1,
        appliedAt: APPLIED_AT,
        confirmationNumber: "OLD",
        actor: "human",
        now: NOW,
      });
      expect(first.ok).toBe(true);
      const away = correctJob(t.handle, {
        jobId,
        to: "INTERVIEWED",
        observedRowVersion: 2,
        note: "Moved on before recording properly",
        actor: "human",
        now: NOW,
      });
      expect(away.ok).toBe(true);
      const again = correctJob(t.handle, {
        jobId,
        to: "APPLIED",
        observedRowVersion: 3,
        note: "Re-recording the actual apply",
        appliedAt: "2026-09-10T08:00:00.000Z",
        confirmationNumber: "NEW",
        actor: "human",
        now: NOW,
      });
      expect(again.ok).toBe(true);
      const rows = t.handle.db
        .select()
        .from(applications)
        .where(eq(applications.jobId, jobId))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        appliedAt: "2026-09-10T08:00:00.000Z",
        confirmationNumber: "NEW",
      });
      expect(readEvents(t.handle, jobId)).toHaveLength(3);
    });
  });
});

describe("approveTailored", () => {
  it("moves NEW → TAILORED on an exact-version human approval", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW", rank: 4 });
      const { versionId, reviewId } = seedApprovalChain(t.handle, jobId);
      const result = approveTailored(t.handle, {
        jobId,
        resumeVersionId: versionId,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({
        newRowVersion: 2,
        rank: 4,
        resumeVersionId: versionId,
        reviewId,
      });
      expect(readJob(t.handle, jobId)?.status).toBe("TAILORED");
      // R4-F: the same compare-and-swap flips tailoring to APPROVED.
      expect(readJob(t.handle, jobId)?.tailoringState).toBe("APPROVED");
      const events = readEvents(t.handle, jobId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: "NEW",
        toStatus: "TAILORED",
        reason: "approval",
      });
      expect(parseWorkflowEventMetadata(events[0].metadataJson)).toMatchObject({
        resumeVersionId: versionId,
        reviewId,
      });
    });
  });

  it("rejects every binding gap and commits nothing", () => {
    withDatabase((t) => {
      // No active pointer at all.
      const bare = seedJob(t.handle, { status: "NEW" });
      const missing = approveTailored(t.handle, {
        jobId: bare,
        resumeVersionId: newId(),
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error).toBe("tailored-binding");

      // Pointer aims at a different version than the approved one.
      const other = seedJob(t.handle, { status: "NEW" });
      const chain = seedApprovalChain(t.handle, other);
      const mismatch = approveTailored(t.handle, {
        jobId: other,
        resumeVersionId: newId(),
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(mismatch).toMatchObject({ ok: false, error: "tailored-binding" });

      // Version exists but was never approved.
      const draft = seedJob(t.handle, { status: "NEW" });
      const draftChain = seedApprovalChain(t.handle, draft, {
        reviewState: "DRAFT",
        reviewAction: "REVISION_REQUESTED",
      });
      const unapproved = approveTailored(t.handle, {
        jobId: draft,
        resumeVersionId: draftChain.versionId,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(unapproved).toMatchObject({ ok: false, error: "tailored-binding" });

      // APPROVED review binds a different content hash (stale approval).
      const stale = seedJob(t.handle, { status: "NEW" });
      const staleChain = seedApprovalChain(t.handle, stale, {
        reviewContentHash: "9".repeat(64),
      });
      const staleApproval = approveTailored(t.handle, {
        jobId: stale,
        resumeVersionId: staleChain.versionId,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(staleApproval).toMatchObject({
        ok: false,
        error: "tailored-binding",
      });

      // Non-human APPROVED rows never open the gate.
      const agent = seedJob(t.handle, { status: "NEW" });
      const agentChain = seedApprovalChain(t.handle, agent, {
        reviewActor: "agent",
      });
      const agentApproval = approveTailored(t.handle, {
        jobId: agent,
        resumeVersionId: agentChain.versionId,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(agentApproval).toMatchObject({
        ok: false,
        error: "tailored-binding",
      });

      // Non-NEW jobs are forbidden even with a perfect binding.
      const tailored = seedJob(t.handle, { status: "TAILORED" });
      const tailoredChain = seedApprovalChain(t.handle, tailored);
      const forbidden = approveTailored(t.handle, {
        jobId: tailored,
        resumeVersionId: tailoredChain.versionId,
        observedRowVersion: 1,
        actor: "human",
        now: NOW,
      });
      expect(forbidden).toMatchObject({ ok: false, error: "forbidden" });

      for (const id of [bare, other, draft, stale, agent, tailored]) {
        expect(readEvents(t.handle, id)).toHaveLength(0);
      }
      expect(chain.versionId).toBeTypeOf("string");
    });
  });

  it("conflicts on stale versions and composes in outer transactions", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW" });
      const { versionId } = seedApprovalChain(t.handle, jobId);
      const stale = approveTailored(t.handle, {
        jobId,
        resumeVersionId: versionId,
        observedRowVersion: 99,
        actor: "human",
        now: NOW,
      });
      expect(stale).toMatchObject({ ok: false, error: "conflict" });

      // R4-F shape: the approval transaction writes review rows, then the
      // gate runs inside the same transaction via the nest-safe helper.
      const composed = withTransaction(t.handle.sqlite, () =>
        approveTailored(t.handle, {
          jobId,
          resumeVersionId: versionId,
          observedRowVersion: 1,
          actor: "human",
          now: NOW,
        }),
      );
      expect(composed.ok).toBe(true);
      expect(readJob(t.handle, jobId)?.status).toBe("TAILORED");
    });
  });
});

describe("cancel on reject", () => {
  it("cancels the job's queued work and fences nothing else", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      const direct = seedQueuedWork(t.handle, { jobId });
      // Requeued scrape: linked through the intake item the job came from.
      const batchId = newId();
      t.handle.db.insert(intakeBatches).values({ id: batchId }).run();
      const intakeItemId = newId();
      t.handle.db
        .insert(intakeItems)
        .values({ id: intakeItemId, batchId, lineNumber: 1, rawInput: "x" })
        .run();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: newId(),
          jobId,
          intakeItemId,
          canonicalUrl: "https://example.com/jobs/1",
          startedAt: NOW,
          outcome: "FAILED",
        })
        .run();
      const requeued = seedQueuedWork(t.handle, { intakeItemId });
      const running = seedQueuedWork(t.handle, {
        jobId,
        state: "RUNNING",
      });
      const succeeded = seedQueuedWork(t.handle, {
        jobId,
        state: "SUCCEEDED",
      });
      const otherJob = seedJob(t.handle, { status: "NEW" });
      const unrelated = seedQueuedWork(t.handle, { jobId: otherJob });

      const result = moveJob(t.handle, {
        jobId,
        to: "REJECTED",
        observedRowVersion: 1,
        reason: "Duplicate posting",
        actor: "human",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.cancelledWorkItems.sort()).toEqual([direct, requeued].sort());

      const states = new Map(
        t.handle.db
          .select({ id: workItems.id, state: workItems.state })
          .from(workItems)
          .all()
          .map((row) => [row.id, row.state] as const),
      );
      expect(states.get(direct)).toBe("CANCELLED");
      expect(states.get(requeued)).toBe("CANCELLED");
      expect(states.get(running)).toBe("RUNNING");
      expect(states.get(succeeded)).toBe("SUCCEEDED");
      expect(states.get(unrelated)).toBe("QUEUED");

      const events = readEvents(t.handle, jobId);
      expect(
        parseWorkflowEventMetadata(events[0].metadataJson),
      ).toMatchObject({
        reason: "Duplicate posting",
        cancelledWorkItems: expect.arrayContaining([direct, requeued]),
      });
    });
  });
});

describe("notes", () => {
  it("appends notes without moving the card", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "NEW" });
      const result = addNote(t.handle, {
        jobId,
        body: "  Hiring manager is an ex-colleague  ",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({ jobId, createdAt: NOW });
      expect(result.noteId).toBeTypeOf("string");
      expect(readJob(t.handle, jobId)?.rowVersion).toBe(1);
      expect(readEvents(t.handle, jobId)).toHaveLength(0);
      const notes = t.handle.db
        .select()
        .from(jobNotes)
        .where(eq(jobNotes.jobId, jobId))
        .all();
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe("Hiring manager is an ex-colleague");

      const missing = addNote(t.handle, { jobId: newId(), body: "x" });
      expect(missing).toMatchObject({ ok: false, error: "unknown-job" });
      expect(() => addNote(t.handle, { jobId, body: "   " })).toThrow();
      expect(() => addNote(t.handle, { jobId, body: "x".repeat(4001) })).toThrow();
    });
  });
});
