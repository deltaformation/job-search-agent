// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { PUT as workspacePUT } from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import { openDatabase, type DatabaseHandle } from "../../../src/db";
import {
  TailoringErrorBody,
  type WorkspacePut,
} from "../../../src/domain/tailoringWorkspace";
import { buildWorkspaceETag } from "../../../src/domain/tailoringWorkspace";
import { getRecommendations } from "../../../src/server/recommendations";
import {
  getWorkspaceView,
  saveWorkspace,
} from "../../../src/server/tailoringWorkspace";
import { workspaceRecommendationsProvider } from "../../../src/server/recommendations";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  v13ExtractionJson,
  v13Focus,
  V13_T0,
  type V13Basics,
} from "../db/v13world";
import {
  mutationHeaders,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";

/**
 * WO-1.3-E transaction legs: E1 (preset saves verbatim), E2 (422
 * foreign/unsupported selections and 409 stale hashes, all with zero
 * writes), E8 (explicit draft saves touch only the workspace row).
 * E3 lives in the tailoring suites; E6/E7/E9 live in the G suites.
 * The E4/E5 UI legs moved to `s2c-editor.test.tsx`: S2-C replaced the
 * Step 2 surface per the Step 2 amendment, re-pinning autosave,
 * 412 recovery, and cancel-writes-nothing against the v2 editor.
 */

function putRequest(path: string, body: string, ifMatch: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PUT",
    headers: {
      ...mutationHeaders(),
      "content-type": "application/json",
      "if-match": ifMatch,
    },
    body,
  });
}

function tableCounts(handle: DatabaseHandle, jobId: string): Record<string, number> {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT row_version FROM jobs WHERE id = ?) AS jobRowVersion,
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
        (SELECT COUNT(*) FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?) AS reviews,
        (SELECT COUNT(*) FROM tailoring_workspaces WHERE job_id = ?) AS workspaces,
        (SELECT COALESCE(MAX(revision), 0) FROM tailoring_workspaces WHERE job_id = ?) AS workspaceRevision`,
    )
    .get(jobId, jobId, jobId, jobId, jobId, jobId, jobId) as Record<string, number>;
}

describe("WO-1.3-E transaction acceptance", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-e-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function withDb<T>(fn: (handle: DatabaseHandle) => T): T {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  function seedBasics(jdText?: string): { basics: V13Basics; world: CrossProfileWorld } {
    return withDb((handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      const jd = jdText ?? "TypeScript APIs with Redis caching and go-to-market launches.";
      return {
        basics: seedV13Basics(handle, world, { jdText: jd, extractedJson: v13ExtractionJson(jd) }),
        world,
      };
    });
  }

  function boundDraft(
    basics: V13Basics,
    hash: string,
    focus: WorkspacePut["focus"],
  ): WorkspacePut {
    return {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: basics.extractionId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      recommendationHash: hash,
      focus,
    };
  }

  it("E1: saves the served preset verbatim — selected IDs equal the preset exactly", () => {
    const { basics } = seedBasics();
    withDb((handle) => {
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(recs.ok).toBe(true);
      if (!recs.ok) return;
      expect(recs.recommendations.preset.selectedPhraseIds.length).toBeGreaterThan(0);
      const saved = saveWorkspace(
        handle,
        basics.jobId,
        0,
        boundDraft(basics, hashRecommendation(recs.recommendations), recs.recommendations.preset),
        { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.workspace?.draft.schemaVersion).toBe("tailoring-workspace/v1");
      if (saved.value.workspace?.draft.schemaVersion !== "tailoring-workspace/v1") return;
      expect(saved.value.workspace.draft.focus.selectedPhraseIds).toEqual(
        recs.recommendations.preset.selectedPhraseIds,
      );
      expect(saved.value.workspace.draft.focus.themeId).toBe(
        recs.recommendations.preset.themeId,
      );
    });
  });

  it("E2: 422s unknown phrases and foreign mapping facts with zero writes", async () => {
    const { basics } = seedBasics();
    const { hash, supportedPhrase, roleId } = withDb((handle) => {
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(recs.ok).toBe(true);
      if (!recs.ok) throw new Error("recommendations did not build");
      const supported = recs.recommendations.phrases.find(
        (phrase) => phrase.support === "supported" && phrase.factIds.length > 0,
      );
      if (supported === undefined) throw new Error("no supported phrase in fixture");
      const role = recs.recommendations.roles.find((entry) => entry.factIds.length > 0);
      if (role === undefined) throw new Error("no role with facts in fixture");
      return {
        hash: hashRecommendation(recs.recommendations),
        supportedPhrase: supported,
        roleId: role.id,
      };
    });
    const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
    const before = withDb((handle) => tableCounts(handle, basics.jobId));

    const unknownPhrase = await workspacePUT(
      putRequest(
        path,
        JSON.stringify(
          boundDraft(basics, hash, {
            ...v13Focus(),
            selectedPhraseIds: ["f".repeat(64)],
          }),
        ),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(unknownPhrase.status).toBe(422);
    const unknownBody = TailoringErrorBody.parse(await readJson(unknownPhrase));
    expect(unknownBody.error.code).toBe("INVALID_SELECTION");
    expect(unknownBody.error.field).toBe("selectedPhraseIds.0");

    const foreignFact = await workspacePUT(
      putRequest(
        path,
        JSON.stringify(
          boundDraft(basics, hash, {
            ...v13Focus(),
            selectedPhraseIds: [supportedPhrase.id],
            mappings: [{ roleId, phraseId: supportedPhrase.id, factIds: ["fact-from-another-role"] }],
          }),
        ),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(foreignFact.status).toBe(422);
    const foreignBody = TailoringErrorBody.parse(await readJson(foreignFact));
    expect(foreignBody.error.code).toBe("INVALID_SELECTION");
    expect(foreignBody.error.field).toBe("mappings.0.factIds.0");

    expect(withDb((handle) => tableCounts(handle, basics.jobId))).toEqual(before);
    expect(withDb((handle) => getWorkspaceView(handle, basics.jobId))).toMatchObject({
      ok: true,
      value: { workspace: null, revision: 0 },
    });
  });

  it("E2: 409s stale recommendation hashes with zero writes", async () => {
    const { basics } = seedBasics();
    const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
    const before = withDb((handle) => tableCounts(handle, basics.jobId));
    const stale = await workspacePUT(
      putRequest(
        path,
        JSON.stringify(boundDraft(basics, "0".repeat(64), v13Focus())),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(stale.status).toBe(409);
    const body = TailoringErrorBody.parse(await readJson(stale));
    expect(body.error.code).toBe("INPUT_STALE");
    expect(body.error.field).toBe("recommendationHash");
    expect(withDb((handle) => tableCounts(handle, basics.jobId))).toEqual(before);
  });

  it("E8: explicit draft saves change only the workspace row", () => {
    const { basics } = seedBasics();
    withDb((handle) => {
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(recs.ok).toBe(true);
      if (!recs.ok) return;
      const before = tableCounts(handle, basics.jobId);
      const saved = saveWorkspace(
        handle,
        basics.jobId,
        0,
        boundDraft(basics, hashRecommendation(recs.recommendations), {
          ...v13Focus(),
          additionalGuidance: "Explicit draft save.",
        }),
        { now: () => V13_T0, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const after = tableCounts(handle, basics.jobId);
      expect(after).toEqual({
        ...before,
        workspaces: before["workspaces"] + 1,
        workspaceRevision: 1,
      });
    });
  });
});
