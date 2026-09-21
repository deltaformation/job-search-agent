import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as activateRoute } from "../../../app/api/settings/profiles/[id]/activate/route";
import { POST as parseRoute } from "../../../app/api/settings/master-resume/parse/route";
import { POST as uploadResume } from "../../../app/api/settings/master-resume/route";
import { POST as createProfileRoute } from "../../../app/api/settings/profiles/route";
import { GET as versionsRoute } from "../../../app/api/settings/profiles/[id]/versions/route";
import { GET as versionRoute } from "../../../app/api/settings/profiles/[id]/versions/[versionId]/route";
import { GET as exportRoute } from "../../../app/api/settings/profiles/[id]/versions/[versionId]/export/route";
import { openDatabase } from "../../../src/db/client";
import {
  getRequest,
  postRequest,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * WO-1.2-C route integration: version history, version read, explicit
 * activation, no-write validation, and selected-version exports — all
 * profile-scoped with wrong-profile reads rejected. B's persistence
 * stays the single source of truth; these routes only surface it.
 */

const pmMaster = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
) as Record<string, unknown>;

let isolated: IsolatedRoot;

beforeEach(() => {
  isolated = setupIsolatedRoot("v12-profile-versions-");
});

afterEach(() => {
  isolated.restoreEnv();
  isolated.cleanup();
});

function versionParams(id: string, versionId: string): {
  params: Promise<{ id: string; versionId: string }>;
} {
  return { params: Promise.resolve({ id, versionId }) };
}

async function createProfileId(name: string, displayName: string): Promise<string> {
  const response = await createProfileRoute(
    postRequest("/api/settings/profiles", { name, displayName }),
  );
  expect(response.status).toBe(201);
  const profile = (await readJson(response))["profile"] as Record<string, unknown>;
  return String(profile["id"]);
}

async function uploadMaster(
  content: unknown,
  profileId: string,
  activate?: boolean,
): Promise<Record<string, unknown>> {
  const response = await uploadResume(
    postRequest("/api/settings/master-resume", {
      content,
      profileId,
      ...(activate === undefined ? {} : { activate }),
    }),
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

describe("version history (C2/C6)", () => {
  it("lists versions with activation, facts, and source metadata", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const empty = await versionsRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions`),
      { params: Promise.resolve({ id: pmId }) },
    );
    expect(empty.status).toBe(200);
    expect(((await readJson(empty))["versions"] as unknown[])).toEqual([]);

    const uploaded = await uploadMaster(pmMaster, pmId);
    const listed = await versionsRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions`),
      { params: Promise.resolve({ id: pmId }) },
    );
    expect(listed.status).toBe(200);
    const body = await readJson(listed);
    expect(body["profile"]).toMatchObject({ id: pmId, name: "pm" });
    const versions = body["versions"] as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: uploaded["versionId"],
      version: 1,
      active: true,
      schemaVersion: "candidate-profile/v2",
    });
    expect(versions[0]?.["facts"]).toMatchObject({ total: 6, approved: 6 });
    expect(versions[0]?.["source"]).toMatchObject({ origin: "upload" });
  });

  it("returns 404 for an unknown profile", async () => {
    const response = await versionsRoute(getRequest("/api/settings/profiles/nope/versions"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("version read (C4)", () => {
  it("returns the parsed payload with source metadata", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const versionId = String(uploaded["versionId"]);
    const response = await versionRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}`),
      versionParams(pmId, versionId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["version"]).toMatchObject({ id: versionId, version: 1, active: true });
    const payload = body["payload"] as Record<string, unknown>;
    expect(payload["schemaVersion"]).toBe("candidate-profile/v2");
    expect((payload["identity"] as Record<string, unknown>)["fullName"]).toBe(
      (pmMaster["identity"] as Record<string, unknown>)["fullName"],
    );
    expect(body["source"]).toMatchObject({ origin: "upload" });
  });

  it("rejects cross-profile version reads as not found", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const spmId = await createProfileId("spm", "Senior Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const versionId = String(uploaded["versionId"]);
    const response = await versionRoute(
      getRequest(`/api/settings/profiles/${spmId}/versions/${versionId}`),
      versionParams(spmId, versionId),
    );
    expect(response.status).toBe(404);
  });
});

describe("explicit activation (C6)", () => {
  it("activates a staged draft and reports repeat activation idempotently", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId, false);
    const versionId = String(uploaded["versionId"]);
    expect(uploaded["activated"]).toBe(false);

    const first = await activateRoute(
      postRequest(`/api/settings/profiles/${pmId}/activate`, { versionId }),
      { params: Promise.resolve({ id: pmId }) },
    );
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({
      ok: true,
      profileId: pmId,
      versionId,
      version: 1,
      alreadyActive: false,
    });

    const repeat = await activateRoute(
      postRequest(`/api/settings/profiles/${pmId}/activate`, { versionId }),
      { params: Promise.resolve({ id: pmId }) },
    );
    expect(repeat.status).toBe(200);
    expect(await readJson(repeat)).toMatchObject({ alreadyActive: true });

    const listed = await versionsRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions`),
      { params: Promise.resolve({ id: pmId }) },
    );
    const versions = ((await readJson(listed))["versions"] as Array<Record<string, unknown>>);
    expect(versions[0]?.["active"]).toBe(true);
  });

  it("rejects cross-profile and unknown version activation", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const spmId = await createProfileId("spm", "Senior Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId, false);
    const versionId = String(uploaded["versionId"]);

    const crossed = await activateRoute(
      postRequest(`/api/settings/profiles/${spmId}/activate`, { versionId }),
      { params: Promise.resolve({ id: spmId }) },
    );
    expect(crossed.status).toBe(404);

    const unknown = await activateRoute(
      postRequest(`/api/settings/profiles/${pmId}/activate`, {
        versionId: "00000000-0000-4000-8000-000000000000",
      }),
      { params: Promise.resolve({ id: pmId }) },
    );
    expect(unknown.status).toBe(404);
  });
});

