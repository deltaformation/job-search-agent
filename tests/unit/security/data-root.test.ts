// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataRootStatus,
  defaultDataRoot,
  ensureDataRoot,
  resolveDataRoot,
} from "../../../src/security";

describe("data-root configuration", () => {
  it("defaults to data/rebuild with database and storage layout", () => {
    expect(defaultDataRoot("/repo")).toBe(join("/repo", "data", "rebuild"));
    const paths = resolveDataRoot({}, "/repo");
    expect(paths).toEqual({
      root: join("/repo", "data", "rebuild"),
      databasePath: join("/repo", "data", "rebuild", "job-tracker.sqlite"),
      evidenceDir: join("/repo", "data", "rebuild", "evidence"),
      artifactsDir: join("/repo", "data", "rebuild", "artifacts"),
      sourcesDir: join("/repo", "data", "rebuild", "sources"),
    });
  });

  it("honors APP_DATA_ROOT overrides", () => {
    const paths = resolveDataRoot({ APP_DATA_ROOT: "/custom/root" }, "/repo");
    expect(paths.root).toBe("/custom/root");
    expect(paths.databasePath).toBe(join("/custom/root", "job-tracker.sqlite"));
  });

  it("honors DATABASE_PATH overrides for supervised children", () => {
    const paths = resolveDataRoot(
      { APP_DATA_ROOT: "/custom/root", DATABASE_PATH: "/elsewhere/test.sqlite" },
      "/repo",
    );
    expect(paths.root).toBe("/custom/root");
    expect(paths.databasePath).toBe("/elsewhere/test.sqlite");
    // Blank override falls back to the root default.
    expect(
      resolveDataRoot(
        { APP_DATA_ROOT: "/custom/root", DATABASE_PATH: "  " },
        "/repo",
      ).databasePath,
    ).toBe(join("/custom/root", "job-tracker.sqlite"));
  });

  it("creates storage directories idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-root-"));
    try {
      const paths = resolveDataRoot({ APP_DATA_ROOT: join(dir, "nested", "root") });
      ensureDataRoot(paths);
      const status = dataRootStatus(paths);
      expect(status.rootExists).toBe(true);
      expect(status.evidenceExists).toBe(true);
      expect(status.artifactsExists).toBe(true);
      expect(status.databaseExists).toBe(false);
      // Second call changes nothing and throws nothing.
      ensureDataRoot(paths);
      writeFileSync(paths.databasePath, "x");
      expect(dataRootStatus(paths).databaseExists).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing roots without throwing", () => {
    const paths = resolveDataRoot({
      APP_DATA_ROOT: join(tmpdir(), `job-tracker-absent-${Date.now()}`),
    });
    const status = dataRootStatus(paths);
    expect(status.rootExists).toBe(false);
    expect(status.databaseExists).toBe(false);
  });
});
