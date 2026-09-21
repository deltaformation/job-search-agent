// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  generationProgressEvents,
  generationRequests,
  jobs,
  newId,
  resumeAssessments,
  tailoringRequestInputs,
  tailoringWorkspaces,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import {
  appendProgressFenced,
  insertAssessment,
  insertRequestInputs,
  markWorkspaceSubmitted,
  readAssessment,
  readRequestInputs,
  readRequestProgress,
  saveWorkspaceCAS,
} from "../../../src/db/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import { getOrCreateCandidateSnapshot } from "../../../src/server/candidates";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { canonicalJson } from "../../../src/domain/canonical";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  recommendationHashFor,
  seedV13Assessment,
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  stubRecommendationsProvider,
  v13Assessment,
  v13Focus,
  v13Recommendations,
  V13_MASTER_TEXT,
  V13_T0,
  withV13Database,
} from "./v13world";

/**
 * B3/B4/B5 + B6-progress: immutable request inputs, the fenced
 * progress log, assessment binding, the bounded progress read F
 * consumes, and the submission stamp E composes. Trigger names are
 * asserted exactly; G/E/F map them to HTTP codes.
 */

function countQueries(handle: DatabaseHandle, fn: () => void): number {
  const sqlite = handle.sqlite;
  const originalPrepare = sqlite.prepare;
  let queryCount = 0;
  sqlite.prepare = ((source: string) => {
    queryCount += 1;
    return originalPrepare.call(sqlite, source);
  }) as typeof sqlite.prepare;
  try {
    fn();
  } finally {
    sqlite.prepare = originalPrepare;
  }
  return queryCount;
}

function eventInput(run: { requestId: string; workItemId: string; attemptId: string; leaseToken: string }) {
  return {
    requestId: run.requestId,
    workItemId: run.workItemId,
    attemptId: run.attemptId,
    leaseToken: run.leaseToken,
  };
}

describe("B3 immutable request inputs", () => {
  it("stores and reads back the frozen extension row (Q3)", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const { inputHash } = seedV13RequestInputs(t.handle, basics, run);
      const row = readRequestInputs(t.handle, run.requestId);
      expect(row).toMatchObject({
        requestId: run.requestId,
        workspaceRevision: 1,
        submitHash: run.submitHash,
        inputHash,
        candidateSnapshotId: basics.snapshotId,
        projectionVersion: "master-text/1",
      });
      expect(JSON.parse(row?.focusJson ?? "")).toMatchObject({
        schemaVersion: "tailoring-focus/v1",
      });
      expect(readRequestInputs(t.handle, newId())).toBeNull();
    });
  });

  it("rejects a snapshot from another profile with INPUT_PROFILE_MISMATCH", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const spmSnapshot = getOrCreateCandidateSnapshot(t.handle, {
        profileVersionId: world.spmVersionId,
      });
      if (!spmSnapshot.ok) {
        throw new Error(`spm snapshot failed: ${spmSnapshot.error}`);
      }
      expect(() =>
        seedV13RequestInputs(t.handle, basics, run, {
          candidateSnapshotId: spmSnapshot.snapshotId,
        }),
      ).toThrow(/INPUT_PROFILE_MISMATCH/);
    });
  });

  it("refuses UPDATE and DELETE with INPUT_IMMUTABLE", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      expect(() =>
        t.handle.db
          .update(tailoringRequestInputs)
          .set({ workspaceRevision: 2 })
          .where(eq(tailoringRequestInputs.requestId, run.requestId))
          .run(),
      ).toThrow(/INPUT_IMMUTABLE/);
      expect(() =>
        t.handle.db
          .delete(tailoringRequestInputs)
          .where(eq(tailoringRequestInputs.requestId, run.requestId))
          .run(),
      ).toThrow(/INPUT_IMMUTABLE/);
      expect(readRequestInputs(t.handle, run.requestId)?.workspaceRevision).toBe(1);
    });
  });

  it("rejects duplicate requests and malformed hashes at the schema", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      expect(() => seedV13RequestInputs(t.handle, basics, run)).toThrow(
        /UNIQUE constraint failed: tailoring_request_inputs\.request_id/,
      );
      const other = seedV13RunningRun(t.handle, seedV13Basics(t.handle, world));
      expect(() => seedV13RequestInputs(t.handle, basics, other, { inputHash: "zz" })).toThrow(
        /CHECK constraint failed: v13_in_hash/,
      );
    });
  });

  it("later W saves never change the frozen Q3 bytes", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const before = JSON.stringify({
        request: t.handle.db.select().from(generationRequests).all(),
        inputs: t.handle.db.select().from(tailoringRequestInputs).all(),
      });
      const provider = stubRecommendationsProvider(v13Recommendations(basics));
      const draft: Parameters<typeof saveWorkspace>[3] = {
        schemaVersion: "tailoring-workspace/v1",
        extractionId: basics.extractionId,
        profileId: basics.profileId,
        profileVersionId: basics.profileVersionId,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        recommendationHash: recommendationHashFor(basics),
        focus: v13Focus(),
      };
      expect(saveWorkspace(t.handle, basics.jobId, 0, { ...draft }, { now: () => V13_T0, recommendations: provider }).ok).toBe(true);
      expect(
        saveWorkspace(
          t.handle,
          basics.jobId,
          1,
          { ...draft, focus: v13Focus({ summaryDirection: "Changed after submit." }) },
          { now: () => V13_T0, recommendations: provider },
        ).ok,
      ).toBe(true);
      const after = JSON.stringify({
        request: t.handle.db.select().from(generationRequests).all(),
        inputs: t.handle.db.select().from(tailoringRequestInputs).all(),
      });
      expect(after).toBe(before);
    });
  });
});

