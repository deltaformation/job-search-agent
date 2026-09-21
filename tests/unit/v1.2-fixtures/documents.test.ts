// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CandidateImportV1 } from "../../../src/domain/candidate";
import {
  loadV12Profile,
  renderV12DocxFixture,
  renderV12PdfFixture,
  v12DocxParagraphs,
  v12PdfText,
} from "../../fixtures/v1.2/documents";

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures", "v1.2");

describe("v1.2 profile fixtures", () => {
  it("validate as candidate-import/v1 with disjoint fact ids", () => {
    const pm = CandidateImportV1.parse(
      JSON.parse(readFileSync(join(FIXTURE_ROOT, "pm-profile.json"), "utf8")) as unknown,
    );
    const spm = CandidateImportV1.parse(
      JSON.parse(readFileSync(join(FIXTURE_ROOT, "spm-profile.json"), "utf8")) as unknown,
    );
    const pmIds = new Set(pm.achievements.map((entry) => entry.factId));
    const spmIds = new Set(spm.achievements.map((entry) => entry.factId));
    expect([...pmIds].some((id) => spmIds.has(id))).toBe(false);
  });

  it("share identical career-history statements across profiles (R-ADR-020 copies)", () => {
    const pm = loadV12Profile("pm-profile.json");
    const spm = loadV12Profile("spm-profile.json");
    const spmTexts = new Set(spm.achievements.map((entry) => entry.text));
    const shared = pm.achievements.filter((entry) => spmTexts.has(entry.text));
    expect(shared).toHaveLength(3);
    expect(pm.achievements).toHaveLength(6);
    expect(spm.achievements).toHaveLength(6);
  });
});

describe("v1.2 JD fixtures", () => {
  it("manifest cases resolve to files with documented content", () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, "jd", "keywords.json"), "utf8"),
    ) as {
      version: string;
      cases: Record<string, { file: string; mustInclude: string[] }>;
    };
    expect(manifest.version).toBe("v1.2-jd-fixtures/v1");
    expect(Object.keys(manifest.cases).sort()).toEqual([
      "empty",
      "engineering",
      "pm-rich",
      "sales-business",
      "senior-pm",
      "sparse",
    ]);
    for (const entry of Object.values(manifest.cases)) {
      const text = readFileSync(join(FIXTURE_ROOT, "jd", entry.file), "utf8");
      for (const phrase of entry.mustInclude) {
        expect(text.toLowerCase()).toContain(phrase.toLowerCase());
      }
    }
    const pmRich = readFileSync(join(FIXTURE_ROOT, "jd", "pm-rich.txt"), "utf8");
    expect(pmRich).toContain("go-to-market");
  });
});

describe("v1.2 document fixtures", () => {
  it("renders a valid DOCX through the trusted renderer", () => {
    const bytes = renderV12DocxFixture();
    expect(bytes.subarray(0, 2).toString("binary")).toBe("PK");
    const paragraphs = v12DocxParagraphs(bytes);
    const joined = paragraphs.join("\n");
    expect(joined).toContain("Jordan Lee");
    expect(joined).toContain("trial-to-paid conversion by 18%");
  });

  it("builds a minimal PDF the product parser reads", async () => {
    const bytes = renderV12PdfFixture(["Jordan Lee", "Product Manager"]);
    expect(bytes.subarray(0, 4).toString("utf8")).toBe("%PDF");
    const parsed = await v12PdfText(bytes);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.text).toContain("Jordan Lee");
    expect(parsed.text).toContain("Product Manager");
  });
});
