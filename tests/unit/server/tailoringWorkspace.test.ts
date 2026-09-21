// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  candidateProfiles,
  candidateProfileVersions,
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  tailoringWorkspaces,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { activateProfileVersion, getProfileVersion } from "../../../src/db/candidates";
import { markWorkspaceSubmitted } from "../../../src/db/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import type { WorkspacePut } from "../../../src/domain/tailoringWorkspace";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import {
  getWorkspaceView,
  listVersionSummaries,
  saveWorkspace,
} from "../../../src/server/tailoringWorkspace";
import {
  recommendationHashFor,
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  stubRecommendationsProvider,
  v13Focus,
  v13Recommendations,
  V13_T0,
  withV13Database,
  type V13Basics,
} from "../db/v13world";

/**
 * B2/B6 service leg: transaction W (CAS create/update, binding and
 * hash rules, selection validation, ownership, pointer
 * preservation, corruption) and the bounded version-history read.
 * Route-level status/ETag/413/403 assertions live in
 * `tests/unit/routes/tailoring-workspace.test.ts`.
 */

function emptyDraft(overrides: Partial<WorkspacePut> = {}): WorkspacePut {
  return {
    schemaVersion: "tailoring-workspace/v1",
    extractionId: null,
    profileId: null,
    profileVersionId: null,
    requestKind: "INITIAL",
    parentVersionId: null,
    revisionNote: null,
    recommendationHash: null,
    focus: v13Focus(),
    ...overrides,
  };
}

function boundDraft(basics: V13Basics, overrides: Partial<WorkspacePut> = {}): WorkspacePut {
  return emptyDraft({
    extractionId: basics.extractionId,
    profileId: basics.profileId,
    profileVersionId: basics.profileVersionId,
    recommendationHash: recommendationHashFor(basics),
    ...overrides,
  });
}

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

describe("B2 GET workspace (service)", () => {
  it("404s unknown jobs without touching the workspace table", () => {
    withV13Database((t) => {
      const missing = newId();
      const result = saveWorkspace(t.handle, missing, 0, emptyDraft(), {
        recommendations: stubRecommendationsProvider(null),
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("unreachable");
      }
      expect(result.failure.error).toBe("unknown-job");
      expect(getWorkspaceView(t.handle, missing)).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "unknown-job" }),
      });
    });
  });

  it("returns a null view at revision 0 without inserting", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const result = getWorkspaceView(t.handle, basics.jobId);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("unreachable");
      }
      expect(result.value.workspace).toBeNull();
      expect(result.value.revision).toBe(0);
      expect(result.value.etag).toBe(`"tw:${basics.jobId}:0"`);
      const rows = t.handle.db.select().from(tailoringWorkspaces).all();
      expect(rows).toEqual([]);
    });
  });

  it("round-trips a saved draft with its recommendation snapshot", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const saved = saveWorkspace(t.handle, basics.jobId, 0, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(v13Recommendations(basics)),
      });
      expect(saved.ok).toBe(true);
      const read = getWorkspaceView(t.handle, basics.jobId);
      expect(read.ok).toBe(true);
      if (!read.ok || !saved.ok) {
        throw new Error("unreachable");
      }
      expect(read.value.workspace).toMatchObject({
        jobId: basics.jobId,
        revision: 1,
        lastRequestId: null,
        lastSubmittedRevision: null,
        updatedAt: V13_T0,
      });
      expect(read.value.workspace?.draft.recommendationHash).toBe(recommendationHashFor(basics));
      expect(read.value.workspace?.recommendations?.extractionId).toBe(basics.extractionId);
      expect(resultEtag(read)).toBe(`"tw:${basics.jobId}:1"`);
    });
  });

  function resultEtag(result: { ok: true; value: { etag: string } }): string {
    return result.value.etag;
  }

  it("fails safe on corrupt stored focus, recommendations, and timestamps", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const saved = saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      });
      expect(saved.ok).toBe(true);
      // Corruption injection bumps the revision: the CAS trigger
      // rejects any workspace UPDATE that does not move revision+1.
      t.handle.db
        .update(tailoringWorkspaces)
        .set({
          revision: 2,
          focusJson: '{"schemaVersion":"tailoring-focus/v1"}',
        })
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .run();
      expect(getWorkspaceView(t.handle, basics.jobId)).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "storage-unavailable" }),
      });
      const recs = saveWorkspace(t.handle, basics.jobId, 2, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(v13Recommendations(basics)),
      });
      expect(recs.ok).toBe(true);
      t.handle.db
        .update(tailoringWorkspaces)
        .set({ revision: 4, recommendationsJson: '{"schemaVersion":"tailoring-recommendations/v1"}' })
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .run();
      expect(getWorkspaceView(t.handle, basics.jobId)).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "storage-unavailable" }),
      });
      t.handle.db
        .update(tailoringWorkspaces)
        .set({
          revision: 5,
          recommendationsJson: null,
          recommendationHash: null,
          focusJson: JSON.stringify(v13Focus()),
          updatedAt: "not-a-timestamp",
        })
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .run();
      expect(getWorkspaceView(t.handle, basics.jobId)).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "storage-unavailable" }),
      });
    });
  });
});

