// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeImportDocument,
  type StoredProfilePayload,
} from "../../../src/domain/candidate";
import {
  MASTER_PREVIEW_SECTIONS,
  renderMasterMarkdown,
  summarizeMasterPayload,
} from "../../../src/domain/master-preview";

/**
 * WO-1.2-C: the downloadable example is schema-valid, the Markdown
 * renderer is deterministic, and every stored section is projected.
 */

function examplePayload(): StoredProfilePayload {
  const document = JSON.parse(
    readFileSync(join(process.cwd(), "public", "examples", "master-resume.json"), "utf8"),
  ) as unknown;
  return normalizeImportDocument(document).payload;
}

describe("master preview projections", () => {
  it("ships a valid downloadable example covering every section", () => {
    const document = JSON.parse(
      readFileSync(join(process.cwd(), "public", "examples", "master-resume.json"), "utf8"),
    ) as unknown;
    const normalized = normalizeImportDocument(document);
    expect(normalized.importVersion).toBe(2);
    const summary = summarizeMasterPayload(normalized.payload);
    expect(summary).toMatchObject({
      employments: 2,
      achievements: 3,
      skills: 3,
      languages: 2,
      education: 1,
      credentials: 1,
      hasLinks: true,
      hasSummary: true,
    });
  });

  it("renders every section deterministically", () => {
    const payload = examplePayload();
    const meta = { profileDisplayName: "Example PM", version: 1, reconstructed: false };
    const first = renderMasterMarkdown(payload, meta);
    const second = renderMasterMarkdown(payload, meta);
    expect(second).toBe(first);
    for (const section of MASTER_PREVIEW_SECTIONS) {
      expect(first).toContain(`## ${section}`);
    }
    expect(first).toContain("Alex Rivera");
    expect(first).toContain("linkedin");
    expect(first).toContain("example-launch-001");
    expect(first).toContain("B.Sc. Computer Science");
    expect(first).toContain("Example Product Certificate");
    expect(first).toContain("English");
    expect(first).not.toContain("Reconstructed from the stored version payload");
  });

  it("labels reconstructed exports and explains omissions", () => {
    const markdown = renderMasterMarkdown(examplePayload(), {
      profileDisplayName: "Example PM",
      version: 2,
      reconstructed: true,
    });
    expect(markdown).toContain("Reconstructed from the stored version payload");
    expect(markdown).toContain("Projection note:");
  });

  it("omits empty sections without inventing content", () => {
    const payload: StoredProfilePayload = {
      schemaVersion: "candidate-profile/v2",
      identity: { fullName: "Sam Minimal" },
      targetTitles: [],
      targetLocations: [],
      employment: [],
      achievements: [],
      skills: [],
      languages: [],
      education: [],
      credentials: [],
    };
    const markdown = renderMasterMarkdown(payload, {
      profileDisplayName: "Minimal",
      version: 1,
      reconstructed: false,
    });
    expect(markdown).toContain("# Sam Minimal");
    for (const section of MASTER_PREVIEW_SECTIONS) {
      expect(markdown).not.toContain(`## ${section}`);
    }
  });
});
