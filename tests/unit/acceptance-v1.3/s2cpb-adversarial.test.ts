// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as generationsPOST,
} from "../../../app/api/jobs/[id]/tailoring/generations/route";
import {
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  newId,
  openDatabase,
  type DatabaseHandle,
} from "../../../src/db";
import { readPreparationByJob } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { canonicalText } from "../../../src/domain/canonical";
import {
  PreparationPlanV2,
  PreparationProposalV2,
} from "../../../src/domain/step2Correction";
import { buildWorkspaceETag } from "../../../src/domain/tailoringWorkspace";
import { readPlanForJob } from "../../../src/server/preparation";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  mutationHeaders,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import {
  claimS2b,
  finishS2bAttempt,
  pmEvidenceFor,
  proposalForS2bV2,
  runS2bAttempt,
  s2bProposalKit,
  s2bQ1,
  s2bSnapshotIds,
  S2B_JD,
  S2B_KEYED_ENV,
  scheduleS2b,
  seedS2bJob,
  seedV2Accepted,
  withS2bDatabase,
} from "./s2b-world";


/**
 * WO-1.3-S2-CP-B adversarial legs (S2CPB2 + S2CPB5): poisoned
 * provider proposals fail publication end to end with no accepted
 * plan; provider trust extras fail schema before persistence;
 * sparse valid proposals accept without padding; plan reads carry
 * exact server-derived eligible roles; foreign roles refuse at
 * W-v3 save and at generation, both 422 over HTTP with zero
 * generation writes.
 */