describe("B4 fenced progress events", () => {
  it("accepts a valid five-stage sequence with advancing timestamps", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const base = eventInput(run);
      const stages = [
        "PREPARING_INPUTS",
        "WAITING_FOR_PROVIDER",
        "VALIDATING_PROPOSAL",
        "RENDERING_ARTIFACTS",
        "PUBLISHING_RESULT",
      ] as const;
      stages.forEach((stage, index) => {
        appendProgressFenced(t.handle, {
          ...base,
          seq: index + 1,
          stage,
          source: "provider",
          recordedAt: new Date(Date.parse(V13_T0) + (index + 1) * 1000).toISOString(),
        });
      });
      const rows = t.handle.db
        .select()
        .from(generationProgressEvents)
        .where(eq(generationProgressEvents.requestId, run.requestId))
        .all();
      expect(rows.map((row) => row.stage)).toEqual([...stages]);
    });
  });

  it("rejects duplicate, skipped, regressing, stage-mismatched, and source-switch events by name", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const base = eventInput(run);
      const at = (seconds: number) => new Date(Date.parse(V13_T0) + seconds * 1000).toISOString();
      appendProgressFenced(t.handle, {
        ...base,
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: at(1),
      });
      appendProgressFenced(t.handle, {
        ...base,
        seq: 2,
        stage: "WAITING_FOR_PROVIDER",
        source: "provider",
        recordedAt: at(2),
      });
      const bad: Array<{ event: Record<string, unknown>; name: RegExp }> = [
        {
          event: { seq: 2, stage: "VALIDATING_PROPOSAL", source: "provider", recordedAt: at(3) },
          name: /PROGRESS_SEQUENCE_INVALID/,
        },
        {
          event: { seq: 4, stage: "VALIDATING_PROPOSAL", source: "provider", recordedAt: at(3) },
          name: /PROGRESS_SEQUENCE_INVALID/,
        },
        {
          event: { seq: 1, stage: "RENDERING_ARTIFACTS", source: "provider", recordedAt: at(3) },
          name: /PROGRESS_SEQUENCE_INVALID/,
        },
        {
          event: { seq: 3, stage: "VALIDATING_PROPOSAL", source: "cached", recordedAt: at(3) },
          name: /PROGRESS_SOURCE_INVALID/,
        },
        {
          event: { seq: 3, stage: "WAITING_FOR_PROVIDER", source: "provider", recordedAt: at(3) },
          name: /PROGRESS_STAGE_INVALID/,
        },
      ];
      for (const { event, name } of bad) {
        expect(() =>
          appendProgressFenced(t.handle, {
            ...base,
            seq: event["seq"] as number,
            stage: event["stage"] as "VALIDATING_PROPOSAL",
            source: event["source"] as "provider",
            recordedAt: event["recordedAt"] as string,
          }),
        ).toThrow(name);
      }
      const rows = t.handle.db
        .select()
        .from(generationProgressEvents)
        .where(eq(generationProgressEvents.requestId, run.requestId))
        .all();
      expect(rows).toHaveLength(2);
    });
  });

  it("rejects expired, wrong-token, foreign, and finished leases with LEASE_LOST", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const base = eventInput(run);
      const first = {
        ...base,
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
      } as const;
      expect(() =>
        appendProgressFenced(t.handle, { ...first, leaseToken: "wrong-token" }),
      ).toThrow(/LEASE_LOST/);
      expect(() => appendProgressFenced(t.handle, { ...first, attemptId: newId() })).toThrow(
        /LEASE_LOST/,
      );
      expect(() => appendProgressFenced(t.handle, { ...first, requestId: newId() })).toThrow(
        /LEASE_LOST/,
      );
      t.handle.db
        .update(workItems)
        .set({ leaseExpiresAt: "2026-09-16T11:00:00.000Z" })
        .where(eq(workItems.id, run.workItemId))
        .run();
      expect(() => appendProgressFenced(t.handle, first)).toThrow(/LEASE_LOST/);
      // WO-1.3-F: completion on an expired lease is dropped like
      // every other stale write — revive the lease, then finish.
      const dropped = completeWorkItem(t.handle, {
        workItemId: run.workItemId,
        leaseToken: run.leaseToken,
        result: "SUCCEEDED",
      });
      expect(dropped).toEqual({ ok: false, error: "lease-lost" });
      t.handle.db
        .update(workItems)
        .set({ leaseExpiresAt: new Date(Date.parse(V13_T0) + 300_000).toISOString() })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const finished = completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: run.leaseToken,
          result: "SUCCEEDED",
        },
        { now: V13_T0 },
      );
      expect(finished.ok).toBe(true);
      expect(() => appendProgressFenced(t.handle, first)).toThrow(/LEASE_LOST/);
      expect(
        t.handle.db.select().from(generationProgressEvents).all(),
      ).toEqual([]);
    });
  });

  it("rejects events before the attempt start or before the previous event", () => {
    // Pre-start events fail the live-tuple fence (LEASE_LOST);
    // out-of-order events fail the monotonicity rule
    // (PROGRESS_TIME_INVALID).
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const base = eventInput(run);
      expect(() =>
        appendProgressFenced(t.handle, {
          ...base,
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "provider",
          recordedAt: "2026-09-16T11:59:59.000Z",
        }),
      ).toThrow(/LEASE_LOST/);
      appendProgressFenced(t.handle, {
        ...base,
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 2000).toISOString(),
      });
      expect(() =>
        appendProgressFenced(t.handle, {
          ...base,
          seq: 2,
          stage: "WAITING_FOR_PROVIDER",
          source: "provider",
          recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
        }),
      ).toThrow(/PROGRESS_TIME_INVALID/);
    });
  });

  it("refuses UPDATE and DELETE with PROGRESS_IMMUTABLE", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      appendProgressFenced(t.handle, {
        ...eventInput(run),
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
      });
      expect(() =>
        t.handle.db
          .update(generationProgressEvents)
          .set({ stage: "PUBLISHING_RESULT" })
          .where(eq(generationProgressEvents.requestId, run.requestId))
          .run(),
      ).toThrow(/PROGRESS_IMMUTABLE/);
      expect(() =>
        t.handle.db
          .delete(generationProgressEvents)
          .where(eq(generationProgressEvents.requestId, run.requestId))
          .run(),
      ).toThrow(/PROGRESS_IMMUTABLE/);
    });
  });
});

