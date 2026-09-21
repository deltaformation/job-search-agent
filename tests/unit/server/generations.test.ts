// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  generationRequests,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  tailoringRequestInputs,
  tailoringWorkspaces,
  workAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { canonicalJson } from "../../../src/domain/canonical";
import {
  type FocusV1 as FocusV1Type,
  type RecommendationV1 as RecommendationV1Type,
} from "../../../src/domain/tailoringWorkspace";
import { getProfileVersion } from "../../../src/db/candidates";
import { activateProfileVersion, importCandidate } from "../../../src/server/candidates";
import { submitGeneration } from "../../../src/server/generations";
import {
  getRecommendations,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { resumeIdentityHash } from "../../../src/server/resumeDigests";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import {
  canonicalKeywordSet,
  generationRequestIdentity,
} from "../../../src/tailoring/requests";
import {
  TailorQueuePayloadV3,
  hashGenerationRequestV3,
  hashRecommendation,
  hashSubmission,
  hashWorkflowRequestInput,
} from "../../../src/tailoring/requestsV3";
import {
  seedV13Basics,
  v13ExtractionJson,
  withV13Database,
  V13_T0,
  type V13Basics,
} from "../db/v13world";
import type { CrossProfileWorld } from "../acceptance-v1.2/world";

/**
 * E6–E9 service leg: atomic generation/revision submission. G
 * freezes the exact stored focus into immutable request inputs,
 * dispatches one v3 queue payload, CASes the job, and stamps the
 * workspace — or writes nothing. Replays reconcile byte-equal;
 * mismatches, races, staleness, and unreadiness fail closed.
 */

const JD = "TypeScript APIs with Redis caching and go-to-market launches. Jira boards.";
const KEYED_ENV = { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" };

interface SubmittedWorld {
  basics: V13Basics;
  recommendations: RecommendationV1Type;
  recommendationHash: string;
  focus: FocusV1Type;
  requestId: string;
}

function seedDraftWorld(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  overrides: {
    focus?: (preset: FocusV1Type) => FocusV1Type;
    requestKind?: "INITIAL" | "NEW_VERSION" | "REVISION";
    parentVersionId?: string | null;
    revisionNote?: string | null;
    jdText?: string;
    envelopeText?: string;
  } = {},
): SubmittedWorld {
  const jdText = overrides.jdText ?? JD;
  const basics = seedV13Basics(handle, world, {
    jdText,
    extractedJson: v13ExtractionJson(overrides.envelopeText ?? jdText),
  });
  const recs = getRecommendations(handle, {
    jobId: basics.jobId,
    extractionId: basics.extractionId,
    profileVersionId: basics.profileVersionId,
  });
  expect(recs.ok).toBe(true);
  if (!recs.ok) throw new Error("recommendations seed failed");
  const recommendationHash = hashRecommendation(recs.recommendations);
  const focus = (overrides.focus ?? ((preset) => preset))(recs.recommendations.preset);
  const saved = saveWorkspace(
    handle,
    basics.jobId,
    0,
    {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: basics.extractionId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      requestKind: overrides.requestKind ?? "INITIAL",
      parentVersionId: overrides.parentVersionId ?? null,
      revisionNote: overrides.revisionNote ?? null,
      recommendationHash,
      focus,
    },
    { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
  );
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(`workspace seed failed: ${saved.failure.error}`);
  return { basics, recommendations: recs.recommendations, recommendationHash, focus, requestId: newId() };
}

function submit(handle: DatabaseHandle, world: SubmittedWorld, extra: Record<string, unknown> = {}) {
  return submitGeneration(
    handle,
    {
      jobId: world.basics.jobId,
      requestId: world.requestId,
      workspaceRevision: 1,
      observedRowVersion: 1,
      actor: "human",
      now: V13_T0,
      ...extra,
    },
    { env: KEYED_ENV },
  );
}

/** Q1 probe (acceptance §1): all generation effects for one job. */
function q1(handle: DatabaseHandle, jobId: string): Record<string, number> {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
        (SELECT COUNT(*) FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?) AS reviews`,
    )
    .get(jobId, jobId, jobId, jobId) as Record<string, number>;
}

function snapshots(handle: DatabaseHandle): Record<string, number> {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM jd_snapshots) AS jd,
        (SELECT COUNT(*) FROM candidate_snapshots) AS candidate`,
    )
    .get() as Record<string, number>;
}

function workspaceRow(handle: DatabaseHandle, jobId: string) {
  return handle.db.select().from(tailoringWorkspaces).where(eq(tailoringWorkspaces.jobId, jobId)).get();
}

function jobRow(handle: DatabaseHandle, jobId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

describe("submitGeneration (G)", () => {
  describe("E6: one atomic dispatch", () => {
    it("202s a new run with exact request, queue, inputs, CAS, and stamp rows", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world, {
          focus: (preset) => ({ ...preset, additionalGuidance: "Emphasize scale." }),
        });
        const before = { q1: q1(t.handle, seeded.basics.jobId), snapshots: snapshots(t.handle) };
        expect(before.q1).toEqual({ requests: 0, work: 0, versions: 0, reviews: 0 });

        const result = submit(t.handle, seeded);
        expect(result).toMatchObject({
          ok: true,
          requestId: seeded.requestId,
          status: "QUEUED",
          replayed: false,
          jobRowVersion: 2,
          workspaceRevision: 2,
        });
        if (!result.ok) return;

        // Request row: v3 hash, verified projections, frozen steering.
        const request = handleRow(t.handle, seeded.requestId);
        expect(request).toMatchObject({
          requestIdentity: generationRequestIdentity(seeded.requestId),
          requestKind: "INITIAL",
          status: "QUEUED",
          workItemId: result.workItemId,
          directivesText: "Emphasize scale.",
          revisionNote: null,
        });
        const keywords = JSON.parse(String(request?.selectedKeywordsJson)) as string[];
        const phraseText = new Map(
          seeded.recommendations.phrases.map((phrase) => [phrase.id, phrase.text]),
        );
        expect(keywords).toEqual(
          canonicalKeywordSet(seeded.focus.selectedPhraseIds.map((id) => phraseText.get(id) as string)),
        );
        // Queue row: strict v3 payload with the frozen input hash.
        const item = t.handle.db
          .select()
          .from(workItems)
          .where(eq(workItems.id, result.workItemId))
          .get();
        expect(item).toMatchObject({
          kind: "TAILOR",
          state: "QUEUED",
          idempotencyKey: generationRequestIdentity(seeded.requestId),
        });
        const payload = TailorQueuePayloadV3.parse(JSON.parse(String(item?.payloadJson)));
        expect(payload.generationRequestId).toBe(seeded.requestId);
        // Inputs row: submit/input hashes recompute byte-equal (Q2/Q3).
        const inputs = t.handle.db
          .select()
          .from(tailoringRequestInputs)
          .where(eq(tailoringRequestInputs.requestId, seeded.requestId))
          .get();
        expect(inputs).toMatchObject({ workspaceRevision: 1 });
        expect(inputs?.submitHash).toBe(
          hashSubmission({
            jobId: seeded.basics.jobId,
            requestId: seeded.requestId,
            workspaceRevision: 1,
            observedRowVersion: 1,
          }),
        );
        expect(inputs?.focusJson).toBe(canonicalJson(seeded.focus));
        expect(inputs?.recommendationsJson).toBe(canonicalJson(seeded.recommendations));
        expect(inputs?.inputHash).toBe(payload.inputHash);
        expect(inputs?.inputHash).toBe(
          hashWorkflowRequestInput({
            workspaceRevision: 1,
            focus: seeded.focus,
            recommendations: seeded.recommendations,
            candidateSnapshotId: String(inputs?.candidateSnapshotId),
            masterText: String(inputs?.masterText),
            masterTextHash: String(inputs?.masterTextHash),
            projectionVersion: "master-text/1",
          }),
        );
        expect(request?.payloadHash).toBe(
          hashGenerationRequestV3(
            {
              requestIdentity: generationRequestIdentity(seeded.requestId),
              jobId: seeded.basics.jobId,
              extractionId: seeded.basics.extractionId,
              profileId: seeded.basics.profileId,
              profileVersionId: seeded.basics.profileVersionId,
              jdSnapshotId: String(request?.jdSnapshotId),
              parentVersionId: null,
              requestKind: "INITIAL",
              steeringSnapshot: JSON.parse(String(request?.steeringSnapshotJson)) as never,
              selectedKeywords: keywords,
              directivesText: "Emphasize scale.",
              revisionNote: null,
            },
            String(inputs?.inputHash),
          ),
        );
        // CAS + stamp: job PENDING at v2, workspace at rev 2 bound
        // to this request; Q1 shows exactly one request + queue row.
        expect(jobRow(t.handle, seeded.basics.jobId)).toMatchObject({
          rowVersion: 2,
          tailoringState: "PENDING",
        });
        expect(workspaceRow(t.handle, seeded.basics.jobId)).toMatchObject({
          revision: 2,
          lastRequestId: seeded.requestId,
          lastSubmittedRevision: 2,
        });
        expect(q1(t.handle, seeded.basics.jobId)).toEqual({
          requests: 1,
          work: 1,
          versions: 0,
          reviews: 0,
        });
        // Idempotent snapshots: the seed already froze this exact
        // JD text and profile version, so G reuses both rows.
        expect(snapshots(t.handle)).toEqual(before.snapshots);
      });
    });

    it("creates snapshots only for unfrozen inputs", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world, {
          envelopeText: "Fresh novel JD text about underwater basket weaving.",
        });
        const before = snapshots(t.handle);
        const result = submit(t.handle, seeded);
        expect(result).toMatchObject({ ok: true, replayed: false });
        const after = snapshots(t.handle);
        // The envelope text was never frozen, so G freezes exactly
        // one new JD snapshot; the profile version was already
        // snapshotted at import, so it reuses.
        expect(after.jd).toBe(before.jd + 1);
        expect(after.candidate).toBe(before.candidate);
      });
    });

    it("stores empty guidance as NULL directives, never an empty-string claim", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world);
        const result = submit(t.handle, seeded);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(handleRow(t.handle, seeded.requestId)).toMatchObject({ directivesText: null });
      });
    });
  });

  describe("E7: rejections write nothing", () => {
    it("409s wrong workspace and job revisions with current counters", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world);
        const before = { q1: q1(t.handle, seeded.basics.jobId), snapshots: snapshots(t.handle) };
        const staleDraft = submit(t.handle, seeded, { workspaceRevision: 99 });
        expect(staleDraft).toMatchObject({
          ok: false,
          failure: { error: "workspace-conflict", currentWorkspaceRevision: 1 },
        });
        const staleJob = submit(t.handle, seeded, { observedRowVersion: 99 });
        expect(staleJob).toMatchObject({
          ok: false,
          failure: { error: "job-conflict", currentRowVersion: 1 },
        });
        expect(q1(t.handle, seeded.basics.jobId)).toEqual(before.q1);
        expect(snapshots(t.handle)).toEqual(before.snapshots);
        expect(workspaceRow(t.handle, seeded.basics.jobId)?.revision).toBe(1);
      });
    });

    it("409s rejected jobs and live runs without side effects", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world);
        t.handle.db
          .update(jobs)
          .set({ status: "REJECTED" })
          .where(eq(jobs.id, seeded.basics.jobId))
          .run();
        const before = { q1: q1(t.handle, seeded.basics.jobId), snapshots: snapshots(t.handle) };
        expect(submit(t.handle, seeded)).toMatchObject({
          ok: false,
          failure: { error: "job-conflict" },
        });
        t.handle.db
          .update(jobs)
          .set({ status: "NEW" })
          .where(eq(jobs.id, seeded.basics.jobId))
          .run();
        expect(submit(t.handle, seeded)).toMatchObject({ ok: true, replayed: false });
        const busy = submit(t.handle, { ...seeded, requestId: newId() }, {
          workspaceRevision: 2,
          observedRowVersion: 2,
        });
        expect(busy).toMatchObject({ ok: false, failure: { error: "generation-busy" } });
        expect(q1(t.handle, seeded.basics.jobId)).toEqual({
          requests: 1,
          work: 1,
          versions: 0,
          reviews: 0,
        });
        expect(snapshots(t.handle)).toEqual(before.snapshots);
      });
    });

    it("409s drifted bindings and 422s unreadiness, all without writes", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world);
        const before = { q1: q1(t.handle, seeded.basics.jobId), snapshots: snapshots(t.handle) };
        // A second extraction steals the active pointer after the save.
        const attemptId = newId();
        t.handle.db
          .insert(scrapeAttempts)
          .values({
            id: attemptId,
            jobId: seeded.basics.jobId,
            canonicalUrl: "https://example.com/jobs/second",
            startedAt: V13_T0,
            finishedAt: V13_T0,
            outcome: "SUCCEEDED",
          })
          .run();
        const secondId = newId();
        t.handle.db
          .insert(jobExtractions)
          .values({
            id: secondId,
            jobId: seeded.basics.jobId,
            scrapeAttemptId: attemptId,
            version: 2,
            schemaVersion: "job-extraction-v1",
            adapter: "generic",
            extractedJson: v13ExtractionJson("Kubernetes operators and Helm charts."),
          })
          .run();
        t.handle.db
          .update(jobs)
          .set({ activeExtractionId: secondId })
          .where(eq(jobs.id, seeded.basics.jobId))
          .run();
        expect(submit(t.handle, seeded)).toMatchObject({
          ok: false,
          failure: { error: "input-stale" },
        });
        // Missing provider key blocks only Generate.
        const noKey = submitGeneration(
          t.handle,
          {
            jobId: seeded.basics.jobId,
            requestId: newId(),
            workspaceRevision: 1,
            observedRowVersion: 1,
            actor: "human",
            now: V13_T0,
          },
          { env: {} },
        );
        // Binding still drifted: staleness precedes readiness.
        expect(noKey).toMatchObject({ ok: false, failure: { error: "input-stale" } });
        // Restore the binding: now the missing key surfaces.
        t.handle.db
          .update(jobs)
          .set({ activeExtractionId: seeded.basics.extractionId })
          .where(eq(jobs.id, seeded.basics.jobId))
          .run();
        const keyless = submitGeneration(
          t.handle,
          {
            jobId: seeded.basics.jobId,
            requestId: newId(),
            workspaceRevision: 1,
            observedRowVersion: 1,
            actor: "human",
            now: V13_T0,
          },
          { env: {} },
        );
        expect(keyless).toMatchObject({ ok: false, failure: { error: "provider-not-ready" } });
        expect(q1(t.handle, seeded.basics.jobId)).toEqual(before.q1);
        expect(snapshots(t.handle)).toEqual(before.snapshots);
        expect(jobRow(t.handle, seeded.basics.jobId)?.rowVersion).toBe(1);
        expect(workspaceRow(t.handle, seeded.basics.jobId)?.revision).toBe(1);
      });
    });

    it("422s profiles without approved facts", () => {
      withV13Database((t, world) => {
        // Zero-fact version: recommendations build (all gaps) and W
        // saves, but Generate refuses without evidence. The import
        // lands as pm-v2 and retires pm-v1, so this half runs in its
        // own database.
        const imported = importCandidate(t.handle, {
          document: {
            schemaVersion: "candidate-import/v1",
            identity: { fullName: "No Facts" },
            employment: [],
            achievements: [],
          },
          actor: "human",
        });
        expect(imported.ok).toBe(true);
        if (!imported.ok) return;
        expect(
          activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" }).ok,
        ).toBe(true);
        const importedProfileId = getProfileVersion(t.handle, imported.versionId)?.profileId;
        expect(importedProfileId).toBeTruthy();
        const basics = seedV13Basics(t.handle, world, {
          jdText: JD,
          extractedJson: v13ExtractionJson(JD),
        });
        const gapless = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: imported.versionId,
        });
        expect(gapless.ok).toBe(true);
        if (!gapless.ok) return;
        const emptyFocus: FocusV1Type = {
          schemaVersion: "tailoring-focus/v1",
          selectedPhraseIds: [],
          themeId: null,
          summaryDirection: "",
          mappings: [],
          additionalGuidance: "",
        };
        const savedEmpty = saveWorkspace(
          t.handle,
          basics.jobId,
          0,
          {
            schemaVersion: "tailoring-workspace/v1",
            extractionId: basics.extractionId,
            profileId: importedProfileId as string,
            profileVersionId: imported.versionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            recommendationHash: hashRecommendation(gapless.recommendations),
            focus: emptyFocus,
          },
          { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
        );
        expect(savedEmpty.ok).toBe(true);
        const before = { q1: q1(t.handle, basics.jobId), snapshots: snapshots(t.handle) };
        const noEvidence = submitGeneration(
          t.handle,
          {
            jobId: basics.jobId,
            requestId: newId(),
            workspaceRevision: 1,
            observedRowVersion: 1,
            actor: "human",
            now: V13_T0,
          },
          { env: KEYED_ENV },
        );
        expect(noEvidence).toMatchObject({ ok: false, failure: { error: "profile-not-ready" } });
        expect(q1(t.handle, basics.jobId)).toEqual(before.q1);
        expect(snapshots(t.handle)).toEqual(before.snapshots);
      });
    });

    it("fails unbound JD-less drafts stale", () => {
      withV13Database((t, world) => {
        // JD-less binding: W saves the empty unbound draft, but
        // Generate refuses without a bound snapshot.
        const emptyFocus: FocusV1Type = {
          schemaVersion: "tailoring-focus/v1",
          selectedPhraseIds: [],
          themeId: null,
          summaryDirection: "",
          mappings: [],
          additionalGuidance: "",
        };
        const jdless = seedV13Basics(t.handle, world, {
          jdText: "placeholder",
          extractedJson: v13ExtractionJson(null),
        });
        const savedUnbuilt = saveWorkspace(
          t.handle,
          jdless.jobId,
          0,
          {
            schemaVersion: "tailoring-workspace/v1",
            extractionId: jdless.extractionId,
            profileId: jdless.profileId,
            profileVersionId: jdless.profileVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            recommendationHash: null,
            focus: emptyFocus,
          },
          { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
        );
        expect(savedUnbuilt.ok).toBe(true);
        const noJd = submitGeneration(
          t.handle,
          {
            jobId: jdless.jobId,
            requestId: newId(),
            workspaceRevision: 1,
            observedRowVersion: 1,
            actor: "human",
            now: V13_T0,
          },
          { env: KEYED_ENV },
        );
        // Unbound drafts cannot submit at all — no fallback, no guess.
        expect(noJd).toMatchObject({ ok: false, failure: { error: "input-stale" } });
        expect(q1(t.handle, jdless.jobId)).toEqual({
          requests: 0,
          work: 0,
          versions: 0,
          reviews: 0,
        });
      });
    });

    it("rolls back every write when a failure lands after the queue INSERT", () => {
      withV13Database((t, world) => {
        const seeded = seedDraftWorld(t.handle, world);
        const before = {
          q1: q1(t.handle, seeded.basics.jobId),
          snapshots: snapshots(t.handle),
          job: jobRow(t.handle, seeded.basics.jobId),
          workspace: workspaceRow(t.handle, seeded.basics.jobId),
        };
        expect(() =>
          submitGeneration(
            t.handle,
            {
              jobId: seeded.basics.jobId,
              requestId: seeded.requestId,
              workspaceRevision: 1,
              observedRowVersion: 1,
              actor: "human",
              now: V13_T0,
            },
            {
              env: KEYED_ENV,
              testHooks: {
                afterQueueInsert: () => {
                  throw new Error("injected E7 mid-submit failure");
                },
              },
            },
          ),
        ).toThrow("injected E7 mid-submit failure");
        expect(q1(t.handle, seeded.basics.jobId)).toEqual(before.q1);
        expect(snapshots(t.handle)).toEqual(before.snapshots);
        expect(jobRow(t.handle, seeded.basics.jobId)).toEqual(before.job);
        expect(workspaceRow(t.handle, seeded.basics.jobId)).toEqual(before.workspace);
        expect(
          t.handle.db
            .select()
            .from(generationRequests)
            .where(eq(generationRequests.id, seeded.requestId))
            .get(),
        ).toBeUndefined();
      });
    });
  });
});