function putRequest(path: string, body: unknown, ifMatch: string | null): Request {
  const headers: Record<string, string> = {
    ...mutationHeaders(),
    "content-type": "application/json",
  };
  if (ifMatch !== null) {
    headers["if-match"] = ifMatch;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function keyedEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(S2B_KEYED_ENV)) {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    process.env[key] = value;
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const FOREIGN_ID = "f".repeat(64);

describe("S2CPB2 poisoned publication", () => {
  it("a proposal with foreign links, anchors, and roles fails with no accepted plan", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const snapshots = s2bSnapshotIds(t.handle, basics, S2B_JD);
      const canonicalJd = canonicalText(S2B_JD);
      // Schema-valid but semantically poisoned: quotes verify,
      // every anchor is unknown, every link is foreign, and the
      // role names no employment.
      const poisoned = proposalForS2bV2({
        jdText: canonicalJd,
        jdSnapshotId: snapshots.jdSnapshotId,
        candidateSnapshotId: snapshots.candidateSnapshotId,
        extractionId: basics.extractionId,
        jdHash: sha256HexUtf8(canonicalJd),
        quotes: [
          { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["no-such-fact"] },
        ],
        angles: [
          { title: "Poisoned", summaryText: "Poisoned angle text.", factIds: ["no-such-fact"], links: [0] },
        ],
        suggestions: [
          { roleId: "emp-elsewhere", text: "Poisoned suggestion.", factIds: ["no-such-fact"], links: [0] },
        ],
      });
      // Rewrite the computed links to foreign ids (the builder
      // input keeps schema shape; only resolution fails).
      poisoned.angles[0]!.priorityIds = [FOREIGN_ID];
      poisoned.suggestions[0]!.priorityIds = [FOREIGN_ID];
      expect(PreparationProposalV2.safeParse(poisoned).success).toBe(true);

      const q1Before = s2bQ1(t.handle);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      const provider = new TestPrepareProvider({
        proposals: { [snapshots.jdSnapshotId]: poisoned },
      });
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("FAILED");
      expect(row?.acceptedPlanId).toBeNull();
      const plans = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS count FROM step2_plans WHERE preparation_id = ?")
        .get(row?.id) as { count: number };
      expect(plans.count).toBe(0);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
    });
  });

  it("a proposal that keeps zero links fails even with valid anchors", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const snapshots = s2bSnapshotIds(t.handle, basics, S2B_JD);
      const evidence = pmEvidenceFor(t.handle, world);
      const discovery = evidence.payload.achievements.find(
        (achievement) => achievement.factId === "pm-fact-discovery",
      );
      if (discovery === undefined) {
        throw new Error("S2-CP-B setup lost the discovery fact");
      }
      const canonicalJd = canonicalText(S2B_JD);
      const unlinked = proposalForS2bV2({
        jdText: canonicalJd,
        jdSnapshotId: snapshots.jdSnapshotId,
        candidateSnapshotId: snapshots.candidateSnapshotId,
        extractionId: basics.extractionId,
        jdHash: sha256HexUtf8(canonicalJd),
        quotes: [
          { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
        ],
        suggestions: [
          {
            roleId: "emp-harbor",
            text: canonicalText(discovery.text),
            factIds: ["pm-fact-discovery"],
            links: [0],
          },
        ],
      });
      unlinked.suggestions[0]!.priorityIds = [FOREIGN_ID];
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      const provider = new TestPrepareProvider({
        proposals: { [snapshots.jdSnapshotId]: unlinked },
      });
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      expect(readPreparationByJob(t.handle, basics.jobId)?.acceptedPlanId).toBeNull();
    });
  });

  it("provider trust extras fail schema and persist nothing", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      const tainted = {
        ...kit.proposal,
        verified: true,
        provenance: "VERIFIED_SOURCE",
        eligibleRoleIds: ["emp-harbor"],
        score: 99,
      };
      expect(PreparationProposalV2.safeParse(tainted).success).toBe(false);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      // The provider adapter parses strictly too: the tainted
      // payload is refused before any plan row exists.
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: tainted },
      });
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome.result).toBe("FAILED");
      // Non-terminal: the attempt may retry against a corrected
      // provider response. (The exact code is the test double's
      // mapping; production adapters map strict-parse failures
      // through their own unit-pinned reasons.)
      expect(outcome.terminal).not.toBe(true);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.acceptedPlanId).toBeNull();
      const plans = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS count FROM step2_plans")
        .get() as { count: number };
      expect(plans.count).toBe(0);
    });
  });

  it("a sparse valid proposal accepts without padding", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const snapshots = s2bSnapshotIds(t.handle, basics, S2B_JD);
      const evidence = pmEvidenceFor(t.handle, world);
      const discovery = evidence.payload.achievements.find(
        (achievement) => achievement.factId === "pm-fact-discovery",
      );
      if (discovery === undefined) {
        throw new Error("S2-CP-B setup lost the discovery fact");
      }
      const canonicalJd = canonicalText(S2B_JD);
      const sparse = proposalForS2bV2({
        jdText: canonicalJd,
        jdSnapshotId: snapshots.jdSnapshotId,
        candidateSnapshotId: snapshots.candidateSnapshotId,
        extractionId: basics.extractionId,
        jdHash: sha256HexUtf8(canonicalJd),
        quotes: [
          { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
          { text: "KPI measurement", importance: "preferred", matchStatus: "gap", factIds: [] },
        ],
        suggestions: [
          {
            roleId: "emp-harbor",
            text: `${canonicalText(discovery.text)} Converting 97% of trials.`,
            factIds: ["pm-fact-discovery"],
            links: [0],
          },
        ],
      });
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      const provider = new TestPrepareProvider({
        proposals: { [snapshots.jdSnapshotId]: sparse },
      });
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("SUCCEEDED");
      expect(row?.acceptedPlanId).not.toBeNull();
      const stored = t.handle.sqlite
        .prepare("SELECT plan_json AS planJson FROM step2_plans WHERE id = ?")
        .get(row?.acceptedPlanId) as { planJson: string };
      const plan = PreparationPlanV2.parse(JSON.parse(stored.planJson) as unknown);
      // No padding: exactly the proposed priorities survive, the
      // gap stays a gap, and the novel-number suggestion is
      // recorded unusable instead of blessing the metric.
      expect(plan.priorities).toHaveLength(2);
      expect(plan.suggestions).toHaveLength(1);
      expect(plan.positioning.angles).toHaveLength(0);
      expect(plan.suggestions[0]).toMatchObject({ usable: false, unusableReason: "NEW_METRIC" });
      const gap = plan.priorities.find((priority) => priority.support === "gap");
      expect(gap).toBeDefined();
    });
  });
});