describe("B5 assessment binding and immutability", () => {
  it("stores a bound assessment and reads it back (Q6)", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      const measuresJson = seedV13Assessment(t.handle, run, version);
      const row = readAssessment(t.handle, version.versionId);
      expect(row).toMatchObject({
        resumeVersionId: version.versionId,
        requestId: run.requestId,
        policyVersion: "assessment/1",
        masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
        tailoredContentHash: version.contentHash,
        measuresJson,
      });
      expect(readAssessment(t.handle, newId())).toBeNull();
    });
  });

  it("rejects wrong-request, wrong-hash, and snapshot-mismatch bindings", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      const measuresJson = canonicalJson(v13Assessment());
      const valid = {
        resumeVersionId: version.versionId,
        requestId: run.requestId,
        policyVersion: "assessment/1",
        masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
        tailoredContentHash: version.contentHash,
        measuresJson,
        now: V13_T0,
      } as const;
      expect(() => insertAssessment(t.handle, { ...valid, requestId: newId() })).toThrow(
        /ASSESSMENT_BINDING_INVALID/,
      );
      expect(() => insertAssessment(t.handle, { ...valid, masterTextHash: "e".repeat(64) })).toThrow(
        /ASSESSMENT_BINDING_INVALID/,
      );
      expect(
        () => insertAssessment(t.handle, { ...valid, tailoredContentHash: "d".repeat(64) }),
      ).toThrow(/ASSESSMENT_BINDING_INVALID/);
      expect(
        t.handle.db.select().from(resumeAssessments).all(),
      ).toEqual([]);
    });
  });

  it("rejects assessments whose candidate snapshot disagrees with the frozen inputs", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      // A parallel SPM request with SPM inputs on a second job.
      const other = seedV13Basics(t.handle, world);
      const spmSnapshot = getOrCreateCandidateSnapshot(t.handle, {
        profileVersionId: world.spmVersionId,
      });
      if (!spmSnapshot.ok) {
        throw new Error(`spm snapshot failed: ${spmSnapshot.error}`);
      }
      const spmRun = seedV13RunningRun(t.handle, other, {
        profileId: world.spmProfileId,
        profileVersionId: world.spmVersionId,
      });
      insertRequestInputs(t.handle, {
        requestId: spmRun.requestId,
        workspaceRevision: 1,
        submitHash: spmRun.submitHash,
        inputHash: "4".repeat(64),
        candidateSnapshotId: spmSnapshot.snapshotId,
        focusJson: canonicalJson(v13Focus()),
        recommendationsJson: canonicalJson(v13Recommendations(other)),
        masterText: V13_MASTER_TEXT,
        masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
        projectionVersion: "master-text/1",
        now: V13_T0,
      });
      // A PM version assessed against the SPM request must fail.
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      expect(() =>
        insertAssessment(t.handle, {
          resumeVersionId: version.versionId,
          requestId: spmRun.requestId,
          policyVersion: "assessment/1",
          masterTextHash: sha256HexUtf8(V13_MASTER_TEXT),
          tailoredContentHash: version.contentHash,
          measuresJson: canonicalJson(v13Assessment()),
          now: V13_T0,
        }),
      ).toThrow(/ASSESSMENT_BINDING_INVALID/);
    });
  });

  it("refuses UPDATE and DELETE with ASSESSMENT_IMMUTABLE", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      seedV13Assessment(t.handle, run, version);
      expect(() =>
        t.handle.db
          .update(resumeAssessments)
          .set({ measuresJson: canonicalJson(v13Assessment()) })
          .where(eq(resumeAssessments.resumeVersionId, version.versionId))
          .run(),
      ).toThrow(/ASSESSMENT_IMMUTABLE/);
      expect(() =>
        t.handle.db
          .delete(resumeAssessments)
          .where(eq(resumeAssessments.resumeVersionId, version.versionId))
          .run(),
      ).toThrow(/ASSESSMENT_IMMUTABLE/);
    });
  });

  it("keeps one version per request", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const first = seedV13Version(t.handle, basics, run);
      expect(() =>
        seedV13Version(t.handle, basics, run, { version: 2, analysisId: first.analysisId }),
      ).toThrow(/UNIQUE constraint failed: resume_versions\.generation_request_id/);
    });
  });
});