describe("B2 transaction W (service)", () => {
  it("creates revision 1 from observed 0 and updates through the CAS chain", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(null);
      const created = saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
        now: () => V13_T0,
        recommendations: provider,
      });
      expect(created).toMatchObject({ ok: true, value: { revision: 1, created: true } });
      const updated = saveWorkspace(
        t.handle,
        basics.jobId,
        1,
        emptyDraft({ focus: v13Focus({ additionalGuidance: "Lead with routing wins." }) }),
        { now: () => "2026-09-16T12:05:00.000Z", recommendations: provider },
      );
      expect(updated).toMatchObject({ ok: true, value: { revision: 2, created: false } });
      if (!updated.ok) {
        throw new Error("unreachable");
      }
      expect(updated.value.workspace?.draft.schemaVersion).toBe("tailoring-workspace/v1");
      if (updated.value.workspace?.draft.schemaVersion !== "tailoring-workspace/v1") {
        throw new Error("unreachable");
      }
      expect(updated.value.workspace.draft.focus.additionalGuidance).toBe(
        "Lead with routing wins.",
      );
      expect(provider.calls).toBe(0);
      const bound = saveWorkspace(t.handle, basics.jobId, 2, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(v13Recommendations(basics)),
      });
      expect(bound.ok).toBe(true);
      const counting = stubRecommendationsProvider(v13Recommendations(basics));
      const rebound = saveWorkspace(t.handle, basics.jobId, 3, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: counting,
      });
      expect(rebound.ok).toBe(true);
      expect(counting.calls).toBe(1);
    });
  });

  it("writes no job version, queue, or review state", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const jobBefore = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      const queueBefore = t.handle.db.select().from(workItems).all();
      const saved = saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      });
      expect(saved.ok).toBe(true);
      const jobAfter = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(jobAfter?.rowVersion).toBe(jobBefore?.rowVersion);
      expect(jobAfter?.tailoringState).toBe(jobBefore?.tailoringState);
      expect(t.handle.db.select().from(workItems).all()).toEqual(queueBefore);
    });
  });

  it("preserves the submission stamp across later saves", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(null);
      expect(
        saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
          now: () => V13_T0,
          recommendations: provider,
        }).ok,
      ).toBe(true);
      const run = seedV13RunningRun(t.handle, basics);
      const stamped = markWorkspaceSubmitted(t.handle, {
        jobId: basics.jobId,
        observedRevision: 1,
        requestId: run.requestId,
        now: V13_T0,
      });
      expect(stamped).toEqual({ ok: true, revision: 2 });
      const requestId = run.requestId;
      const saved = saveWorkspace(
        t.handle,
        basics.jobId,
        2,
        emptyDraft({ focus: v13Focus({ summaryDirection: "Ops-first." }) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) {
        throw new Error("unreachable");
      }
      expect(saved.value.revision).toBe(3);
      expect(saved.value.workspace?.lastRequestId).toBe(requestId);
      expect(saved.value.workspace?.lastSubmittedRevision).toBe(2);
      const conflict = markWorkspaceSubmitted(t.handle, {
        jobId: basics.jobId,
        observedRevision: 2,
        requestId: newId(),
        now: V13_T0,
      });
      expect(conflict).toEqual({ ok: false, error: "conflict", currentRevision: 3 });
    });
  });

  it("rejects stale revisions with the current revision and keeps the stored bytes", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(null);
      expect(
        saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
          now: () => V13_T0,
          recommendations: provider,
        }).ok,
      ).toBe(true);
      const stale = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        emptyDraft({ focus: v13Focus({ summaryDirection: "Stale write." }) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(stale).toEqual({
        ok: false,
        failure: expect.objectContaining({ error: "workspace-conflict", currentWorkspaceRevision: 1 }),
      });
      const read = getWorkspaceView(t.handle, basics.jobId);
      if (!read.ok || read.value.workspace === null) {
        throw new Error("unreachable");
      }
      expect(read.value.revision).toBe(1);
      expect(read.value.workspace.draft.schemaVersion).toBe("tailoring-workspace/v1");
      if (read.value.workspace.draft.schemaVersion !== "tailoring-workspace/v1") {
        throw new Error("unreachable");
      }
      expect(read.value.workspace.draft.focus.summaryDirection).toBe("");
    });
  });

  it("treats a nonzero observed revision on an absent workspace as a conflict at 0", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const result = saveWorkspace(t.handle, basics.jobId, 4, emptyDraft(), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      });
      expect(result).toEqual({
        ok: false,
        failure: expect.objectContaining({ error: "workspace-conflict", currentWorkspaceRevision: 0 }),
      });
    });
  });

  it("stores the bound recommendation snapshot when the client hash matches", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const saved = saveWorkspace(t.handle, basics.jobId, 0, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(v13Recommendations(basics)),
      });
      expect(saved.ok).toBe(true);
      const row = t.handle.db
        .select()
        .from(tailoringWorkspaces)
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .get();
      expect(row?.recommendationHash).toBe(recommendationHashFor(basics));
      expect(row?.recommendationsJson).toContain("tailoring-recommendations/v1");
    });
  });

  it("saves an empty focus with honest nulls when recommendations cannot build", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const draft = boundDraft(basics, { recommendationHash: null });
      const saved = saveWorkspace(t.handle, basics.jobId, 0, draft, {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) {
        throw new Error("unreachable");
      }
      expect(saved.value.workspace?.recommendations).toBeNull();
      expect(saved.value.workspace?.draft.recommendationHash).toBeNull();
    });
  });

  it("rejects mismatched hashes, selections without snapshots, and unknown phrases", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(v13Recommendations(basics));
      const mismatch = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, { recommendationHash: "f".repeat(64) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(mismatch).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "input-stale", field: "recommendationHash" }),
      });
      const noBinding = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        emptyDraft({ focus: v13Focus({ selectedPhraseIds: ["a".repeat(64)] }) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(noBinding).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "invalid-selection" }),
      });
      const unknown = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, { focus: v13Focus({ selectedPhraseIds: ["b".repeat(64)] }) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(unknown).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "invalid-selection" }),
      });
      expect(getWorkspaceView(t.handle, basics.jobId)).toMatchObject({
        ok: true,
        value: { revision: 0, workspace: null },
      });
    });
  });

  it("rejects gap selections and foreign mapping facts against the bound snapshot", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const recommendations = v13Recommendations(basics);
      const gapId = "c".repeat(64);
      recommendations.phrases.push({
        id: gapId,
        text: "NetSuite ERP administration",
        startByte: 20,
        endByte: 47,
        excerpt: "…",
        count: 1,
        category: "erp",
        support: "gap",
        factIds: [],
      });
      const provider = stubRecommendationsProvider(recommendations);
      const gapSave = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, {
          recommendationHash: hashRecommendation(recommendations),
          focus: v13Focus({ selectedPhraseIds: [gapId] }),
        }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(gapSave).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "invalid-selection" }),
      });
      const phraseId = recommendations.phrases[0]?.id ?? "";
      const foreignSave = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, {
          recommendationHash: hashRecommendation(recommendations),
          focus: v13Focus({
            mappings: [{ roleId: "role-pm", phraseId, factIds: ["fact-foreign"] }],
          }),
        }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(foreignSave).toMatchObject({
        ok: false,
        failure: expect.objectContaining({
          error: "invalid-selection",
          field: "mappings.0.factIds.0",
        }),
      });
    });
  });

  it("404s foreign or missing extractions, versions, and parents", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const other = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(v13Recommendations(basics));
      const foreignExtraction = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, { extractionId: other.extractionId }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(foreignExtraction).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "not-found", field: "extractionId" }),
      });
      const foreignVersion = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        boundDraft(basics, { profileVersionId: world.spmVersionId }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(foreignVersion).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "not-found", field: "profileVersionId" }),
      });
      const foreignParent = saveWorkspace(
        t.handle,
        other.jobId,
        0,
        emptyDraft({
          requestKind: "NEW_VERSION",
          parentVersionId: world.v1Id,
          extractionId: null,
          profileId: null,
          profileVersionId: null,
        }),
        { now: () => V13_T0, recommendations: stubRecommendationsProvider(null) },
      );
      expect(foreignParent).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "not-found", field: "parentVersionId" }),
      });
    });
  });

  it("409s owned-but-superseded bindings", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const provider = stubRecommendationsProvider(v13Recommendations(basics));
      const saved = saveWorkspace(t.handle, basics.jobId, 0, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: provider,
      });
      expect(saved.ok).toBe(true);
      const nextExtractionId = newId();
      const nextAttemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: nextAttemptId,
          jobId: basics.jobId,
          canonicalUrl: `https://example.com/jobs/${basics.jobId}/2`,
          startedAt: V13_T0,
          finishedAt: V13_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      t.handle.db
        .insert(jobExtractions)
        .values({
          id: nextExtractionId,
          jobId: basics.jobId,
          scrapeAttemptId: nextAttemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: nextExtractionId })
        .where(eq(jobs.id, basics.jobId))
        .run();
      const stale = saveWorkspace(
        t.handle,
        basics.jobId,
        1,
        boundDraft(basics, { focus: v13Focus({ summaryDirection: "Late edit." }) }),
        { now: () => V13_T0, recommendations: provider },
      );
      expect(stale).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "input-stale", field: "extractionId" }),
      });
      const v1row = getProfileVersion(t.handle, basics.profileVersionId);
      if (v1row === null) {
        throw new Error("pm v1 missing");
      }
      const v2id = newId();
      t.handle.db
        .insert(candidateProfileVersions)
        .values({
          id: v2id,
          profileId: basics.profileId,
          version: 2,
          payloadJson: v1row.payloadJson,
          payloadHash: v1row.payloadHash,
          schemaVersion: v1row.schemaVersion,
          createdAt: "2026-09-16T12:05:00.000Z",
        })
        .run();
      activateProfileVersion(t.handle, v2id, "2026-09-16T12:05:00.000Z");
      const staleVersion = saveWorkspace(
        t.handle,
        basics.jobId,
        1,
        boundDraft(basics, { extractionId: nextExtractionId, recommendationHash: null }),
        { now: () => V13_T0, recommendations: stubRecommendationsProvider(null) },
      );
      expect(staleVersion).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "input-stale", field: "profileVersionId" }),
      });
    });
  });

  it("maps provider storage failures to storage-unavailable", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const result = saveWorkspace(t.handle, basics.jobId, 0, boundDraft(basics), {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null, {
          error: "storage-unavailable",
          detail: "profile payload failed strict validation",
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "storage-unavailable" }),
      });
    });
  });

  it("saves NEW_VERSION drafts against owned parents", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      const saved = saveWorkspace(
        t.handle,
        basics.jobId,
        0,
        emptyDraft({ requestKind: "NEW_VERSION", parentVersionId: version.versionId }),
        { now: () => V13_T0, recommendations: stubRecommendationsProvider(null) },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) {
        throw new Error("unreachable");
      }
      expect(saved.value.workspace?.draft.parentVersionId).toBe(version.versionId);
    });
  });
});