describe("submitGeneration REVISION/NEW_VERSION (E8)", () => {
  /** Publish an awaiting v1 for a G-submitted request, then rest the job. */
  function publishAwaitingV1(
    handle: DatabaseHandle,
    basics: V13Basics,
    requestId: string,
    workItemId: string,
  ): string {
    const request = handleRow(handle, requestId) as { jdSnapshotId: string };
    const inputs = handle.db
      .select()
      .from(tailoringRequestInputs)
      .where(eq(tailoringRequestInputs.requestId, requestId))
      .get() as { candidateSnapshotId: string };
    const attemptId = newId();
    handle.db
      .insert(workAttempts)
      .values({
        id: attemptId,
        workItemId,
        attemptNumber: 1,
        workerId: "test-worker",
        startedAt: V13_T0,
        finishedAt: V13_T0,
        result: "SUCCEEDED",
      })
      .run();
    const analysisId = newId();
    handle.db
      .insert(jobAnalyses)
      .values({
        id: analysisId,
        jobId: basics.jobId,
        jdSnapshotId: request.jdSnapshotId,
        candidateSnapshotId: inputs.candidateSnapshotId,
        workAttemptId: attemptId,
        generationRequestId: requestId,
        requirementsJson: "[]",
        gapsJson: "[]",
        promptVersion: "tailor-prompt/v2",
        proposalSchemaVersion: "resume-proposal/v1",
      })
      .run();
    const versionId = newId();
    handle.db
      .insert(resumeVersions)
      .values({
        id: versionId,
        jobId: basics.jobId,
        version: 1,
        parentVersionId: null,
        analysisId,
        generationRequestId: requestId,
        workAttemptId: attemptId,
        templateId: "classic",
        templateVersion: "1",
        templateHash: "3".repeat(64),
        rankerVersion: "ranker/1",
        policyVersion: "policy/1",
        configVersion: "config/1",
        renderSchemaVersion: "render/1",
        contentJson: "{}",
        contentHash: "4".repeat(64),
        reviewState: "AWAITING_REVIEW",
      })
      .run();
    handle.db
      .update(generationRequests)
      .set({ status: "SUCCEEDED", finishedAt: V13_T0 })
      .where(eq(generationRequests.id, requestId))
      .run();
    handle.db
      .update(workItems)
      .set({ state: "SUCCEEDED" })
      .where(eq(workItems.id, workItemId))
      .run();
    handle.db
      .update(jobs)
      .set({ tailoringState: "AWAITING_REVIEW" })
      .where(eq(jobs.id, basics.jobId))
      .run();
    return versionId;
  }

  function versionRow(handle: DatabaseHandle, versionId: string) {
    return handle.db.select().from(resumeVersions).where(eq(resumeVersions.id, versionId)).get();
  }

  function reviewsFor(handle: DatabaseHandle, versionId: string) {
    return handle.db
      .select()
      .from(resumeReviews)
      .where(eq(resumeReviews.resumeVersionId, versionId))
      .all();
  }

  it("atomically appends one parent review and one child REVISION request", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const parentId = publishAwaitingV1(t.handle, seeded.basics, seeded.requestId, first.workItemId);
      const parentBefore = versionRow(t.handle, parentId);
      if (parentBefore === undefined) throw new Error("parent version missing after publish");
      const expectedHash = resumeIdentityHash({
        id: parentBefore.id,
        jobId: parentBefore.jobId,
        version: parentBefore.version,
        parentVersionId: null,
        analysisId: parentBefore.analysisId,
        templateId: parentBefore.templateId,
        templateVersion: parentBefore.templateVersion,
        templateHash: parentBefore.templateHash,
        rankerVersion: parentBefore.rankerVersion,
        policyVersion: parentBefore.policyVersion,
        configVersion: parentBefore.configVersion,
        renderSchemaVersion: parentBefore.renderSchemaVersion,
        contentHash: parentBefore.contentHash,
      });
      // REVISION draft at workspace rev 2 with a 4000-char note.
      const note = `Revise toward staff scope. ${"x".repeat(3970)}`;
      expect(note.length).toBeLessThanOrEqual(4000);
      const saved = saveWorkspace(
        t.handle,
        seeded.basics.jobId,
        2,
        {
          schemaVersion: "tailoring-workspace/v1",
          extractionId: seeded.basics.extractionId,
          profileId: seeded.basics.profileId,
          profileVersionId: seeded.basics.profileVersionId,
          requestKind: "REVISION",
          parentVersionId: parentId,
          revisionNote: note,
          recommendationHash: seeded.recommendationHash,
          focus: seeded.focus,
        },
        { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const childId = newId();
      const revised = submitGeneration(
        t.handle,
        {
          jobId: seeded.basics.jobId,
          requestId: childId,
          workspaceRevision: 3,
          observedRowVersion: 2,
          actor: "human",
          now: V13_T0,
        },
        { env: KEYED_ENV },
      );
      expect(revised).toMatchObject({ ok: true, requestId: childId, replayed: false });
      expect(handleRow(t.handle, childId)).toMatchObject({
        requestKind: "REVISION",
        parentVersionId: parentId,
        revisionNote: note,
      });
      expect(versionRow(t.handle, parentId)?.reviewState).toBe("REVISION_REQUESTED");
      const reviews = reviewsFor(t.handle, parentId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        action: "REVISION_REQUESTED",
        actor: "human",
        note,
        resumeHash: expectedHash,
        contentHash: "4".repeat(64),
      });
      expect(jobRow(t.handle, seeded.basics.jobId)).toMatchObject({
        rowVersion: 3,
        tailoringState: "PENDING",
      });
      // A failed follow-up submit appends nothing: atomicity holds
      // in both directions. (The parent stopped awaiting, so the
      // same REVISION draft now fails stale before liveness.)
      const retry = submitGeneration(
        t.handle,
        {
          jobId: seeded.basics.jobId,
          requestId: newId(),
          workspaceRevision: 4,
          observedRowVersion: 3,
          actor: "human",
          now: V13_T0,
        },
        { env: KEYED_ENV },
      );
      expect(retry).toMatchObject({ ok: false, failure: { error: "input-stale" } });
      expect(reviewsFor(t.handle, parentId)).toHaveLength(1);
    });
  });

  it("submits NEW_VERSION from decided parents without touching prior approval", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const parentId = publishAwaitingV1(t.handle, seeded.basics, seeded.requestId, first.workItemId);
      t.handle.db
        .update(resumeVersions)
        .set({ reviewState: "APPROVED" })
        .where(eq(resumeVersions.id, parentId))
        .run();
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "APPROVED" })
        .where(eq(jobs.id, seeded.basics.jobId))
        .run();
      const saved = saveWorkspace(
        t.handle,
        seeded.basics.jobId,
        2,
        {
          schemaVersion: "tailoring-workspace/v1",
          extractionId: seeded.basics.extractionId,
          profileId: seeded.basics.profileId,
          profileVersionId: seeded.basics.profileVersionId,
          requestKind: "NEW_VERSION",
          parentVersionId: parentId,
          revisionNote: null,
          recommendationHash: seeded.recommendationHash,
          focus: seeded.focus,
        },
        { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const childId = newId();
      const second = submitGeneration(
        t.handle,
        {
          jobId: seeded.basics.jobId,
          requestId: childId,
          workspaceRevision: 3,
          observedRowVersion: 2,
          actor: "human",
          now: V13_T0,
        },
        { env: KEYED_ENV },
      );
      expect(second).toMatchObject({ ok: true, requestId: childId });
      expect(handleRow(t.handle, childId)).toMatchObject({
        requestKind: "NEW_VERSION",
        parentVersionId: parentId,
      });
      expect(versionRow(t.handle, parentId)?.reviewState).toBe("APPROVED");
      expect(reviewsFor(t.handle, parentId)).toHaveLength(0);
    });
  });

  it("rejects REVISION drafts whose parent stopped awaiting review", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const parentId = publishAwaitingV1(t.handle, seeded.basics, seeded.requestId, first.workItemId);
      const saved = saveWorkspace(
        t.handle,
        seeded.basics.jobId,
        2,
        {
          schemaVersion: "tailoring-workspace/v1",
          extractionId: seeded.basics.extractionId,
          profileId: seeded.basics.profileId,
          profileVersionId: seeded.basics.profileVersionId,
          requestKind: "REVISION",
          parentVersionId: parentId,
          revisionNote: "Please revise.",
          recommendationHash: seeded.recommendationHash,
          focus: seeded.focus,
        },
        { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      // The parent gets approved elsewhere before Generate runs.
      t.handle.db
        .update(resumeVersions)
        .set({ reviewState: "APPROVED" })
        .where(eq(resumeVersions.id, parentId))
        .run();
      const before = q1(t.handle, seeded.basics.jobId);
      const stale = submitGeneration(
        t.handle,
        {
          jobId: seeded.basics.jobId,
          requestId: newId(),
          workspaceRevision: 3,
          observedRowVersion: 2,
          actor: "human",
          now: V13_T0,
        },
        { env: KEYED_ENV },
      );
      expect(stale).toMatchObject({ ok: false, failure: { error: "input-stale" } });
      expect(q1(t.handle, seeded.basics.jobId)).toEqual(before);
      expect(reviewsFor(t.handle, parentId)).toHaveLength(0);
    });
  });
});