describe("B6 bounded progress read (F primitive)", () => {
  it("reads a running attempt with ordered events and no lease token", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      appendProgressFenced(t.handle, {
        ...eventInput(run),
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
      });
      appendProgressFenced(t.handle, {
        ...eventInput(run),
        seq: 2,
        stage: "WAITING_FOR_PROVIDER",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 2000).toISOString(),
      });
      const snapshot = readRequestProgress(t.handle, run.requestId);
      expect(snapshot).toMatchObject({
        requestId: run.requestId,
        jobId: basics.jobId,
        status: "RUNNING",
        workItemId: run.workItemId,
        workState: "RUNNING",
        currentAttemptId: run.attemptId,
        attemptNumber: 1,
        startedAt: V13_T0,
        finishedAt: null,
        resumeVersionId: null,
      });
      expect(snapshot?.leaseExpiresAt).not.toBeNull();
      expect(snapshot?.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(JSON.stringify(snapshot)).not.toContain(run.leaseToken);
      expect(JSON.stringify(snapshot)).not.toContain("payload");
      expect(JSON.stringify(snapshot)).not.toContain("steering");
    });
  });

  it("resolves the published version and degrades for queued or unknown requests", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      expect(readRequestProgress(t.handle, run.requestId)?.resumeVersionId).toBe(
        version.versionId,
      );
      const queuedBasics = seedV13Basics(t.handle, world);
      const queuedId = newId();
      const queuedItem = newId();
      t.handle.db
        .insert(workItems)
        .values({
          id: queuedItem,
          kind: "TAILOR",
          jobId: queuedBasics.jobId,
          idempotencyKey: `key-${queuedItem}`,
          payloadJson: JSON.stringify({
            schemaVersion: "tailor-queue/v3",
            generationRequestId: queuedId,
            jobId: queuedBasics.jobId,
            extractionId: queuedBasics.extractionId,
            profileId: queuedBasics.profileId,
            profileVersionId: queuedBasics.profileVersionId,
            jdSnapshotId: queuedBasics.jdSnapshotId,
            payloadHash: "2".repeat(64),
            inputHash: "1".repeat(64),
          }),
        })
        .run();
      t.handle.db
        .insert(generationRequests)
        .values({
          id: queuedId,
          requestIdentity: `genreq:v1:${queuedId}`,
          jobId: queuedBasics.jobId,
          extractionId: queuedBasics.extractionId,
          profileId: queuedBasics.profileId,
          profileVersionId: queuedBasics.profileVersionId,
          jdSnapshotId: queuedBasics.jdSnapshotId,
          requestKind: "INITIAL",
          steeringSnapshotJson: "{}",
          selectedKeywordsJson: "[]",
          payloadHash: "2".repeat(64),
          status: "QUEUED",
          workItemId: queuedItem,
          createdAt: V13_T0,
          updatedAt: V13_T0,
        })
        .run();
      expect(readRequestProgress(t.handle, queuedId)).toMatchObject({
        workState: "QUEUED",
        currentAttemptId: null,
        attemptNumber: null,
        events: [],
        resumeVersionId: null,
      });
      expect(readRequestProgress(t.handle, newId())).toBeNull();
    });
  });

  it("uses exactly 5 statements beside 1000 history rows", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      appendProgressFenced(t.handle, {
        ...eventInput(run),
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
      });
      for (let n = 0; n < 500; n += 1) {
        const jobId = newId();
        t.handle.db
          .insert(jobs)
          .values({ id: jobId, status: "NEW", rowVersion: 1, tailoringState: "READY" })
          .run();
        t.handle.db
          .insert(tailoringWorkspaces)
          .values({
            jobId,
            revision: 1,
            requestKind: "INITIAL",
            focusJson: canonicalJson(v13Focus()),
            createdAt: V13_T0,
            updatedAt: V13_T0,
          })
          .run();
      }
      const queries = countQueries(t.handle, () => {
        const snapshot = readRequestProgress(t.handle, run.requestId);
        expect(snapshot?.events).toHaveLength(1);
      });
      expect(queries).toBe(5);
    });
  });
});