describe("S2CPB5 eligible roles and foreign refusal", () => {
  it("plan reads carry exact server-derived eligible roles; rows store none", async () => {
    await withS2bDatabase(async (t, world) => {
      const seed = await seedV2Accepted(t.handle, world);
      const read = readPlanForJob(t.handle, seed.basics.jobId, null);
      if (!read.ok || read.value.version !== 2) {
        throw new Error("S2-CP-B setup cannot read the v2 plan");
      }
      expect(read.value.eligibleRoles.length).toBeGreaterThan(0);
      for (const entry of read.value.eligibleRoles) {
        const suggestion = read.value.plan.suggestions.find(
          (candidate) => candidate.suggestionId === entry.suggestionId,
        );
        if (suggestion === undefined) {
          throw new Error(`S2-CP-B plan read named unknown ${entry.suggestionId}`);
        }
      }
      // The kit's usable suggestion cites Harbor-owned discovery:
      // exactly Harbor is eligible, and the stored plan bytes
      // carry no eligible-role field for a provider to forge.
      const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
      if (usable === undefined) {
        throw new Error("S2-CP-B setup produced no usable suggestion");
      }
      const entry = read.value.eligibleRoles.find(
        (candidate) => candidate.suggestionId === usable.suggestionId,
      );
      expect(entry?.eligibleRoleIds).toEqual(["emp-harbor"]);
      const stored = t.handle.sqlite
        .prepare("SELECT plan_json AS planJson FROM step2_plans WHERE id = ?")
        .get(seed.planRowId) as { planJson: string };
      expect(stored.planJson).not.toContain("eligibleRoleIds");
      expect(stored.planJson).not.toContain("eligibleRoles");
    });
  });

  describe("foreign roles over HTTP", () => {
    let isolated: IsolatedRoot;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      isolated = setupIsolatedRoot("job-tracker-v13-s2cpb-foreign-");
      savedEnv = {};
      keyedEnv(savedEnv);
    });

    afterEach(() => {
      restoreEnv(savedEnv);
      isolated.restoreEnv();
      isolated.cleanup();
    });

    function withDb<T>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> {
      const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
      return Promise.resolve()
        .then(() => fn(handle))
        .finally(() => handle.close());
    }

    async function seedJob(): Promise<{
      jobId: string;
      extractionId: string;
      profileId: string;
      profileVersionId: string;
      planId: string;
      planHash: string;
      suggestionId: string;
      roleId: string;
      summary: string;
    }> {
      return withDb(async (handle) => {
        const world: CrossProfileWorld = seedCrossProfileWorld({
          handle,
          dir: isolated.root,
          dbPath: join(isolated.root, "job-tracker.sqlite"),
          cleanup: () => {},
        });
        // Wall-clock seed: HTTP handlers stamp wall-clock time,
        // so fixed clocks would invert the version/plan lineage.
        const seed = await seedV2Accepted(handle, world, S2B_JD, new Date().toISOString());
        const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
        if (usable === undefined) {
          throw new Error("S2-CP-B setup produced no usable suggestion");
        }
        return {
          jobId: seed.basics.jobId,
          extractionId: seed.basics.extractionId,
          profileId: seed.basics.profileId,
          profileVersionId: seed.basics.profileVersionId,
          planId: seed.planRowId,
          planHash: seed.planHash,
          suggestionId: usable.suggestionId,
          roleId: usable.roleId,
          summary: seed.plan.positioning.keepMasterSummary,
        };
      });
    }

    it("a foreign-role W-v3 save returns 422 with zero generation writes", async () => {
      const job = await seedJob();
      const path = `/api/jobs/${job.jobId}/tailoring/workspace`;
      const q1Before = await withDb((handle) => s2bQ1(handle));
      const refused = await workspacePUT(
        putRequest(
          path,
          {
            schemaVersion: "tailoring-workspace/v3",
            extractionId: job.extractionId,
            profileId: job.profileId,
            profileVersionId: job.profileVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            planId: job.planId,
            planHash: job.planHash,
            recommendationHash: null,
            draft: {
              schemaVersion: "step2-draft/v2",
              planId: job.planId,
              planHash: job.planHash,
              summaryText: "Master summary placeholder.",
              summaryOrigin: "master",
              operations: [
                {
                  op: "add",
                  operationId: newId(),
                  suggestionId: job.suggestionId,
                  roleId: job.roleId === "emp-harbor" ? "emp-beacon" : "emp-harbor",
                  editedText: null,
                },
              ],
            },
          },
          buildWorkspaceETag(job.jobId, 0),
        ),
        routeParams(job.jobId),
      );
      expect(refused.status).toBe(422);
      const body = (await readJson(refused)) as Record<string, unknown>;
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_SELECTION");
      expect(await withDb((handle) => s2bQ1(handle))).toEqual(q1Before);
    });

    it("a foreign-role draft at generation returns 422 with zero generation writes", async () => {
      const job = await seedJob();
      const workspacePath = `/api/jobs/${job.jobId}/tailoring/workspace`;
      // A legal v3 save first; then the stored bytes are tampered
      // to a foreign role. Generation re-derives eligibility from
      // immutable bindings instead of trusting the row.
      const saved = await workspacePUT(
        putRequest(
          workspacePath,
          {
            schemaVersion: "tailoring-workspace/v3",
            extractionId: job.extractionId,
            profileId: job.profileId,
            profileVersionId: job.profileVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            planId: job.planId,
            planHash: job.planHash,
            recommendationHash: null,
            draft: {
              schemaVersion: "step2-draft/v2",
              planId: job.planId,
              planHash: job.planHash,
              summaryText: job.summary,
              summaryOrigin: "master",
              operations: [
                {
                  op: "add",
                  operationId: newId(),
                  suggestionId: job.suggestionId,
                  roleId: job.roleId,
                  editedText: null,
                },
                { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
                { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
              ],
            },
          },
          buildWorkspaceETag(job.jobId, 0),
        ),
        routeParams(job.jobId),
      );
      expect(saved.status).toBe(201);
      const foreignRoleId = job.roleId === "emp-harbor" ? "emp-beacon" : "emp-harbor";
      const rowVersion = await withDb((handle) => {
        const row = handle.sqlite
          .prepare("SELECT focus_json AS focusJson FROM tailoring_workspaces WHERE job_id = ?")
          .get(job.jobId) as { focusJson: string };
        const focus = JSON.parse(row.focusJson) as {
          draft: { operations: Array<{ op: string; roleId?: string }> };
        };
        const add = focus.draft.operations.find((op) => op.op === "add");
        if (add === undefined) {
          throw new Error("S2-CP-B setup lost the add op");
        }
        add.roleId = foreignRoleId;
        handle.sqlite
          .prepare("UPDATE tailoring_workspaces SET focus_json = ?, revision = revision + 1 WHERE job_id = ?")
          .run(JSON.stringify(focus), job.jobId);
        return getTailoringJob(handle, job.jobId)?.rowVersion ?? 0;
      });
      const q1Before = await withDb((handle) => s2bQ1(handle));
      const refused = await generationsPOST(
        postRequest(`/api/jobs/${job.jobId}/tailoring/generations`, {
          schemaVersion: "tailoring-submit/v1",
          requestId: newId(),
          workspaceRevision: 2,
          observedRowVersion: rowVersion,
        }),
        routeParams(job.jobId),
      );
      expect(refused.status).toBe(422);
      const body = (await readJson(refused)) as Record<string, unknown>;
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_SELECTION");
      expect(await withDb((handle) => s2bQ1(handle))).toEqual(q1Before);
      await withDb((handle) => {
        const requests = handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM generation_requests WHERE job_id = ?")
          .get(job.jobId) as { count: number };
        expect(requests.count).toBe(0);
      });
    });
  });
});
