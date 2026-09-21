// @vitest-environment node
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PUT as workspacePUT } from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  createTestDatabase,
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  resumeArtifacts,
  resumeVersions,
  scrapeAttempts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { TailoringErrorBody } from "../../../src/domain/tailoringWorkspace";
import { getBoardView } from "../../../src/server/board";
import { requestGeneration } from "../../../src/server/tailoring";
import {
  claimNextWorkItem,
  completeWorkItem,
  renewLease,
} from "../../../src/queue/leases";
import {
  PM_GUIDANCE,
  PM_JD_TEXT,
  runWithWorld,
  seedCrossProfileWorld,
  type CrossProfileWorld,
} from "../acceptance-v1.2/world";
import { routeParams, setupIsolatedRoot } from "../routes/_helpers";

/**
 * A5: future specs prove intended missing behavior for 412 stale
 * save, 409 busy/replay mismatch, LEASE_LOST, assessment mismatch,
 * and selected-approved download. Every pin shares its setup with a
 * passing guard; pins against current code fail at the documented
 * target assertion, while pins for wholly absent surfaces fail at
 * one marked `missingBehavior(...)` line after green setup.
 */

function missingBehavior(label: string): never {
  throw new Error(`EXPECTED FAILURE: ${label} is not implemented yet`);
}

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-v13-a5-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

/** A fresh NEW/READY job with an extracted JD, ready for INITIAL generation. */
function seedReadyJob(
  handle: DatabaseHandle,
  overrides: { jobId?: string } = {},
): { jobId: string; extractionId: string; rowVersion: number } {
  const jobId = overrides.jobId ?? newId();
  const extractionId = newId();
  const attemptId = newId();
  const now = "2026-09-16T12:00:00.000Z";
  handle.db
    .insert(jobs)
    .values({
      id: jobId,
      status: "NEW",
      rowVersion: 1,
      title: "Product Manager",
      company: "Harbor Analytics",
      descriptionText: PM_JD_TEXT,
      tailoringState: "READY",
    })
    .run();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/v13-ready",
      startedAt: now,
      finishedAt: now,
      outcome: "SUCCEEDED",
    })
    .run();
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
  handle.db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, jobId)).run();
  return { jobId, extractionId, rowVersion: 1 };
}

function tableNames(handle: DatabaseHandle): string[] {
  return handle.db
    .select({ name: sql<string>`name` })
    .from(sql`sqlite_master`)
    .where(sql`type = 'table'`)
    .all()
    .map((row) => row.name);
}

describe("A5 guard: v1.3 tables landed with B", () => {
  it("migrates 0000–0008 with workspaces/request-inputs/progress/assessment tables", () => {
    withDatabase((t) => {
      const names = tableNames(t.handle);
      expect(names).toContain("generation_requests");
      expect(names).toContain("tailoring_workspaces");
      expect(names).toContain("tailoring_request_inputs");
      expect(names).toContain("generation_progress_events");
      expect(names).toContain("resume_assessments");
    });
  });
});

describe("A5 B2: stale workspace save returns 412 WORKSPACE_CONFLICT", () => {
  it("guard: a ready job seeds cleanly on the isolated database", () => {
    withDatabase((t) => {
      const seeded = seedReadyJob(t.handle);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, seeded.jobId)).get();
      expect(job).toMatchObject({ status: "NEW", tailoringState: "READY", rowVersion: 1 });
    });
  });

  it("stale If-Match revision returns 412 with the current revision", async () => {
    // Flipped by WO-1.3-B: the workspace route now implements W.
    const isolated = setupIsolatedRoot("job-tracker-v13-a5b2-");
    try {
      const jobId = newId();
      const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
      try {
        handle.db
          .insert(jobs)
          .values({
            id: jobId,
            status: "NEW",
            rowVersion: 1,
            title: "Product Manager",
            company: "Harbor Analytics",
            descriptionText: PM_JD_TEXT,
            tailoringState: "READY",
          })
          .run();
      } finally {
        handle.close();
      }
      const path = `/api/jobs/${jobId}/tailoring/workspace`;
      const draft = JSON.stringify({
        schemaVersion: "tailoring-workspace/v1",
        extractionId: null,
        profileId: null,
        profileVersionId: null,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        recommendationHash: null,
        focus: {
          schemaVersion: "tailoring-focus/v1",
          selectedPhraseIds: [],
          themeId: null,
          summaryDirection: "",
          mappings: [],
          additionalGuidance: "",
        },
      });
      const headers = (etag: string) => ({
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "if-match": etag,
      });
      const created = await workspacePUT(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "PUT",
          headers: headers(`"tw:${jobId}:0"`),
          body: draft,
        }),
        routeParams(jobId),
      );
      expect(created.status).toBe(201);
      const stale = await workspacePUT(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "PUT",
          headers: headers(`"tw:${jobId}:0"`),
          body: draft,
        }),
        routeParams(jobId),
      );
      expect(stale.status).toBe(412);
      const body = TailoringErrorBody.parse((await stale.json()) as unknown);
      expect(body.error).toMatchObject({
        code: "WORKSPACE_CONFLICT",
        currentWorkspaceRevision: 1,
      });
    } finally {
      isolated.restoreEnv();
      isolated.cleanup();
    }
  });
});