describe("B2 submission stamp (E primitive)", () => {
  it("conflicts at revision 0 on an absent workspace", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      expect(
        markWorkspaceSubmitted(t.handle, {
          jobId: basics.jobId,
          observedRevision: 0,
          requestId: newId(),
          now: V13_T0,
        }),
      ).toEqual({ ok: false, error: "conflict", currentRevision: 0 });
    });
  });

  it("writes through saveWorkspaceCAS conflicts without partial rows", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const first = saveWorkspaceCAS(t.handle, {
        jobId: basics.jobId,
        observedRevision: 0,
        extractionId: null,
        profileId: null,
        profileVersionId: null,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        focusJson: canonicalJson(v13Focus()),
        recommendationsJson: null,
        recommendationHash: null,
        now: V13_T0,
      });
      expect(first).toEqual({ ok: true, revision: 1, created: true });
      const raced = saveWorkspaceCAS(t.handle, {
        jobId: basics.jobId,
        observedRevision: 0,
        extractionId: null,
        profileId: null,
        profileVersionId: null,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        focusJson: canonicalJson(v13Focus({ summaryDirection: "Racer." })),
        recommendationsJson: null,
        recommendationHash: null,
        now: V13_T0,
      });
      expect(raced).toEqual({ ok: false, error: "conflict", currentRevision: 1 });
      const row = t.handle.db
        .select()
        .from(tailoringWorkspaces)
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .get();
      expect(row?.revision).toBe(1);
      expect(row?.focusJson).toBe(canonicalJson(v13Focus()));
    });
  });
});