describe("submitGeneration replay (E9)", () => {
  it("replays identical bodies with zero writes and 409s changed bytes", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first).toMatchObject({ ok: true, replayed: false });
      if (!first.ok) return;
      const before = {
        q1: q1(t.handle, seeded.basics.jobId),
        snapshots: snapshots(t.handle),
        workspace: workspaceRow(t.handle, seeded.basics.jobId),
        job: jobRow(t.handle, seeded.basics.jobId),
      };
      const replay = submit(t.handle, seeded);
      expect(replay).toMatchObject({
        ok: true,
        requestId: seeded.requestId,
        workItemId: first.workItemId,
        status: "QUEUED",
        replayed: true,
        jobRowVersion: 2,
        workspaceRevision: 2,
      });
      expect(q1(t.handle, seeded.basics.jobId)).toEqual(before.q1);
      expect(snapshots(t.handle)).toEqual(before.snapshots);
      expect(workspaceRow(t.handle, seeded.basics.jobId)).toEqual(before.workspace);
      expect(jobRow(t.handle, seeded.basics.jobId)).toEqual(before.job);
      // Same operation ID, different body: fail closed.
      const mismatch = submit(t.handle, seeded, { observedRowVersion: 99 });
      expect(mismatch).toMatchObject({ ok: false, failure: { error: "idempotency-mismatch" } });
      const restamped = submit(t.handle, seeded, { workspaceRevision: 2, observedRowVersion: 2 });
      expect(restamped).toMatchObject({ ok: false, failure: { error: "idempotency-mismatch" } });
      expect(q1(t.handle, seeded.basics.jobId)).toEqual(before.q1);
    });
  });

  it("replays failed runs as-is without requeueing", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      t.handle.db
        .update(workItems)
        .set({ state: "FAILED", attemptCount: 3 })
        .where(eq(workItems.id, first.workItemId))
        .run();
      t.handle.db
        .update(generationRequests)
        .set({ status: "FAILED", errorCode: "TIMEOUT", finishedAt: V13_T0 })
        .where(eq(generationRequests.id, seeded.requestId))
        .run();
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "FAILED", tailoringReasonCode: "TIMEOUT" })
        .where(eq(jobs.id, seeded.basics.jobId))
        .run();
      const replay = submit(t.handle, seeded);
      expect(replay).toMatchObject({ ok: true, replayed: true, status: "FAILED" });
      expect(
        t.handle.db.select().from(workItems).where(eq(workItems.id, first.workItemId)).get(),
      ).toMatchObject({ state: "FAILED", attemptCount: 3 });
      expect(handleRow(t.handle, seeded.requestId)).toMatchObject({ status: "FAILED" });
    });
  });

  it("starts a new run for a new operation ID after terminal states", () => {
    withV13Database((t, world) => {
      const seeded = seedDraftWorld(t.handle, world);
      const first = submit(t.handle, seeded);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      t.handle.db
        .update(workItems)
        .set({ state: "SUCCEEDED" })
        .where(eq(workItems.id, first.workItemId))
        .run();
      t.handle.db
        .update(generationRequests)
        .set({ status: "SUCCEEDED", finishedAt: V13_T0 })
        .where(eq(generationRequests.id, seeded.requestId))
        .run();
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "AWAITING_REVIEW" })
        .where(eq(jobs.id, seeded.basics.jobId))
        .run();
      const secondId = newId();
      const second = submit(t.handle, { ...seeded, requestId: secondId }, {
        workspaceRevision: 2,
        observedRowVersion: 2,
      });
      expect(second).toMatchObject({ ok: true, requestId: secondId, replayed: false });
      expect(q1(t.handle, seeded.basics.jobId)).toMatchObject({ requests: 2, work: 2 });
    });
  });
});

function handleRow(handle: DatabaseHandle, requestId: string) {
  return handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.id, requestId))
    .get();
}
