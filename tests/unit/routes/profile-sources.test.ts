import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as copyProfileRoute } from "../../../app/api/settings/profiles/copy/route";
import { GET as listProfilesRoute, POST as createProfileRoute } from "../../../app/api/settings/profiles/route";
import { PATCH as patchProfileRoute } from "../../../app/api/settings/profiles/[id]/route";
import {
  GET as downloadResume,
  POST as uploadResume,
} from "../../../app/api/settings/master-resume/route";
import { openDatabase } from "../../../src/db/client";
import { getOrCreateCandidateSnapshot } from "../../../src/server/candidates";
import { publishSourceBytes, readSourceBytes, reconcileSources } from "../../../src/server/sources";
import { newId } from "../../../src/db/utils";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * WO-1.2-B acceptance coverage (B1–B3, B5, B6 route): profile-owned
 * master sources end to end — cross-profile reuse without collision
 * or contamination, ownership/traversal/integrity failures, crash and
 * conflict safety, new-field round-trips, and the copy endpoint.
 */

const pmMaster = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
) as Record<string, unknown>;

let isolated: IsolatedRoot;
let candidateDir: string;
let previousCandidateDir: string | undefined;

beforeEach(() => {
  isolated = setupIsolatedRoot("v12-profile-sources-");
  candidateDir = mkdtempSync(join(tmpdir(), "v12-profile-sources-candidate-"));
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

async function createProfileId(name: string, displayName: string): Promise<string> {
  const response = await createProfileRoute(postRequest("/api/settings/profiles", { name, displayName }));
  expect(response.status).toBe(201);
  const profile = (await readJson(response))["profile"] as Record<string, unknown>;
  return String(profile["id"]);
}

async function uploadMaster(content: unknown, profileId?: string): Promise<Record<string, unknown>> {
  const response = await uploadResume(
    postRequest("/api/settings/master-resume", { content, ...(profileId === undefined ? {} : { profileId }) }),
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

async function downloadMaster(profileId?: string): Promise<{ status: number; text: string }> {
  const response = await downloadResume(
    getRequest(profileId === undefined ? "/api/settings/master-resume" : `/api/settings/master-resume?profileId=${profileId}`),
  );
  return { status: response.status, text: await response.text() };
}

function sourcesDir(): string {
  return join(isolated.root, "sources");
}

describe("cross-profile reuse (B1)", () => {
  it("imports identical bytes into a second profile with minted ids and no contamination", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const spmId = await createProfileId("spm", "Senior Product Manager");
    const first = await uploadMaster(pmMaster, pmId);
    expect(first["remappedFacts"]).toEqual([]);
    const second = await uploadMaster(pmMaster, spmId);
    expect((second["remappedFacts"] as unknown[]).length).toBe(6);

    const pmBytes = await downloadMaster(pmId);
    expect(pmBytes.status).toBe(200);
    expect(pmBytes.text).toContain('"pm-fact-discovery"');
    const spmBytes = await downloadMaster(spmId);
    expect(spmBytes.status).toBe(200);
    const pmDoc = JSON.parse(pmBytes.text) as { achievements: Array<{ factId: string; text: string }> };
    const spmDoc = JSON.parse(spmBytes.text) as { achievements: Array<{ factId: string; text: string }> };
    // Sources store the authored bytes verbatim, so both downloads match
    // the upload; independence lives in the stored payloads and facts.
    expect(spmDoc).toEqual(pmDoc);

    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const stored = handle.sqlite
        .prepare("SELECT payload_json AS payloadJson FROM candidate_profile_versions WHERE id = ?")
        .get(String(second["versionId"])) as { payloadJson: string };
      const storedPayload = JSON.parse(stored.payloadJson) as {
        achievements: Array<{ factId: string; text: string }>;
      };
      expect(storedPayload.achievements.map((entry) => entry.text)).toEqual(
        pmDoc.achievements.map((entry) => entry.text),
      );
      expect(
        storedPayload.achievements.some((entry) => entry.factId.startsWith("pm-fact-")),
      ).toBe(false);
      expect(new Set(storedPayload.achievements.map((entry) => entry.factId)).size).toBe(6);

      // Snapshots bind disjoint facts over identical statements.
      const pmSnap = getOrCreateCandidateSnapshot(handle, { profileVersionId: String(first["versionId"]) });
      const spmSnap = getOrCreateCandidateSnapshot(handle, { profileVersionId: String(second["versionId"]) });
      if (!pmSnap.ok || !spmSnap.ok) {
        throw new Error("snapshot creation failed");
      }
      const membership = (snapshotId: string): Array<{ factId: string; statement: string }> =>
        handle.sqlite
          .prepare(
            "SELECT f.fact_id AS factId, f.statement AS statement FROM candidate_snapshot_facts m JOIN candidate_facts f ON f.fact_id = m.fact_id WHERE m.snapshot_id = ? ORDER BY f.fact_id",
          )
          .all(snapshotId) as Array<{ factId: string; statement: string }>;
      const pmFacts = membership(pmSnap.snapshotId);
      const spmFacts = membership(spmSnap.snapshotId);
      expect(pmFacts).toHaveLength(6);
      expect(spmFacts).toHaveLength(6);
      const pmIds = new Set(pmFacts.map((fact) => fact.factId));
      expect(spmFacts.some((fact) => pmIds.has(fact.factId))).toBe(false);
      const statements = (facts: Array<{ statement: string }>): string[] =>
        [...facts].sort((a, b) => a.statement.localeCompare(b.statement)).map((fact) => fact.statement);
      expect(statements(spmFacts)).toEqual(statements(pmFacts));
    } finally {
      handle.close();
    }
  });

  it("rejects altered statements under an existing id without touching the active version", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const first = await uploadMaster(pmMaster, pmId);
    const achievements = (pmMaster["achievements"] as Array<Record<string, unknown>>).map((entry, index) =>
      index === 0 ? { ...entry, text: "Rewritten history with the same id." } : entry,
    );
    const response = await uploadResume(
      postRequest("/api/settings/master-resume", {
        content: { ...pmMaster, achievements },
        profileId: pmId,
      }),
    );
    expect(response.status).toBe(400);
    const body = (await readJson(response)) as Record<string, unknown>;
    expect(String(body["error"] ?? "")).toBe("re-sync failed");
    expect(String(body["reason"] ?? "")).toContain("fact-id-conflict");

    const current = await downloadMaster(pmId);
    expect(current.status).toBe(200);
    expect(current.text).toContain('"pm-fact-discovery"');
    expect(current.text).not.toContain("Rewritten history");
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const versions = handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions")
        .get() as { n: number };
      expect(versions.n).toBe(1);
      const sources = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM candidate_sources").get() as {
        n: number;
      };
      expect(sources.n).toBe(1);
      const active = handle.sqlite
        .prepare("SELECT id AS id FROM candidate_profile_versions WHERE activated_at IS NOT NULL")
        .get() as { id: string };
      expect(active.id).toBe(String(first["versionId"]));
    } finally {
      handle.close();
    }
  });
});

