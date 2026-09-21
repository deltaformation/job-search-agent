// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { resolveMigrationsDir } from "../../../src/db/testing";
import { ensureDataRoot, resolveDataRoot } from "../../../src/security/data-root";
import { createBackupArchive, parseAndVerifyArchive } from "../../../src/server/backup";
import { GET as backupGET } from "../../../app/api/backup/route";
import { POST as restorePOST } from "../../../app/api/restore/route";
import { POST as resetPOST } from "../../../app/api/jobs/reset/route";
import { GET as settingsGET } from "../../../app/api/settings/route";
import { POST as modelPOST } from "../../../app/api/settings/model/route";
import { POST as aiTestPOST } from "../../../app/api/settings/ai-test/route";

const tempDirs: string[] = [];
const handles: DatabaseHandle[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const key of ["APP_DATA_ROOT", "CANDIDATE_DIR", "SETTINGS_ENV_FILE"] as const) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function makeRoot(): { root: string; candidateDir: string; envFile: string } {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-data-routes-test-"));
  tempDirs.push(root);
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  ensureDataRoot(paths);
  const handle = openDatabase({ path: paths.databasePath });
  handles.push(handle);
  migrate(handle.sqlite, { migrationsDir: resolveMigrationsDir() });
  handle.sqlite
    .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-1', 'NEW', 0, 1)")
    .run();
  writeFileSync(join(paths.evidenceDir, "page"), "<html>raw</html>");
  const candidateDir = join(root, "candidate");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
  const envFile = join(root, ".env.local");
  process.env.APP_DATA_ROOT = root;
  process.env.CANDIDATE_DIR = candidateDir;
  process.env.SETTINGS_ENV_FILE = envFile;
  delete process.env.PORT;
  delete process.env.OPENROUTER_API_KEY;
  return { root, candidateDir, envFile };
}

function localGet(path: string, host = "127.0.0.1:3000"): Request {
  return new Request(`http://${host}${path}`, { headers: { host } });
}

function localPost(path: string, init: RequestInit = {}, host = "127.0.0.1:3000"): Request {
  return new Request(`http://${host}${path}`, {
    method: "POST",
    ...init,
    headers: {
      host,
      origin: `http://${host}`,
      ...(init.headers ?? {}),
    },
  });
}

function jobCount(root: string): number {
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  const handle = openDatabase({ path: paths.databasePath });
  try {
    return (
      handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
    ).count;
  } finally {
    handle.close();
  }
}

