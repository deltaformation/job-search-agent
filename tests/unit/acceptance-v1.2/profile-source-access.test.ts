import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProfileRoute } from "../../../app/api/settings/profiles/route";
import {
  GET as downloadResume,
  POST as uploadResume,
} from "../../../app/api/settings/master-resume/route";
import {
  getRequest,
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";

/**
 * WO-1.2-A acceptance pins for profile-owned master sources (owners:
 * WO-1.2-B for persistence, WO-1.2-C for UI, gates B1–B2). Correction
 * pass: every pin carried exactly one isolated EXPECTED-FAILURE
 * assertion over the shared `uploadBothMasters` setup; WO-1.2-B
 * flipped all pins to passing specs against profile-owned sources.
 * Target (R-ADR-016): each profile owns its master bytes; reads take
 * a profile id, validate ownership, and never leak another profile's
 * source. The pinned behavior (per-profile bytes + ownership failures)
 * must survive C's UI work.
 */

const pmMaster = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
) as unknown;
const spmMaster = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "spm-profile.json"), "utf8"),
) as unknown;

let isolated: IsolatedRoot;
let candidateDir: string;
let previousCandidateDir: string | undefined;

beforeEach(() => {
  isolated = setupIsolatedRoot("v12-source-access-");
  candidateDir = mkdtempSync(join(tmpdir(), "v12-source-candidate-"));
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
  const response = await createProfileRoute(
    postRequest("/api/settings/profiles", { name, displayName }),
  );
  if (response.status !== 201) {
    throw new Error(`profile setup failed: create ${name} returned ${response.status}`);
  }
  const profile = (await readJson(response))["profile"] as Record<string, unknown>;
  return String(profile["id"]);
}

/** Create PM + SPM profiles and upload each master; shared by guard + pins. */
async function uploadBothMasters(): Promise<{ pmId: string; spmId: string }> {
  const pmId = await createProfileId("pm", "Product Manager");
  const spmId = await createProfileId("spm", "Senior Product Manager");
  const first = await uploadResume(
    postRequest("/api/settings/master-resume", { content: pmMaster, profileId: pmId }),
  );
  if (first.status !== 200) {
    throw new Error(`master setup failed: pm upload returned ${first.status}`);
  }
  const second = await uploadResume(
    postRequest("/api/settings/master-resume", { content: spmMaster, profileId: spmId }),
  );
  if (second.status !== 200) {
    throw new Error(`master setup failed: spm upload returned ${second.status}`);
  }
  return { pmId, spmId };
}

describe("profile-owned master sources (R-ADR-016)", () => {
  it("guard: both uploads succeed and profile-addressed reads resolve", async () => {
    const { pmId, spmId } = await uploadBothMasters();
    const pmRead = await downloadResume(getRequest(`/api/settings/master-resume?profileId=${pmId}`));
    expect(pmRead.status).toBe(200);
    const spmRead = await downloadResume(
      getRequest(`/api/settings/master-resume?profileId=${spmId}`),
    );
    expect(spmRead.status).toBe(200);
  });

  it("spm-addressed read returns spm bytes (regression: must survive B/C)", async () => {
    const { spmId } = await uploadBothMasters();
    const spmRead = await downloadResume(
      getRequest(`/api/settings/master-resume?profileId=${spmId}`),
    );
    expect(await spmRead.text()).toContain('"spm-fact-discovery"');
  });

  it("pm-addressed read returns pm bytes, not the last upload (B1)", async () => {
    const { pmId } = await uploadBothMasters();
    const pmRead = await downloadResume(getRequest(`/api/settings/master-resume?profileId=${pmId}`));
    // Flipped by WO-1.2-B: per-profile sources serve each upload.
    expect(await pmRead.text()).toContain('"pm-fact-discovery"');
  });

  it("pm-addressed read excludes spm bytes (B1: no cross-contamination)", async () => {
    const { pmId } = await uploadBothMasters();
    const pmRead = await downloadResume(getRequest(`/api/settings/master-resume?profileId=${pmId}`));
    // Flipped by WO-1.2-B: reads never cross profile boundaries.
    expect(await pmRead.text()).not.toContain('"spm-fact-discovery"');
  });

  it("an unknown profile id fails instead of returning the global file (B2)", async () => {
    await uploadBothMasters();
    const response = await downloadResume(
      getRequest("/api/settings/master-resume?profileId=no-such-profile"),
    );
    // Flipped by WO-1.2-B: unknown ids fail instead of leaking bytes.
    expect(response.status).toBe(404);
  });

  it("a traversal profile id is rejected (B2)", async () => {
    await uploadBothMasters();
    const response = await downloadResume(
      getRequest("/api/settings/master-resume?profileId=..%2Fcandidate"),
    );
    // Flipped by WO-1.2-B: unknown ids fail instead of leaking bytes.
    // Either 400 (malformed id) or 404 (unknown id) is acceptable.
    expect([400, 404]).toContain(response.status);
  });
});