describe("B2 versions history (service)", () => {
  it("404s unknown jobs and returns empty pages with a null cursor", () => {
    withV13Database((t, world) => {
      expect(listVersionSummaries(t.handle, newId())).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "unknown-job" }),
      });
      const basics = seedV13Basics(t.handle, world);
      expect(listVersionSummaries(t.handle, basics.jobId)).toEqual({
        ok: true,
        versions: [],
        nextCursor: null,
      });
    });
  });

  it("pages newest-first with frozen profile names and pointer flags", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const v1 = seedV13Version(t.handle, basics, run, { reviewState: "APPROVED" });
      // A second live run on the same job would violate the
      // one-live index, so finish the first run before seeding v2.
      // Renaming the live profile proves names come from the frozen
      // steering snapshot, not the current profile row.
      expect(
        completeWorkItem(
          t.handle,
          {
            workItemId: run.workItemId,
            leaseToken: run.leaseToken,
            result: "SUCCEEDED",
          },
          // WO-1.3-F: completion predicates on live expiry.
          { now: new Date(Date.parse(V13_T0) + 60_000).toISOString() },
        ).ok,
      ).toBe(true);
      t.handle.db
        .update(candidateProfiles)
        .set({ displayName: "Live Renamed" })
        .where(eq(candidateProfiles.id, basics.profileId))
        .run();
      const v2run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, v2run);
      const v2 = seedV13Version(t.handle, basics, v2run, {
        version: 2,
        createdAt: "2026-09-16T12:10:00.000Z",
      });
      t.handle.db
        .update(jobs)
        .set({ activeResumeVersionId: v2.versionId, selectedResumeVersionId: v1.versionId })
        .where(eq(jobs.id, basics.jobId))
        .run();
      const first = listVersionSummaries(t.handle, basics.jobId, { limit: 1 });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error("unreachable");
      }
      expect(first.versions).toHaveLength(1);
      expect(first.versions[0]).toMatchObject({
        id: v2.versionId,
        version: 2,
        profileDisplayName: "PM Profile",
        reviewState: "AWAITING_REVIEW",
        selectedApproved: false,
        latestPublished: true,
      });
      expect(first.nextCursor).not.toBeNull();
      const second = listVersionSummaries(t.handle, basics.jobId, {
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) {
        throw new Error("unreachable");
      }
      expect(second.versions).toMatchObject([
        {
          id: v1.versionId,
          version: 1,
          profileDisplayName: "PM Profile",
          selectedApproved: true,
          latestPublished: false,
        },
      ]);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("falls back to live lineage names when frozen steering has no display name", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics, {
        steeringSnapshotJson: JSON.stringify({ schemaVersion: "generation-steering/v1" }),
      });
      seedV13RequestInputs(t.handle, basics, run);
      seedV13Version(t.handle, basics, run);
      const page = listVersionSummaries(t.handle, basics.jobId);
      expect(page.ok).toBe(true);
      if (!page.ok) {
        throw new Error("unreachable");
      }
      expect(page.versions[0]?.profileDisplayName).toBe("Product Manager");
    });
  });

  it("fails safe on corrupt version timestamps and rejects bad paging", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      seedV13Version(t.handle, basics, run, { createdAt: "not-a-timestamp" });
      expect(listVersionSummaries(t.handle, basics.jobId)).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "storage-unavailable" }),
      });
      for (const limit of [0, 51, Number.NaN, 1.5]) {
        expect(listVersionSummaries(t.handle, basics.jobId, { limit })).toMatchObject({
          ok: false,
          failure: expect.objectContaining({ error: "invalid-request", field: "limit" }),
        });
      }
      expect(listVersionSummaries(t.handle, basics.jobId, { cursor: "!!!" })).toMatchObject({
        ok: false,
        failure: expect.objectContaining({ error: "invalid-request", field: "cursor" }),
      });
    });
  });
});

