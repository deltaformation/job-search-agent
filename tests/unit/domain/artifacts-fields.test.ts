// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ArtifactMetadata,
  EntityId,
  IsoUtcDateTime,
  RequiredNote,
  RelativeArtifactPath,
  RowVersion,
  Sha256Hex,
  isSafeRelativePath,
  resumeArtifactSetComplete,
} from "../../../src/domain";

describe("scalar fields", () => {
  it("validates entity ids as UUIDs", () => {
    expect(
      EntityId.safeParse("123e4567-e89b-12d3-a456-426614174000").success,
    ).toBe(true);
    expect(EntityId.safeParse("fact_001").success).toBe(false);
    expect(EntityId.safeParse("").success).toBe(false);
  });

  it("requires UTC Z timestamps", () => {
    expect(IsoUtcDateTime.safeParse("2026-09-11T12:00:00.000Z").success).toBe(
      true,
    );
    expect(IsoUtcDateTime.safeParse("2026-09-11T12:00:00").success).toBe(false);
    expect(IsoUtcDateTime.safeParse("2026-09-11T12:00:00+02:00").success).toBe(
      false,
    );
    expect(IsoUtcDateTime.safeParse("2026-13-11T12:00:00Z").success).toBe(false);
  });

  it("requires lowercase hex digests and positive row versions", () => {
    expect(Sha256Hex.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256Hex.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256Hex.safeParse("abc").success).toBe(false);
    expect(RowVersion.safeParse(1).success).toBe(true);
    expect(RowVersion.safeParse(0).success).toBe(false);
    expect(RowVersion.safeParse(1.5).success).toBe(false);
    expect(RequiredNote.safeParse("  padded  ").success).toBe(true);
    expect(RequiredNote.safeParse("   ").success).toBe(false);
  });
});

describe("artifact contracts", () => {
  it("requires the full Markdown/DOCX/PDF set before review", () => {
    expect(resumeArtifactSetComplete(["MARKDOWN", "DOCX", "PDF"])).toBe(true);
    expect(
      resumeArtifactSetComplete(["PDF", "MARKDOWN", "DOCX", "MARKDOWN"]),
    ).toBe(true);
    expect(resumeArtifactSetComplete(["MARKDOWN", "PDF"])).toBe(false);
    expect(resumeArtifactSetComplete([])).toBe(false);
    expect(resumeArtifactSetComplete(["markdown", "docx", "pdf"])).toBe(false);
  });

  it("accepts safe relative artifact paths", () => {
    for (const path of [
      "evidence/abc123.html",
      "artifacts/v1/resume.md",
      "a",
    ]) {
      expect(isSafeRelativePath(path), path).toBe(true);
      expect(RelativeArtifactPath.safeParse(path).success, path).toBe(true);
    }
  });

  it("rejects absolute, traversal, and ambiguous paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:\\Windows\\x",
      "C:/Windows/x",
      "\\\\server\\share",
      "..",
      "../x",
      "a/../b",
      "a//b",
      "./a",
      "a/",
      "a\\b",
      "a\0b",
      `${"a".repeat(1025)}`,
    ]) {
      expect(isSafeRelativePath(path), JSON.stringify(path)).toBe(false);
      expect(
        RelativeArtifactPath.safeParse(path).success,
        JSON.stringify(path),
      ).toBe(false);
    }
  });

  it("validates artifact metadata records", () => {
    expect(
      ArtifactMetadata.safeParse({
        kind: "PDF",
        relativePath: "artifacts/v1/resume.pdf",
        mediaType: "application/pdf",
        byteSize: 1024,
        sha256: "b".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      ArtifactMetadata.safeParse({
        kind: "HTML",
        relativePath: "evidence/x.html",
        mediaType: "text/html",
        byteSize: 0,
        sha256: "c".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      ArtifactMetadata.safeParse({
        kind: "XLSX",
        relativePath: "artifacts/x",
        mediaType: "x",
        byteSize: 1,
        sha256: "d".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      ArtifactMetadata.safeParse({
        kind: "PDF",
        relativePath: "../escape.pdf",
        mediaType: "application/pdf",
        byteSize: 1,
        sha256: "d".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      ArtifactMetadata.safeParse({
        kind: "PDF",
        relativePath: "artifacts/x.pdf",
        mediaType: "application/pdf",
        byteSize: -1,
        sha256: "d".repeat(64),
      }).success,
    ).toBe(false);
  });
});