describe("no-write validation (C3)", () => {
  it("accepts a valid document with summary and writes nothing", async () => {
    const response = await parseRoute(
      postRequest("/api/settings/master-resume/parse", { content: pmMaster }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["ok"]).toBe(true);
    expect(body["summary"]).toMatchObject({
      employments: 2,
      achievements: 6,
      approvedAchievements: 6,
    });
    expect((body["payload"] as Record<string, unknown>)["schemaVersion"]).toBe(
      "candidate-profile/v2",
    );
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      const rows = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("returns per-field issues for an invalid document", async () => {
    const bad = {
      ...(pmMaster as Record<string, unknown>),
      identity: { fullName: "" },
      employment: [
        {
          id: "bad-job",
          company: "Acme",
          role: "PM",
          startDate: "not-a-date",
          isCurrent: false,
        },
      ],
    };
    const response = await parseRoute(postRequest("/api/settings/master-resume/parse", { content: bad }));
    expect(response.status).toBe(422);
    const body = await readJson(response);
    expect(body["ok"]).toBe(false);
    const issues = body["issues"] as Array<{ path: Array<string | number>; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path.join(".") === "identity.fullName")).toBe(true);
    expect(
      issues.some((issue) => issue.path.join(".") === "employment.0.startDate"),
    ).toBe(true);
  });
});

describe("selected-version exports (C2)", () => {
  it("exports recorded JSON bytes verbatim and renders Markdown", async () => {
    // The shipped example covers every section, unlike the PM fixture.
    const example = JSON.parse(
      readFileSync(join(process.cwd(), "public", "examples", "master-resume.json"), "utf8"),
    ) as Record<string, unknown>;
    const pmId = await createProfileId("pm", "Product Manager");
    const uploaded = await uploadMaster(example, pmId);
    const versionId = String(uploaded["versionId"]);

    const json = await exportRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}/export?format=json`),
      versionParams(pmId, versionId),
    );
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toContain("master-product-manager-v1.json");
    const exported = JSON.parse(await json.text()) as Record<string, unknown>;
    expect(exported["identity"]).toEqual(example["identity"]);

    const md = await exportRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}/export?format=md`),
      versionParams(pmId, versionId),
    );
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const markdown = await md.text();
    for (const section of ["Summary", "Experience", "Skills", "Languages", "Education", "Credentials"]) {
      expect(markdown).toContain(`## ${section}`);
    }
    expect(markdown).not.toContain("Reconstructed from the stored version payload");
  });

  it("labels reconstructed exports when no source bytes are recorded", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    const versionId = "11111111-1111-4000-8000-111111111111";
    try {
      const payload = { ...(pmMaster as Record<string, unknown>), schemaVersion: "candidate-profile/v2" };
      handle.sqlite
        .prepare(
          "INSERT INTO candidate_profile_versions (id, profile_id, version, payload_json, payload_hash, schema_version) VALUES (?, ?, 1, ?, 'hash', 'candidate-profile/v2')",
        )
        .run(versionId, pmId, JSON.stringify(payload));
    } finally {
      handle.close();
    }
    const json = await exportRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}/export?format=json`),
      versionParams(pmId, versionId),
    );
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toContain("-reconstructed.json");
    expect(json.headers.get("x-export-note")).toBe("reconstructed-from-payload");

    const md = await exportRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}/export?format=md`),
      versionParams(pmId, versionId),
    );
    expect(md.status).toBe(200);
    expect(await md.text()).toContain("Reconstructed from the stored version payload");
  });

  it("rejects cross-profile exports and unknown formats", async () => {
    const pmId = await createProfileId("pm", "Product Manager");
    const spmId = await createProfileId("spm", "Senior Product Manager");
    const uploaded = await uploadMaster(pmMaster, pmId);
    const versionId = String(uploaded["versionId"]);
    const crossed = await exportRoute(
      getRequest(`/api/settings/profiles/${spmId}/versions/${versionId}/export?format=json`),
      versionParams(spmId, versionId),
    );
    expect(crossed.status).toBe(404);
    const badFormat = await exportRoute(
      getRequest(`/api/settings/profiles/${pmId}/versions/${versionId}/export?format=pdf`),
      versionParams(pmId, versionId),
    );
    expect(badFormat.status).toBe(400);
  });
});