describe("GET /api/backup", () => {
  it("streams a verifiable .tar.gz download", async () => {
    const { root } = makeRoot();
    const response = await backupGET(localGet("/api/backup"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="job-tracker-backup-.*\.tar\.gz"$/);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const verified = parseAndVerifyArchive(bytes);
    expect(verified.manifest.kind).toBe("manual");
    expect(verified.manifest.counts.jobs).toBe(1);
    expect(jobCount(root)).toBe(1);
  });

  it("rejects a rebinding host", async () => {
    makeRoot();
    const response = await backupGET(localGet("/api/backup", "evil.example:3000"));
    expect(response.status).toBe(403);
  });
});

describe("POST /api/jobs/reset", () => {
  it("requires the RESET confirmation literal", async () => {
    const { root } = makeRoot();
    const response = await resetPOST(
      localPost("/api/jobs/reset", {
        body: JSON.stringify({ confirm: "yes" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
    expect(jobCount(root)).toBe(1);
  });

  it("clears jobs, keeps the candidate dir, and writes a pre-reset backup", async () => {
    const { root, candidateDir } = makeRoot();
    const response = await resetPOST(
      localPost("/api/jobs/reset", {
        body: JSON.stringify({ confirm: "RESET" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deletedJobs: number;
      preResetBackup: string;
      preservedProfile: boolean;
    };
    expect(body.deletedJobs).toBe(1);
    expect(body.preservedProfile).toBe(false);
    expect(existsSync(join(root, "backups", body.preResetBackup))).toBe(true);
    expect(jobCount(root)).toBe(0);
    expect(readFileSync(join(candidateDir, "master-resume.json"), "utf8")).toBe('{"v":1}');
  });
});

describe("POST /api/restore", () => {
  it("refuses a corrupt archive without touching the live tree", async () => {
    const { root } = makeRoot();
    const form = new FormData();
    form.append("archive", new File(["corrupt"], "bad.tar.gz"));
    const response = await restorePOST(localPost("/api/restore", { body: form }));
    expect(response.status).toBe(400);
    expect(jobCount(root)).toBe(1);
  });

  it("round-trips a backup through the HTTP layer", async () => {
    const { root, candidateDir } = makeRoot();
    const paths = resolveDataRoot({ APP_DATA_ROOT: root });
    const handle = openDatabase({ path: paths.databasePath });
    handles.push(handle);
    const backup = await createBackupArchive({
      handle,
      paths,
      candidateDir,
      stagingDir: join(root, "staging"),
      kind: "manual",
      now: new Date("2026-09-12T09:00:00.000Z"),
    });
    handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-2', 'NEW', 1, 1)")
      .run();
    expect(jobCount(root)).toBe(2);
    const form = new FormData();
    form.append("archive", new File([new Uint8Array(backup.bytes)], backup.filename));
    const response = await restorePOST(localPost("/api/restore", { body: form }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: number; preRestoreBackup: string };
    expect(body.jobs).toBe(1);
    expect(existsSync(join(root, "backups", body.preRestoreBackup))).toBe(true);
    expect(jobCount(root)).toBe(1);
  });
});

describe("GET /api/settings", () => {
  it("returns the snapshot without secrets", async () => {
    makeRoot();
    const response = await settingsGET(localGet("/api/settings"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: { primary: string; fallback: string };
      openRouter: { configured: boolean };
      profile: null;
      storage: { jobCount: number };
    };
    expect(body.models.primary).toBe("google/gemma-4-26b-a4b-it:free");
    expect(body.openRouter.configured).toBe(false);
    expect(body.profile).toBeNull();
    expect(body.storage.jobCount).toBe(1);
  });
});

describe("POST /api/settings/model", () => {
  it("switches the model chain in the env file", async () => {
    const { envFile } = makeRoot();
    const response = await modelPOST(
      localPost("/api/settings/model", {
        body: JSON.stringify({ primary: "model-a" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { primary: string; restartRequired: boolean };
    expect(body.primary).toBe("model-a");
    expect(body.restartRequired).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("OPENROUTER_MODEL=model-a");
  });
});

describe("POST /api/settings/ai-test", () => {
  it("reports unconfigured as a diagnostic 200", async () => {
    makeRoot();
    const response = await aiTestPOST(localPost("/api/settings/ai-test"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error: string; reasonCode: string };
    expect(body.ok).toBe(false);
    expect(body.reasonCode).toBe("missing-key");
    expect(body.error).toContain("OPENROUTER_API_KEY is not configured");
  });

  it("pings the selected provider and validates the body", async () => {
    makeRoot();
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedMeta = process.env.META_API_KEY;
    const savedActive = process.env.ACTIVE_AI_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    delete process.env.META_API_KEY;
    delete process.env.ACTIVE_AI_PROVIDER;
    try {
      const google = await aiTestPOST(
        localPost("/api/settings/ai-test", {
          body: JSON.stringify({ provider: "google" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(google.status).toBe(200);
      expect((await google.json()) as { error: string }).toMatchObject({
        ok: false,
        reasonCode: "missing-key",
      });
      const emptyObject = await aiTestPOST(
        localPost("/api/settings/ai-test", {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(emptyObject.status).toBe(200);
      expect((await emptyObject.json()) as { error: string }).toMatchObject({
        ok: false,
        reasonCode: "missing-key",
      });
      const unknown = await aiTestPOST(
        localPost("/api/settings/ai-test", {
          body: JSON.stringify({ provider: "nope" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(unknown.status).toBe(400);
      const malformed = await aiTestPOST(
        localPost("/api/settings/ai-test", {
          body: "{oops",
          headers: { "content-type": "application/json" },
        }),
      );
      expect(malformed.status).toBe(400);
    } finally {
      if (savedGemini === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = savedGemini;
      }
      if (savedMeta === undefined) {
        delete process.env.META_API_KEY;
      } else {
        process.env.META_API_KEY = savedMeta;
      }
      if (savedActive === undefined) {
        delete process.env.ACTIVE_AI_PROVIDER;
      } else {
        process.env.ACTIVE_AI_PROVIDER = savedActive;
      }
    }
  });
});
