// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CandidateImportV1 } from "../../../src/domain/candidate";

function loadFixture(): unknown {
  const path = join(process.cwd(), "tests", "fixtures", "candidate", "master-resume.v1.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function validDocument(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(loadFixture())) as Record<string, unknown>;
}

describe("CandidateImportV1", () => {
  it("accepts the reviewed seed conversion fixture", () => {
    const parsed = CandidateImportV1.parse(loadFixture());
    expect(parsed.schemaVersion).toBe("candidate-import/v1");
    expect(parsed.achievements.map((entry) => entry.factId)).toEqual([
      "fact_001",
      "fact_002",
      "fact_003",
      "fact_004",
      "fact_005",
      "fact_006",
    ]);
    expect(parsed.employment).toHaveLength(3);
  });

  it("defaults verification to PENDING and collections to empty", () => {
    const parsed = CandidateImportV1.parse({
      schemaVersion: "candidate-import/v1",
      identity: { fullName: "Test Candidate" },
      achievements: [{ factId: "fact_x", category: "c", text: "did a thing" }],
    });
    expect(parsed.achievements[0].verification).toBe("PENDING");
    expect(parsed.employment).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });

  it("rejects unknown top-level and nested keys", () => {
    const withExtra = { ...validDocument(), preferences: {} };
    expect(() => CandidateImportV1.parse(withExtra)).toThrow(z.ZodError);
    const nested = validDocument();
    (nested.identity as Record<string, unknown>).nickname = "x";
    expect(() => CandidateImportV1.parse(nested)).toThrow(z.ZodError);
  });

  it("rejects duplicate fact_id values and dangling employment references", () => {
    const duplicate = validDocument();
    (duplicate.achievements as Array<Record<string, unknown>>).push({
      factId: "fact_001",
      category: "c",
      text: "copy",
    });
    expect(() => CandidateImportV1.parse(duplicate)).toThrow(/fact_id values must be unique/);
    const dangling = validDocument();
    ((dangling.achievements as Array<Record<string, unknown>>)[0] as Record<string, unknown>).employmentId =
      "emp-missing";
    expect(() => CandidateImportV1.parse(dangling)).toThrow(/unknown employment/);
  });

  it("rejects malformed fact_id values", () => {
    const bad = validDocument();
    ((bad.achievements as Array<Record<string, unknown>>)[0] as Record<string, unknown>).factId =
      "fact 001!";
    expect(() => CandidateImportV1.parse(bad)).toThrow(z.ZodError);
  });

  it("rejects impossible dates and inconsistent employment ranges", () => {
    const badDate = validDocument();
    ((badDate.employment as Array<Record<string, unknown>>)[0] as Record<string, unknown>).startDate =
      "2021-02-30";
    expect(() => CandidateImportV1.parse(badDate)).toThrow(z.ZodError);
    const currentWithEnd = validDocument();
    ((currentWithEnd.employment as Array<Record<string, unknown>>)[0] as Record<string, unknown>).endDate =
      "2024-01-01";
    expect(() => CandidateImportV1.parse(currentWithEnd)).toThrow(
      /current employment must not set endDate/,
    );
    const pastWithoutEnd = validDocument();
    delete ((pastWithoutEnd.employment as Array<Record<string, unknown>>)[1] as Record<string, unknown>)
      .endDate;
    expect(() => CandidateImportV1.parse(pastWithoutEnd)).toThrow(/past employment requires endDate/);
  });

  it("rejects uncontrolled skill proficiency and bad emails", () => {
    const badSkill = validDocument();
    ((badSkill.skills as Array<Record<string, unknown>>)[0] as Record<string, unknown>).proficiency =
      "advanced";
    expect(() => CandidateImportV1.parse(badSkill)).toThrow(z.ZodError);
    const badEmail = validDocument();
    (badEmail.identity as Record<string, unknown>).email = "not-an-email";
    expect(() => CandidateImportV1.parse(badEmail)).toThrow(z.ZodError);
  });

  it("accepts a profile with no achievements", () => {
    const parsed = CandidateImportV1.parse({
      schemaVersion: "candidate-import/v1",
      identity: { fullName: "Skills Only" },
      skills: [{ name: "Typing", verified: true }],
    });
    expect(parsed.achievements).toEqual([]);
  });
});
