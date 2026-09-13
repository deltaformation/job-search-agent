import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as listProfiles,
  POST as createProfileRoute,
} from "../../../app/api/settings/profiles/route";
import { PATCH as patchProfile } from "../../../app/api/settings/profiles/[id]/route";
import { POST as setDefault } from "../../../app/api/settings/profiles/[id]/set-default/route";
import {
  GET as downloadResume,
  POST as uploadResume,
} from "../../../app/api/settings/master-resume/route";
import {
  getRequest,
  mutationHeaders,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "candidate", "master-resume.v1.json"), "utf8"),
) as unknown;

function patchRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PATCH",
    headers: { ...mutationHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let isolated: IsolatedRoot;
let candidateDir: string;
let previousCandidateDir: string | undefined;

beforeEach(() => {
  isolated = setupIsolatedRoot("profiles-route-");
  candidateDir = mkdtempSync(join(tmpdir(), "profiles-candidate-"));
  previousCandidateDir = process.env["CANDIDATE_DIR"];
  process.env["CANDIDATE_DIR"] = candidateDir;
});

afterEach(() => {
  if (previousCandidateDir === undefined) {
    delete process.env["CANDIDATE_DIR"];
  } else {
    process.env["CANDIDATE_DIR"] = previousCandidateDir;
  }
  isolated.restoreEnv();
  isolated.cleanup();
  rmSync(candidateDir, { recursive: true, force: true });
});

describe("GET /api/settings/profiles", () => {
  it("lists an empty collection on a fresh database", async () => {
    const response = await listProfiles(getRequest("/api/settings/profiles"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ profiles: [] });
  });

  it("summarizes versions and facts per profile", async () => {
    const created = await createProfileRoute(
      postRequest("/api/settings/profiles", {
        name: "staff-engineer",
        displayName: "Staff Engineer",
        workPreferences: { workMode: ["REMOTE"], yearsOfExperience: 9 },
      }),
    );
    expect(created.status).toBe(201);
    const uploaded = await uploadResume(postRequest("/api/settings/master-resume", { content: fixture }));
    expect(uploaded.status).toBe(200);

    const listed = await listProfiles(getRequest("/api/settings/profiles"));
    const body = await readJson(listed);
    const profiles = body["profiles"] as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "staff-engineer",
      displayName: "Staff Engineer",
      isDefault: true,
      versionCount: 1,
      latestVersion: 1,
      activeVersion: 1,
    });
    expect(typeof profiles[0]?.["latestVersionAt"]).toBe("string");
    expect(profiles[0]?.["approvedFacts"]).toBeGreaterThan(0);
  });
});

describe("POST /api/settings/profiles", () => {
  it("creates a profile with stamped preferences and narrative", async () => {
    const response = await createProfileRoute(
      postRequest("/api/settings/profiles", {
        name: "engineering-manager",
        displayName: "Engineering Manager",
        workPreferences: {
          workMode: ["HYBRID"],
          workAuthorization: ["US citizen"],
          sponsorshipRequired: false,
          willingToRelocate: true,
          yearsOfExperience: 12,
          salaryExpectation: { min: 180000, target: 220000, currency: "USD" },
        },
        executiveNarrative: "Platform leader.",
      }),
    );
    expect(response.status).toBe(201);
    const profile = (await readJson(response))["profile"] as Record<string, unknown>;
    expect(profile).toMatchObject({
      name: "engineering-manager",
      displayName: "Engineering Manager",
      isDefault: true,
      executiveNarrative: "Platform leader.",
    });
    expect(profile["workPreferences"]).toMatchObject({
      schemaVersion: "work-preferences/v1",
      workMode: ["HYBRID"],
      yearsOfExperience: 12,
      salaryExpectation: { min: 180000, target: 220000, currency: "USD" },
    });
  });

  it("rejects duplicate names with 409", async () => {
    const body = { name: "duplicate", displayName: "First" };
    expect((await createProfileRoute(postRequest("/api/settings/profiles", body))).status).toBe(201);
    const second = await createProfileRoute(
      postRequest("/api/settings/profiles", { ...body, displayName: "Second" }),
    );
    expect(second.status).toBe(409);
    expect(await readJson(second)).toMatchObject({ error: "profile name is already taken" });
  });

  it("rejects invalid slugs and preferences with 400", async () => {
    const badSlug = await createProfileRoute(
      postRequest("/api/settings/profiles", { name: "Bad Name", displayName: "Bad" }),
    );
    expect(badSlug.status).toBe(400);
    const badPrefs = await createProfileRoute(
      postRequest("/api/settings/profiles", {
        name: "bad-prefs",
        displayName: "Bad",
        workPreferences: { workMode: ["TELEPORT"] },
      }),
    );
    expect(badPrefs.status).toBe(400);
  });
});

