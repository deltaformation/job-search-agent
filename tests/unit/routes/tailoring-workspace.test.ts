// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import { GET as versionsGET } from "../../../app/api/jobs/[id]/tailoring/versions/route";
import {
  newId,
  openDatabase,
  tailoringWorkspaces,
  type DatabaseHandle,
} from "../../../src/db";
import { markWorkspaceSubmitted } from "../../../src/db/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import {
  TailoringErrorBody,
  WorkspaceReply,
  buildWorkspaceETag,
  type WorkspacePut,
} from "../../../src/domain/tailoringWorkspace";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  stubRecommendationsProvider,
  v13ExtractionJson,
  v13Focus,
  V13_T0,
  type V13Basics,
} from "../db/v13world";
import {
  getRequest,
  mutationHeaders,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * B2 route leg: workspace GET/PUT status codes, ETags, gating,
 * body limits, and ErrorBody envelopes, plus the paginated
 * versions API. Service semantics (CAS, bindings, budgets) are
 * proven in `tests/unit/server/tailoringWorkspace.test.ts`.
 */

function putRequest(path: string, body: string, ifMatch: string | null): Request {
  const headers: Record<string, string> = {
    ...mutationHeaders(),
    "content-type": "application/json",
  };
  if (ifMatch !== null) {
    headers["if-match"] = ifMatch;
  }
  return new Request(`http://127.0.0.1:3000${path}`, { method: "PUT", headers, body });
}

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

describe("workspace and versions routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-routes-");
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

  function seedBasics(overrides: { jdText?: string; extractedJson?: string } = {}): {
    basics: V13Basics;
    world: CrossProfileWorld;
  } {
    return withDb((handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      return { basics: seedV13Basics(handle, world, overrides), world };
    });
  }

  describe("GET workspace", () => {
    it("returns a null body at revision 0 without inserting", async () => {
      const { basics } = seedBasics();
      const response = await workspaceGET(
        getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
        routeParams(basics.jobId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(`"tw:${basics.jobId}:0"`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = WorkspaceReply.parse(await readJson(response));
      expect(body).toEqual({ ok: true, workspace: null });
      withDb((handle) => {
        expect(handle.db.select().from(tailoringWorkspaces).all()).toEqual([]);
      });
    });

    it("returns the saved view with its revision ETag", async () => {
      const { basics } = seedBasics();
      withDb((handle) => {
        const saved = saveWorkspace(handle, basics.jobId, 0, emptyDraft(), {
          now: () => V13_T0,
          recommendations: stubRecommendationsProvider(null),
        });
        expect(saved.ok).toBe(true);
      });
      const response = await workspaceGET(
        getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
        routeParams(basics.jobId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(`"tw:${basics.jobId}:1"`);
      const body = WorkspaceReply.parse(await readJson(response));
      expect(body.workspace?.revision).toBe(1);
    });

    it("404s unknown jobs and 400s malformed ids with ErrorBody", async () => {
      const missing = newId();
      const notFound = await workspaceGET(
        getRequest(`/api/jobs/${missing}/tailoring/workspace`),
        routeParams(missing),
      );
      expect(notFound.status).toBe(404);
      expect(TailoringErrorBody.parse(await readJson(notFound)).error.code).toBe("NOT_FOUND");
      const malformed = await workspaceGET(
        getRequest("/api/jobs/not-a-uuid/tailoring/workspace"),
        routeParams("not-a-uuid"),
      );
      expect(malformed.status).toBe(400);
      expect(TailoringErrorBody.parse(await readJson(malformed)).error.code).toBe(
        "INVALID_REQUEST",
      );
    });

    it("403s rebinding hosts with ErrorBody", async () => {
      const { basics } = seedBasics();
      const response = await workspaceGET(
        getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`, { host: "evil.example:3000" }),
        routeParams(basics.jobId),
      );
      expect(response.status).toBe(403);
      expect(TailoringErrorBody.parse(await readJson(response)).error.code).toBe("FORBIDDEN");
    });

    it("503s corrupt stored drafts", async () => {
      const { basics } = seedBasics();
      withDb((handle) => {
        const saved = saveWorkspace(handle, basics.jobId, 0, emptyDraft(), {
          now: () => V13_T0,
          recommendations: stubRecommendationsProvider(null),
        });
        expect(saved.ok).toBe(true);
        handle.db
          .update(tailoringWorkspaces)
          .set({ revision: 2, focusJson: '{"schemaVersion":"tailoring-focus/v1"}' })
          .where(eq(tailoringWorkspaces.jobId, basics.jobId))
          .run();
      });
      const response = await workspaceGET(
        getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
        routeParams(basics.jobId),
      );
      expect(response.status).toBe(503);
      expect(TailoringErrorBody.parse(await readJson(response)).error.code).toBe(
        "STORAGE_UNAVAILABLE",
      );
    });
  });

  describe("PUT workspace", () => {
    it("creates at 201 and updates at 200 through the revision chain", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const created = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), buildWorkspaceETag(basics.jobId, 0)),
        routeParams(basics.jobId),
      );
      expect(created.status).toBe(201);
      expect(created.headers.get("ETag")).toBe(`"tw:${basics.jobId}:1"`);
      expect(created.headers.get("Cache-Control")).toBe("no-store");
      expect(WorkspaceReply.parse(await readJson(created)).workspace?.revision).toBe(1);
      const updated = await workspacePUT(
        putRequest(
          path,
          JSON.stringify(emptyDraft({ focus: v13Focus({ summaryDirection: "Ops-first." }) })),
          buildWorkspaceETag(basics.jobId, 1),
        ),
        routeParams(basics.jobId),
      );
      expect(updated.status).toBe(200);
      expect(updated.headers.get("ETag")).toBe(`"tw:${basics.jobId}:2"`);
      const body = WorkspaceReply.parse(await readJson(updated));
      expect(body.workspace?.draft.focus.summaryDirection).toBe("Ops-first.");
    });

    it("preserves the submission stamp on retry PUTs", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const created = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), buildWorkspaceETag(basics.jobId, 0)),
        routeParams(basics.jobId),
      );
      expect(created.status).toBe(201);
      const requestId = withDb((handle) => {
        const run = seedV13RunningRun(handle, basics);
        const stamped = markWorkspaceSubmitted(handle, {
          jobId: basics.jobId,
          observedRevision: 1,
          requestId: run.requestId,
          now: V13_T0,
        });
        expect(stamped.ok).toBe(true);
        return run.requestId;
      });
      const retry = await workspacePUT(
        putRequest(
          path,
          JSON.stringify(emptyDraft({ focus: v13Focus({ additionalGuidance: "Retry." }) })),
          buildWorkspaceETag(basics.jobId, 2),
        ),
        routeParams(basics.jobId),
      );
      expect(retry.status).toBe(200);
      const body = WorkspaceReply.parse(await readJson(retry));
      expect(body.workspace?.revision).toBe(3);
      expect(body.workspace?.lastRequestId).toBe(requestId);
      expect(body.workspace?.lastSubmittedRevision).toBe(2);
    });

    it("rejects stale revisions with 412 and the current revision", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const created = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), buildWorkspaceETag(basics.jobId, 0)),
        routeParams(basics.jobId),
      );
      expect(created.status).toBe(201);
      const stale = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), buildWorkspaceETag(basics.jobId, 0)),
        routeParams(basics.jobId),
      );
      expect(stale.status).toBe(412);
      const body = TailoringErrorBody.parse(await readJson(stale));
      expect(body.error.code).toBe("WORKSPACE_CONFLICT");
      expect(body.error.currentWorkspaceRevision).toBe(1);
      expect(body.error.action).toBe("reload");
    });

    it("requires exactly one If-Match: 428 absent, 400 wildcard/list/malformed, 412 wrong job", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const missing = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), null),
        routeParams(basics.jobId),
      );
      expect(missing.status).toBe(428);
      expect(TailoringErrorBody.parse(await readJson(missing)).error.code).toBe(
        "PRECONDITION_REQUIRED",
      );
      for (const header of [
        "*",
        `"tw:${basics.jobId}:0", "tw:${basics.jobId}:1"`,
        "not-an-etag",
        `"tw:${basics.jobId}"`,
      ]) {
        const bad = await workspacePUT(
          putRequest(path, JSON.stringify(emptyDraft()), header),
          routeParams(basics.jobId),
        );
        expect(bad.status, header).toBe(400);
        expect(TailoringErrorBody.parse(await readJson(bad)).error.code).toBe("INVALID_REQUEST");
      }
      const foreign = await workspacePUT(
        putRequest(path, JSON.stringify(emptyDraft()), buildWorkspaceETag(newId(), 0)),
        routeParams(basics.jobId),
      );
      expect(foreign.status).toBe(412);
      expect(TailoringErrorBody.parse(await readJson(foreign)).error.code).toBe(
        "WORKSPACE_CONFLICT",
      );
    });

    it("400s schema violations with the first field, 413s oversize bodies first", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const etag = buildWorkspaceETag(basics.jobId, 0);
      const injected = await workspacePUT(
        putRequest(path, JSON.stringify({ ...emptyDraft(), actor: "human" }), etag),
        routeParams(basics.jobId),
      );
      expect(injected.status).toBe(400);
      expect(TailoringErrorBody.parse(await readJson(injected)).error.code).toBe("INVALID_REQUEST");
      const malformed = await workspacePUT(
        putRequest(path, "{not json", etag),
        routeParams(basics.jobId),
      );
      expect(malformed.status).toBe(400);
      const huge = JSON.stringify(emptyDraft({ focus: v13Focus({ summaryDirection: "x".repeat(200_000) }) }));
      expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(131072);
      const oversize = await workspacePUT(putRequest(path, huge, etag), routeParams(basics.jobId));
      expect(oversize.status).toBe(413);
      expect(TailoringErrorBody.parse(await readJson(oversize)).error.code).toBe("INVALID_REQUEST");
    });

    it("403s cross-origin and metadata-less mutations, accepts same-origin fetch metadata", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const body = JSON.stringify(emptyDraft());
      const etag = buildWorkspaceETag(basics.jobId, 0);
      const crossOrigin = await workspacePUT(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "PUT",
          headers: {
            host: "127.0.0.1:3000",
            origin: "http://evil.example:3000",
            "content-type": "application/json",
            "if-match": etag,
          },
          body,
        }),
        routeParams(basics.jobId),
      );
      expect(crossOrigin.status).toBe(403);
      const bare = await workspacePUT(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "PUT",
          headers: { host: "127.0.0.1:3000", "content-type": "application/json", "if-match": etag },
          body,
        }),
        routeParams(basics.jobId),
      );
      expect(bare.status).toBe(403);
      const fetchMetadata = await workspacePUT(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "PUT",
          headers: {
            host: "127.0.0.1:3000",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            "if-match": etag,
          },
          body,
        }),
        routeParams(basics.jobId),
      );
      expect(fetchMetadata.status).toBe(201);
    });

    it("404s unknown jobs and 409s hash-mismatched selections against the real adapter (D)", async () => {
      const missing = newId();
      const notFound = await workspacePUT(
        putRequest(
          `/api/jobs/${missing}/tailoring/workspace`,
          JSON.stringify(emptyDraft()),
          buildWorkspaceETag(missing, 0),
        ),
        routeParams(missing),
      );
      expect(notFound.status).toBe(404);
      // D's adapter strict-parses the retained envelope: seed a valid
      // one so the fake client hash below mismatches the real build
      // (409) instead of tripping corrupt storage (503).
      const jdText = "TypeScript APIs with PostgreSQL and Redis caching.";
      const { basics } = seedBasics({ jdText, extractedJson: v13ExtractionJson(jdText) });
      const path = `/api/jobs/${basics.jobId}/tailoring/workspace`;
      const selections = await workspacePUT(
        putRequest(
          path,
          JSON.stringify(
            emptyDraft({
              extractionId: basics.extractionId,
              profileId: basics.profileId,
              profileVersionId: basics.profileVersionId,
              recommendationHash: "a".repeat(64),
              focus: v13Focus({ selectedPhraseIds: ["b".repeat(64)] }),
            }),
          ),
          buildWorkspaceETag(basics.jobId, 0),
        ),
        routeParams(basics.jobId),
      );
      expect(selections.status).toBe(409);
      expect(TailoringErrorBody.parse(await readJson(selections)).error.code).toBe("INPUT_STALE");
    });
  });

  describe("GET versions", () => {
    it("returns empty pages, exact summary shapes, and cursor pages", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/versions`;
      const empty = await versionsGET(getRequest(path), routeParams(basics.jobId));
      expect(empty.status).toBe(200);
      expect(await readJson(empty)).toEqual({ ok: true, versions: [], nextCursor: null });
      withDb((handle) => {
        const first = seedV13RunningRun(handle, basics);
        seedV13RequestInputs(handle, basics, first);
        seedV13Version(handle, basics, first, { createdAt: "2026-09-16T12:00:00.000Z" });
        // WO-1.3-F: completion predicates on live expiry.
        const finished = completeWorkItem(
          handle,
          {
            workItemId: first.workItemId,
            leaseToken: first.leaseToken,
            result: "SUCCEEDED",
          },
          { now: "2026-09-16T12:01:00.000Z" },
        );
        expect(finished.ok).toBe(true);
        const second = seedV13RunningRun(handle, basics);
        seedV13RequestInputs(handle, basics, second);
        seedV13Version(handle, basics, second, {
          version: 2,
          createdAt: "2026-09-16T12:05:00.000Z",
        });
      });
      const firstPage = await versionsGET(getRequest(`${path}?limit=1`), routeParams(basics.jobId));
      const firstBody = (await readJson(firstPage)) as {
        ok: boolean;
        versions: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(firstBody.versions).toHaveLength(1);
      expect(firstBody.versions[0]?.["version"]).toBe(2);
      expect(Object.keys(firstBody.versions[0] ?? {}).sort()).toEqual(
        [
          "createdAt",
          "id",
          "latestPublished",
          "profileDisplayName",
          "reviewState",
          "selectedApproved",
          "version",
        ].sort(),
      );
      expect(firstBody.nextCursor).not.toBeNull();
      const secondPage = await versionsGET(
        getRequest(`${path}?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`),
        routeParams(basics.jobId),
      );
      const secondBody = (await readJson(secondPage)) as {
        ok: boolean;
        versions: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(secondBody.versions).toHaveLength(1);
      expect(secondBody.versions[0]?.["version"]).toBe(1);
      expect(secondBody.nextCursor).toBeNull();
      expect(secondPage.headers.get("Cache-Control")).toBe("no-store");
    });

    it("400s malformed cursors and limits, 404s unknown jobs, 403s rebinding hosts", async () => {
      const { basics } = seedBasics();
      const path = `/api/jobs/${basics.jobId}/tailoring/versions`;
      for (const query of ["?cursor=!!!", "?limit=0", "?limit=51", "?limit=abc"]) {
        const bad = await versionsGET(getRequest(`${path}${query}`), routeParams(basics.jobId));
        expect(bad.status, query).toBe(400);
        expect(TailoringErrorBody.parse(await readJson(bad)).error.code).toBe("INVALID_REQUEST");
      }
      const missing = newId();
      const notFound = await versionsGET(
        getRequest(`/api/jobs/${missing}/tailoring/versions`),
        routeParams(missing),
      );
      expect(notFound.status).toBe(404);
      const rebound = await versionsGET(
        getRequest(path, { host: "evil.example:3000" }),
        routeParams(basics.jobId),
      );
      expect(rebound.status).toBe(403);
    });
  });
});