describe("B6 read budgets and leak surface (service)", () => {
  it("reads the workspace in exactly 2 statements beside 1000 history rows", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      expect(
        saveWorkspace(t.handle, basics.jobId, 0, emptyDraft(), {
          now: () => V13_T0,
          recommendations: stubRecommendationsProvider(null),
        }).ok,
      ).toBe(true);
      seedHistoryRows(t);
      const queries = countQueries(t.handle, () => {
        const read = getWorkspaceView(t.handle, basics.jobId);
        expect(read.ok).toBe(true);
      });
      expect(queries).toBe(2);
    });
  });

  function seedHistoryRows(t: TestDatabase): void {
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
          focusJson: JSON.stringify(v13Focus()),
          createdAt: V13_T0,
          updatedAt: V13_T0,
        })
        .run();
    }
  }

  it("pages versions in at most 4 statements over 60 versions", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const template = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, template);
      seedV13Version(t.handle, basics, template, { createdAt: "2026-09-16T12:01:00.000Z" });
      finishRun(template.workItemId, template.leaseToken);
      for (let n = 2; n <= 60; n += 1) {
        const run = seedV13RunningRun(t.handle, basics);
        seedV13RequestInputs(t.handle, basics, run);
        finishRun(run.workItemId, run.leaseToken);
        seedV13Version(t.handle, basics, run, {
          version: n,
          createdAt: new Date(Date.parse(V13_T0) + n * 60_000).toISOString(),
        });
      }

      function finishRun(workItemId: string, leaseToken: string): void {
        const finished = completeWorkItem(
          t.handle,
          {
            workItemId,
            leaseToken,
            result: "SUCCEEDED",
          },
          // WO-1.3-F: completion predicates on live expiry.
          { now: new Date(Date.parse(V13_T0) + 60_000).toISOString() },
        );
        if (!finished.ok) {
          throw new Error(`finish failed: ${finished.error}`);
        }
      }
      const queries = countQueries(t.handle, () => {
        const page = listVersionSummaries(t.handle, basics.jobId, { limit: 50 });
        expect(page.ok).toBe(true);
        if (!page.ok) {
          throw new Error("unreachable");
        }
        expect(page.versions).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
      });
      expect(queries).toBeLessThanOrEqual(4);
    });
  });

  it("exposes no tokens, payloads, or paths in workspace and version reads", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      seedV13Version(t.handle, basics, run);
      expect(
        saveWorkspace(t.handle, basics.jobId, 0, boundDraft(basics), {
          now: () => V13_T0,
          recommendations: stubRecommendationsProvider(v13Recommendations(basics)),
        }).ok,
      ).toBe(true);
      const read = getWorkspaceView(t.handle, basics.jobId);
      expect(read.ok).toBe(true);
      const serialized = JSON.stringify(read);
      for (const leaked of ["lease", "payload", "steering", "Path", "path", "token", "secret"]) {
        expect(serialized.toLowerCase().includes(leaked.toLowerCase()), leaked).toBe(false);
      }
      const page = listVersionSummaries(t.handle, basics.jobId);
      expect(page.ok).toBe(true);
      const pageSerialized = JSON.stringify(page);
      for (const leaked of ["contentJson", "contentHash", "artifact", "lease", "steering"]) {
        expect(pageSerialized.includes(leaked), leaked).toBe(false);
      }
    });
  });
});