describe("A5 E6/E9: same-ID replay mismatch and live-run busy return 409", () => {
  function setupLiveRun(t: TestDatabase, world: CrossProfileWorld) {
    const seeded = seedReadyJob(t.handle);
    const requestId = newId();
    const first = requestGeneration(
      t.handle,
      {
        jobId: seeded.jobId,
        observedRowVersion: seeded.rowVersion,
        actor: "human",
        profileId: world.pmProfileId,
        selectedKeywords: [...PM_GUIDANCE.selectedKeywords],
        directives: PM_GUIDANCE.directives,
        requestId,
      },
      { providerAvailable: () => true },
    );
    if (!first.ok) {
      throw new Error(`setup generation failed: ${JSON.stringify(first)}`);
    }
    return { seeded, requestId, first };
  }

  it("guard: initial generation queues one live run for the ready job", () => {
    const t = createTestDatabase("job-tracker-v13-a5-");
    try {
      const world = seedCrossProfileWorld(t);
      const { first } = setupLiveRun(t, world);
      expect(first.ok).toBe(true);
      expect(first.deduped).toBe(false);
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, first.workItemId))
        .get();
      expect(item?.state).toBe("QUEUED");
    } finally {
      t.cleanup();
    }
  });

  it("resubmitting the same operation id with changed bytes returns 409 IDEMPOTENCY_MISMATCH", () => {
    const t = createTestDatabase("job-tracker-v13-a5-");
    try {
      const world = seedCrossProfileWorld(t);
      const { seeded, requestId, first } = setupLiveRun(t, world);
      expect(first.ok).toBe(true);
      const changed = requestGeneration(
        t.handle,
        {
          jobId: seeded.jobId,
          observedRowVersion: first.newRowVersion,
          actor: "human",
          profileId: world.pmProfileId,
          selectedKeywords: ["B2B SaaS"],
          directives: "Changed guidance.",
          requestId,
        },
        { providerAvailable: () => true },
      );
      // WO-1.3-E: same operation id with different submission
      // bytes fails closed instead of returning the original run.
      expect(changed).toMatchObject({ ok: false, error: "idempotency-mismatch" });
    } finally {
      t.cleanup();
    }
  });

  it("a different operation id while a run is live returns 409 GENERATION_BUSY", () => {
    const t = createTestDatabase("job-tracker-v13-a5-");
    try {
      const world = seedCrossProfileWorld(t);
      const { seeded, first } = setupLiveRun(t, world);
      expect(first.ok).toBe(true);
      const concurrent = requestGeneration(
        t.handle,
        {
          jobId: seeded.jobId,
          observedRowVersion: first.newRowVersion,
          actor: "human",
          profileId: world.pmProfileId,
          selectedKeywords: [...PM_GUIDANCE.selectedKeywords],
          directives: PM_GUIDANCE.directives,
          requestId: newId(),
        },
        { providerAvailable: () => true },
      );
      // WO-1.3-E: a different operation id while the job has a
      // live run fails closed instead of attaching to the live run.
      expect(concurrent).toMatchObject({ ok: false, error: "generation-busy" });
    } finally {
      t.cleanup();
    }
  });
});

