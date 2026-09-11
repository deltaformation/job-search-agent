// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLIPPER_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "extensions",
  "clipper",
);

describe("clipper extension package", () => {
  it("ships a valid MV3 manifest without cookie access", () => {
    const manifest = JSON.parse(
      readFileSync(join(CLIPPER_DIR, "manifest.json"), "utf8"),
    ) as {
      manifest_version: number;
      permissions: string[];
      host_permissions: string[];
      background?: { service_worker: string };
      options_page?: string;
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1/*",
        "http://localhost/*",
      ]),
    );
    for (const file of [
      manifest.background?.service_worker,
      manifest.options_page,
      "options.js",
      "README.md",
    ]) {
      expect(file).toBeTypeOf("string");
      expect(existsSync(join(CLIPPER_DIR, file as string))).toBe(true);
    }
  });

  it("keeps the capture function self-contained for tab injection", () => {
    const worker = readFileSync(join(CLIPPER_DIR, "service-worker.js"), "utf8");
    const body = worker.slice(
      worker.indexOf("function captureDom()"),
      worker.indexOf("\n}\n", worker.indexOf("function captureDom()")),
    );
    // executeScript serializes the function source only: any worker-scope
    // identifier referenced here would be undefined inside the tab.
    for (const forbidden of ["chrome", "DEFAULT_BASE_URL", "MAX_", "fetch("]) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain("document.documentElement.outerHTML");
  });
});
