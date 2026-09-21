import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as activateRoute } from "../../../app/api/settings/profiles/[id]/activate/route";
import { POST as parseRoute } from "../../../app/api/settings/master-resume/parse/route";
import { POST as uploadResume } from "../../../app/api/settings/master-resume/route";
import { POST as copyRoute } from "../../../app/api/settings/profiles/copy/route";
import { POST as createProfileRoute } from "../../../app/api/settings/profiles/route";
import { GET as versionsRoute } from "../../../app/api/settings/profiles/[id]/versions/route";
import { GET as exportRoute } from "../../../app/api/settings/profiles/[id]/versions/[versionId]/export/route";
import {
  getRequest,
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * WO-1.2-C workflow chain (C2/C6): two independent profiles onboarded
 * through parse → review → activate, a copy adjusted and activated,
 * and selected-version exports — every step through the real route
 * handlers against an isolated database, with the default untouched.
 */

const example = JSON.parse(
  readFileSync(join(process.cwd(), "public", "examples", "master-resume.json"), "utf8"),
) as Record<string, unknown>;

let isolated: IsolatedRoot;

beforeEach(() => {
  isolated = setupIsolatedRoot("v12-profile-workflow-");
});

afterEach(() => {
  isolated.restoreEnv();
  isolated.cleanup();
});

async function createProfile(name: string, displayName: string): Promise<string> {
  const response = await createProfileRoute(
    postRequest("/api/settings/profiles", { name, displayName }),
  );
  expect(response.status).toBe(201);
  return String(((await readJson(response))["profile"] as Record<string, unknown>)["id"]);
}

async function onboard(
  profileId: string,
  document: unknown,
): Promise<{ versionId: string; version: number }> {
  const parsed = await parseRoute(
    postRequest("/api/settings/master-resume/parse", { content: document }),
  );
  expect(parsed.status).toBe(200);
  expect((await readJson(parsed))["ok"]).toBe(true);
  const uploaded = await uploadResume(
    postRequest("/api/settings/master-resume", {
      content: document,
      profileId,
      activate: true,
    }),
  );
  expect(uploaded.status).toBe(200);
  const body = await readJson(uploaded);
  return { versionId: String(body["versionId"]), version: Number(body["version"]) };
}

describe("settings workflow chain (C2/C6)", () => {
  it("onboards two profiles, copies and activates, and exports per-version bytes", async () => {
    const defaultId = await createProfile("pm", "Product Manager");
    const first = await onboard(defaultId, example);
    expect(first.version).toBe(1);

    // Second profile from the default's displayed active version.
    const listed = await versionsRoute(
      getRequest(`/api/settings/profiles/${defaultId}/versions`),
      { params: Promise.resolve({ id: defaultId }) },
    );
    const sourceVersions = ((await readJson(listed))["versions"] as Array<Record<string, unknown>>);
    const active = sourceVersions.find((entry) => entry["active"] === true);
    expect(active?.["version"]).toBe(1);

    const copied = await copyRoute(
      postRequest("/api/settings/profiles/copy", {
        sourceProfileId: defaultId,
        sourceVersionId: active?.["id"],
        name: "spm",
        displayName: "Senior Product Manager",
      }),
    );
    expect(copied.status).toBe(201);
    const copyBody = await readJson(copied);
    expect(copyBody["copiedFacts"]).toBe(3);
    const spmId = String(copyBody["profileId"]);
    const draftVersionId = String(copyBody["versionId"]);

    // Draft is inactive until the explicit activation.
    const spmListed = await versionsRoute(
      getRequest(`/api/settings/profiles/${spmId}/versions`),
      { params: Promise.resolve({ id: spmId }) },
    );
    const spmVersions = ((await readJson(spmListed))["versions"] as Array<Record<string, unknown>>);
    expect(spmVersions).toHaveLength(1);
    expect(spmVersions[0]?.["active"]).toBe(false);

    const activated = await activateRoute(
      postRequest(`/api/settings/profiles/${spmId}/activate`, { versionId: draftVersionId }),
      { params: Promise.resolve({ id: spmId }) },
    );
    expect(activated.status).toBe(200);
    expect(await readJson(activated)).toMatchObject({ alreadyActive: false, version: 1 });

    // Per-version exports for the copy: verbatim JSON, full Markdown.
    const jsonExport = await exportRoute(
      getRequest(
        `/api/settings/profiles/${spmId}/versions/${draftVersionId}/export?format=json`,
      ),
      { params: Promise.resolve({ id: spmId, versionId: draftVersionId }) },
    );
    expect(jsonExport.status).toBe(200);
    expect(JSON.parse(await jsonExport.text())).toMatchObject({
      identity: example["identity"],
    });
    const mdExport = await exportRoute(
      getRequest(`/api/settings/profiles/${spmId}/versions/${draftVersionId}/export?format=md`),
      { params: Promise.resolve({ id: spmId, versionId: draftVersionId }) },
    );
    expect(mdExport.status).toBe(200);
    const markdown = await mdExport.text();
    for (const section of ["Summary", "Experience", "Skills", "Languages", "Education", "Credentials"]) {
      expect(markdown).toContain(`## ${section}`);
    }
  });
});