describe("PATCH /api/settings/profiles/[id]", () => {
  it("updates metadata and clears nullable fields", async () => {
    const created = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", {
          name: "editable",
          displayName: "Before",
          executiveNarrative: "Old narrative.",
        }),
      ),
    ))["profile"] as { id: string };
    const response = await patchProfile(
      patchRequest(`/api/settings/profiles/${created.id}`, {
        displayName: "After",
        executiveNarrative: null,
      }),
      routeParams(created.id),
    );
    expect(response.status).toBe(200);
    expect((await readJson(response))["profile"]).toMatchObject({
      displayName: "After",
      executiveNarrative: null,
    });
  });

  it("returns 404 for unknown ids and 400 for invalid bodies", async () => {
    const missing = await patchProfile(
      patchRequest("/api/settings/profiles/does-not-exist", { displayName: "X" }),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);
    const created = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", { name: "patchable", displayName: "P" }),
      ),
    ))["profile"] as { id: string };
    const invalid = await patchProfile(
      patchRequest(`/api/settings/profiles/${created.id}`, {
        workPreferences: { yearsOfExperience: -3 },
      }),
      routeParams(created.id),
    );
    expect(invalid.status).toBe(400);
  });
});

describe("POST /api/settings/profiles/[id]/set-default", () => {
  it("moves the default marker between profiles", async () => {
    const first = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", { name: "first", displayName: "First" }),
      ),
    ))["profile"] as { id: string };
    const second = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", { name: "second", displayName: "Second" }),
      ),
    ))["profile"] as { id: string };
    const switched = await setDefault(
      postRequest(`/api/settings/profiles/${second.id}/set-default`, {}),
      routeParams(second.id),
    );
    expect(switched.status).toBe(200);
    const profiles = (
      (await readJson(await listProfiles(getRequest("/api/settings/profiles"))))[
        "profiles"
      ] as Array<Record<string, unknown>>
    ).sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
    expect(profiles.map((entry) => [entry["name"], entry["isDefault"]])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    expect(first.id).not.toBe(second.id);
  });

  it("returns 404 for unknown ids", async () => {
    const response = await setDefault(
      postRequest("/api/settings/profiles/does-not-exist/set-default", {}),
      routeParams("does-not-exist"),
    );
    expect(response.status).toBe(404);
  });
});

describe("/api/settings/master-resume", () => {
  it("returns 404 when no master resume is saved", async () => {
    const response = await downloadResume(getRequest("/api/settings/master-resume"));
    expect(response.status).toBe(404);
  });

  it("uploads, re-syncs, and downloads the document", async () => {
    const uploaded = await uploadResume(postRequest("/api/settings/master-resume", { content: fixture }));
    expect(uploaded.status).toBe(200);
    expect(await readJson(uploaded)).toMatchObject({ ok: true, version: 1 });
    const downloaded = await downloadResume(getRequest("/api/settings/master-resume"));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("master-resume.json");
    expect(JSON.parse(await downloaded.text()) as unknown).toEqual(fixture);
  });

  it("rejects invalid documents before writing anything", async () => {
    const rejected = await uploadResume(
      postRequest("/api/settings/master-resume", { content: { achievements: "nope" } }),
    );
    expect(rejected.status).toBe(400);
    expect(await readJson(rejected)).toMatchObject({ error: "invalid master resume" });
    const stillMissing = await downloadResume(getRequest("/api/settings/master-resume"));
    expect(stillMissing.status).toBe(404);
  });

  it("targets an explicit profile and rejects unknown ones", async () => {
    const first = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", { name: "target-a", displayName: "A" }),
      ),
    ))["profile"] as { id: string };
    const second = (await readJson(
      await createProfileRoute(
        postRequest("/api/settings/profiles", { name: "target-b", displayName: "B" }),
      ),
    ))["profile"] as { id: string };
    const targeted = await uploadResume(
      postRequest("/api/settings/master-resume", { content: fixture, profileId: second.id }),
    );
    expect(targeted.status).toBe(200);
    const profiles = (
      (await readJson(await listProfiles(getRequest("/api/settings/profiles"))))[
        "profiles"
      ] as Array<Record<string, unknown>>
    ).sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
    expect(profiles.map((entry) => [entry["name"], entry["versionCount"]])).toEqual([
      ["target-a", 0],
      ["target-b", 1],
    ]);
    expect(first.id).not.toBe(second.id);
    const unknown = await uploadResume(
      postRequest("/api/settings/master-resume", { content: fixture, profileId: "no-such-profile" }),
    );
    expect(unknown.status).toBe(404);
  });
});