describe("source ownership and integrity (B2)", () => {
  it("fails closed on symlinked, corrupt, and missing source bytes", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const versionId = String(uploaded["versionId"]);
    const sourcePath = join(sourcesDir(), pmId, `${versionId}.json`);
    const original = readFileSync(sourcePath);

    // Symlink to another file: no silent cross-read.
    const decoy = join(sourcesDir(), pmId, "decoy.json");
    writeFileSync(decoy, '{"forged":true}');
    rmSync(sourcePath);
    try {
      symlinkSync(decoy, sourcePath);
    } catch {
      writeFileSync(sourcePath, original);
      return;
    }
    expect((await downloadMaster(pmId)).status).toBe(500);
    rmSync(sourcePath);
    writeFileSync(sourcePath, original);
    expect((await downloadMaster(pmId)).status).toBe(200);

    // Corrupt bytes fail hash verification.
    writeFileSync(sourcePath, Buffer.concat([original, Buffer.from("x")]));
    expect((await downloadMaster(pmId)).status).toBe(500);
    writeFileSync(sourcePath, original);

    // A missing file for a recorded row fails instead of guessing.
    rmSync(sourcePath);
    const missing = await downloadMaster(pmId);
    expect(missing.status).toBe(500);
  });

  it("never resolves one profile's version through another profile", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const spmId = await createProfileId("spm", "Senior Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const crossed = readSourceBytes(handle, sourcesDir(), spmId, String(uploaded["versionId"]));
      expect(crossed).toMatchObject({ ok: false, error: "version-profile-mismatch" });
    } finally {
      handle.close();
    }
  });
});