describe("A5 F6: expired leases cannot renew, complete, or publish", () => {
  const T0 = "2026-09-16T12:00:00.000Z";

  function seedClaimed(handle: DatabaseHandle): { workItemId: string; leaseToken: string } {
    const id = newId();
    handle.db
      .insert(workItems)
      .values({ id, kind: "SCRAPE", idempotencyKey: `key-${id}` })
      .run();
    const claimed = claimNextWorkItem(handle, {
      workerId: "worker-a",
      kinds: ["SCRAPE"],
      leaseDurationMs: 60_000,
      now: T0,
    });
    if (claimed === null) {
      throw new Error("setup claim failed");
    }
    return { workItemId: claimed.id, leaseToken: claimed.leaseToken };
  }

  function expireLease(handle: DatabaseHandle, workItemId: string): void {
    handle.db
      .update(workItems)
      .set({ leaseExpiresAt: "2026-09-16T11:00:00.000Z" })
      .where(eq(workItems.id, workItemId))
      .run();
  }

  it("guard: renew and complete succeed on a live lease", () => {
    withDatabase((t) => {
      const { workItemId, leaseToken } = seedClaimed(t.handle);
      const renewed = renewLease(t.handle, {
        workItemId,
        leaseToken,
        leaseDurationMs: 60_000,
        now: "2026-09-16T12:00:30.000Z",
      });
      expect(renewed.ok).toBe(true);
      // WO-1.3-F: complete now predicates on live expiry, so the
      // guard completes under a controlled clock, not wall time.
      const completed = completeWorkItem(
        t.handle,
        {
          workItemId,
          leaseToken,
          result: "SUCCEEDED",
        },
        { now: "2026-09-16T12:00:30.000Z" },
      );
      expect(completed.ok).toBe(true);
    });
  });

  it("renewing an expired lease returns lease-lost", () => {
    withDatabase((t) => {
      const { workItemId, leaseToken } = seedClaimed(t.handle);
      expireLease(t.handle, workItemId);
      const renewed = renewLease(t.handle, {
        workItemId,
        leaseToken,
        leaseDurationMs: 60_000,
        now: "2026-09-16T12:30:00.000Z",
      });
      // Flipped by WO-1.3-F: renewLease predicates on a live
      // expiry/current attempt, so an expired lease returns lease-lost.
      expect(renewed).toEqual({ ok: false, error: "lease-lost" });
    });
  });

  it("completing on an expired lease returns lease-lost", () => {
    withDatabase((t) => {
      const { workItemId, leaseToken } = seedClaimed(t.handle);
      expireLease(t.handle, workItemId);
      const completed = completeWorkItem(
        t.handle,
        { workItemId, leaseToken, result: "SUCCEEDED" },
        { now: "2026-09-16T12:30:00.000Z" },
      );
      // Flipped by WO-1.3-F: completeWorkItem predicates on a live
      // expiry/current attempt, so an expired lease returns lease-lost.
      expect(completed).toEqual({ ok: false, error: "lease-lost" });
    });
  });
});

describe("A5 G2/G5: assessment binding mismatch fails closed", () => {
  it("guard: an approved version with artifacts seeds without an assessment row", () => {
    runWithWorld((t, world) => {
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, world.jobId)).get();
      expect(job?.activeResumeVersionId).toBe(world.v1Id);
      expect(tableNames(t.handle)).toContain("resume_assessments");
    });
  });

  it.fails("an assessment bound to the wrong master hash is rejected", () => {
    runWithWorld((t, world) => {
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, world.jobId)).get();
      expect(job?.activeResumeVersionId).toBe(world.v1Id);
      // EXPECTED FAILURE (WO-1.3-G): inserting a resume_assessment whose
      // master/tailored hashes disagree with the frozen request input and
      // version content must fail with ASSESSMENT_BINDING_INVALID.
      missingBehavior("resume_assessments binding trigger (G assessment mismatch)");
    });
  });
});

describe("A5 H3: board download resolves the selected approved PDF", () => {
  function setupApprovedSelection(t: TestDatabase, world: CrossProfileWorld): string {
    const seeded = t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, world.v1Id))
      .all()
      .find((artifact) => artifact.kind === "PDF");
    if (seeded === undefined) {
      throw new Error("world seeds no PDF artifact for v1");
    }
    t.handle.db
      .update(resumeVersions)
      .set({ reviewState: "APPROVED" })
      .where(eq(resumeVersions.id, world.v1Id))
      .run();
    t.handle.db
      .update(jobs)
      .set({ selectedResumeVersionId: world.v1Id, status: "TAILORED" })
      .where(eq(jobs.id, world.jobId))
      .run();
    return seeded.id;
  }

  it("guard: the tailored card carries the active version pointer", () => {
    runWithWorld((t, world) => {
      const pdfId = setupApprovedSelection(t, world);
      const view = getBoardView(t.handle, {});
      const tailored = view.columns.find((column) => column.status === "TAILORED");
      const card = tailored?.cards.find((entry) => entry.id === world.jobId);
      expect(card?.resume?.versionId).toBe(world.v1Id);
      expect(pdfId).toBeTruthy();
    });
  });

  it("the card exposes the selected approved PDF artifact id", () => {
    runWithWorld((t, world) => {
      const pdfId = setupApprovedSelection(t, world);
      const view = getBoardView(t.handle, {});
      const tailored = view.columns.find((column) => column.status === "TAILORED");
      const card = tailored?.cards.find((entry) => entry.id === world.jobId);
      expect(card?.resume).toMatchObject({ versionId: world.v1Id });
      // WO-1.3-H: board cards batch the selected approved PDF
      // artifact id so Download Resume resolves Q7 exactly.
      expect(card?.selectedApprovedPdfArtifactId).toBe(pdfId);
    });
  });
});