describe("failure safety (B3)", () => {
  it("quarantines crashed-publish orphans while the active version keeps serving", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    await uploadMaster(pmMaster, pmId);
    // Simulate a crash between byte publication and transaction commit.
    publishSourceBytes(sourcesDir(), pmId, newId(), Buffer.from('{"orphan":true}'));
    const debris = join(sourcesDir(), pmId, "stale.tmp-123");
    writeFileSync(debris, "partial");

    const stillCurrent = await downloadMaster(pmId);
    expect(stillCurrent.status).toBe(200);
    expect(stillCurrent.text).toContain('"pm-fact-discovery"');

    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const report = reconcileSources(handle, sourcesDir());
      expect(report.quarantined.length).toBe(2);
      expect(report.missingFiles).toEqual([]);
    } finally {
      handle.close();
    }
    const recovered = await downloadMaster(pmId);
    expect(recovered.status).toBe(200);
    expect(recovered.text).toContain('"pm-fact-discovery"');
  });

  it("treats identical re-uploads as a no-op without new versions or rows", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const first = await uploadMaster(pmMaster, pmId);
    const second = await uploadMaster(pmMaster, pmId);
    expect(second["alreadyCurrent"]).toBe(true);
    expect(second["versionId"]).toBe(first["versionId"]);
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const versions = handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions")
        .get() as { n: number };
      const sources = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM candidate_sources").get() as {
        n: number;
      };
      expect(versions.n).toBe(1);
      expect(sources.n).toBe(1);
    } finally {
      handle.close();
    }
  });
});

describe("complete profile data (B5)", () => {
  it("round-trips links, languages, keywords, notes, salary period, and tri-state choices", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const identity = pmMaster["identity"] as Record<string, unknown>;
    const withV2 = {
      ...pmMaster,
      identity: { ...identity, links: { linkedin: "https://example.com/in/jordan", github: "https://example.com/jordan" } },
      languages: [
        { name: "English", proficiency: "expert", verified: true },
        { name: "French", proficiency: "beginner", verified: false },
      ],
    };
    await uploadMaster(withV2, pmId);
    const downloaded = await downloadMaster(pmId);
    expect(downloaded.status).toBe(200);
    const stored = JSON.parse(downloaded.text) as Record<string, unknown>;
    expect(stored["identity"]).toMatchObject({ links: { linkedin: "https://example.com/in/jordan" } });
    expect(stored["languages"]).toHaveLength(2);

    const patched = await patchProfileRoute(
      postRequest("/api/settings/profiles/x", {
        workPreferences: {
          workMode: ["REMOTE"],
          sponsorshipRequired: false,
          willingToRelocate: null,
          careerKeywords: ["B2B SaaS", "discovery"],
          profileNotes: "Aims at platform roles.",
          salaryExpectation: { target: 180000, currency: "CAD", period: "ANNUAL" },
        },
      }),
      routeParams(pmId),
    );
    expect(patched.status).toBe(200);
    const listed = await listProfilesRoute(getRequest("/api/settings/profiles"));
    const profiles = ((await readJson(listed))["profiles"] as Array<Record<string, unknown>>).find(
      (entry) => entry["id"] === pmId,
    );
    expect(profiles?.["workPreferences"]).toMatchObject({
      careerKeywords: ["B2B SaaS", "discovery"],
      profileNotes: "Aims at platform roles.",
      salaryExpectation: { target: 180000, currency: "CAD", period: "ANNUAL" },
      sponsorshipRequired: false,
      willingToRelocate: null,
    });
  });

  it("preserves unknown choices and never rewrites history on preference edits", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    let before = "";
    try {
      const snap = getOrCreateCandidateSnapshot(handle, { profileVersionId: String(uploaded["versionId"]) });
      if (!snap.ok) {
        throw new Error("snapshot failed");
      }
      const row = handle.sqlite
        .prepare("SELECT canonical_json AS canonicalJson, sha256 AS sha256 FROM candidate_snapshots WHERE id = ?")
        .get(snap.snapshotId) as { canonicalJson: string; sha256: string };
      before = `${row.sha256}:${row.canonicalJson}`;
    } finally {
      handle.close();
    }
    // Preferences without sponsorship/relocation invent no defaults.
    const patched = await patchProfileRoute(
      postRequest("/api/settings/profiles/x", { workPreferences: { workMode: ["HYBRID"] } }),
      routeParams(pmId),
    );
    expect(patched.status).toBe(200);
    const listed = await listProfilesRoute(getRequest("/api/settings/profiles"));
    const profiles = ((await readJson(listed))["profiles"] as Array<Record<string, unknown>>).find(
      (entry) => entry["id"] === pmId,
    );
    expect(profiles?.["workPreferences"]).toMatchObject({
      workMode: ["HYBRID"],
      sponsorshipRequired: null,
      willingToRelocate: null,
    });
    const reopened = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const snap = getOrCreateCandidateSnapshot(reopened, { profileVersionId: String(uploaded["versionId"]) });
      if (!snap.ok) {
        throw new Error("snapshot failed");
      }
      const row = reopened.sqlite
        .prepare("SELECT canonical_json AS canonicalJson, sha256 AS sha256 FROM candidate_snapshots WHERE id = ?")
        .get(snap.snapshotId) as { canonicalJson: string; sha256: string };
      expect(`${row.sha256}:${row.canonicalJson}`).toBe(before);
      const versions = reopened.sqlite
        .prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions")
        .get() as { n: number };
      expect(versions.n).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe("profile copy endpoint (B6)", () => {
  it("copies via the API with explicit activation still required", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    await uploadMaster(pmMaster, pmId);
    const response = await copyProfileRoute(
      postRequest("/api/settings/profiles/copy", {
        sourceProfileId: pmId,
        name: "spm",
        displayName: "Senior Product Manager",
      }),
    );
    expect(response.status).toBe(201);
    const body = (await readJson(response)) as Record<string, unknown>;
    expect(body["copiedFacts"]).toBe(6);
    const copyId = String(body["profileId"]);
    const copyBytes = await downloadMaster(copyId);
    // The copy is an inactive draft: no active master until activation.
    expect(copyBytes.status).toBe(404);
    const listed = await listProfilesRoute(getRequest("/api/settings/profiles"));
    const profiles = (await readJson(listed))["profiles"] as Array<Record<string, unknown>>;
    expect(profiles.find((entry) => entry["id"] === copyId)?.["activeVersion"]).toBeNull();
  });

  it("maps copy failures to 404, 409, and 400", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    await uploadMaster(pmMaster, pmId);
    const unknown = await copyProfileRoute(
      postRequest("/api/settings/profiles/copy", {
        sourceProfileId: "no-such-profile",
        name: "x",
        displayName: "X",
      }),
    );
    expect(unknown.status).toBe(404);
    const first = await copyProfileRoute(
      postRequest("/api/settings/profiles/copy", {
        sourceProfileId: pmId,
        name: "taken",
        displayName: "Taken",
      }),
    );
    expect(first.status).toBe(201);
    const duplicate = await copyProfileRoute(
      postRequest("/api/settings/profiles/copy", {
        sourceProfileId: pmId,
        name: "taken",
        displayName: "Taken",
      }),
    );
    expect(duplicate.status).toBe(409);
    const invalid = await copyProfileRoute(
      postRequest("/api/settings/profiles/copy", { sourceProfileId: pmId, name: "Bad Name!" }),
    );
    expect(invalid.status).toBe(400);
  });
});
