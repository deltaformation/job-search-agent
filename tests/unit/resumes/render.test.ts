// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeArtifacts,
  normalizeJobKey,
  reserveArtifactStem,
} from "../../../src/resumes/artifacts";
import {
  MIN_PDF_TEXT_CHARS,
  assertMinExtractableText,
  assertPageBudget,
  assertProjectionContains,
  htmlBodyFragments,
} from "../../../src/resumes/checks";
import { RESUME_CONFIG } from "../../../src/resumes/config";
import {
  DOCX_MEDIA_TYPE,
  docxTemplateHash,
  extractDocxParagraphs,
  loadDocxTemplateBytes,
  renderDocx,
} from "../../../src/resumes/docx";
import { renderMarkdown } from "../../../src/resumes/markdown";
import {
  allowedTemplateIds,
  getTemplate,
  renderHtml,
  templateInfo,
} from "../../../src/resumes/template";
import { buildViewModel, type ResumeViewModel } from "../../../src/resumes/viewModel";

/** Renderer, template-trust, artifact, and QA-check tests (M8 ports + new). */
function fixtureModel(): ResumeViewModel {
  const suite = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "parity", "view-model.json"), "utf8"),
  ) as { cases: Array<{ id: string; input: { profile: unknown; draft: unknown } }> };
  const ordering = suite.cases.find((entry) => entry.id === "vm-ordering");
  if (!ordering) {
    throw new Error("vm-ordering fixture case missing");
  }
  return buildViewModel({ profile: ordering.input.profile, draft: ordering.input.draft });
}

function hostileModel(): ResumeViewModel {
  return buildViewModel({
    profile: {
      full_name: "<img src=x onerror=alert(1)>",
      email: "a@b.c",
      phone: "1",
      location: "Toronto",
      preferences: { linkedin_url: "javascript:alert(document.domain)" },
      work_experience: [
        {
          id: "exp_1",
          company: "Acme",
          role: "PM",
          location: "Toronto",
          start_date: "2020-01-01",
          end_date: null,
          is_current: true,
        },
      ],
      verified_facts: [
        {
          fact_id: "fact_9",
          work_experience_id: "exp_1",
          text: 'Did <b>great</b> "quoted" things.',
          technologies: [],
          metrics: [],
          verification_status: "approved",
        },
      ],
      skills: [],
      education: [],
    },
    draft: {
      claims: [
        {
          section: "experience",
          entity_id: "exp_1",
          text: 'Did <b>great</b> "quoted" things.',
          fact_ids: ["fact_9"],
        },
      ],
    },
  });
}

describe("trusted template registry", () => {
  it("rejects unknown and traversal template ids", () => {
    expect(() => getTemplate("attacker_template")).toThrow("Unknown resume template");
    expect(() => getTemplate("../config/jobs")).toThrow("Unknown resume template");
    expect(allowedTemplateIds()).toEqual(["mouad_standard_v1"]);
  });

  it("exposes stable template lineage", () => {
    const first = getTemplate("mouad_standard_v1");
    const second = getTemplate("mouad_standard_v1");
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    const info = templateInfo();
    expect(info.template_id).toBe("mouad_standard_v1");
    expect(info.template_version).toBe("v1");
    expect(info.template_hash).toBe(first.digest);
    expect(info.render_schema_version).toBe("v1");
  });

  it("pins the reviewed stylesheet bytes", () => {
    const html = renderHtml(fixtureModel());
    const css = html.split("<style>")[1]?.split("</style>")[0].replace(/^\n|\n$/g, "");
    expect(createHash("sha256").update(css ?? "", "utf8").digest("hex")).toBe(
      "250572e9e8803180b8c1df7a9a402ddad14bcc20c23f577873d980b1a749e2f2",
    );
  });
});

describe("HTML renderer", () => {
  it("carries no editor/runtime artifacts and keeps the reviewed design", () => {
    const html = renderHtml(fixtureModel());
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain("<script");
    expect(lowered).not.toContain("contenteditable");
    expect(lowered).not.toContain("toolbar");
    expect(html).not.toContain("codex-browser-sidebar-comments-root");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("size: Letter 8.5in 11in");
    expect(html).toContain("#213c6b");
  });

  it("escapes hostile profile and claim text", () => {
    const html = renderHtml(hostileModel());
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<b>great</b>");
    expect(html).toContain("&#34;quoted&#34;");
  });

  it("renders javascript: link targets as inert text", () => {
    const html = renderHtml(hostileModel());
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("href='javascript:");
    expect(html).toContain("javascript:alert(document.domain)");
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('href="tel:1"');
  });

  it("omits empty sections without stray headings", () => {
    const html = renderHtml(
      buildViewModel({ profile: { full_name: "Solo" }, draft: { claims: [] } }),
    );
    expect(html).toContain("Solo");
    expect(html).not.toContain("Professional Experience");
    expect(html).not.toContain("Skills");
  });
});

describe("Markdown renderer", () => {
  it("projects sections in canonical order", () => {
    const text = renderMarkdown(fixtureModel());
    const order = [
      "# Parity Test Candidate",
      "Toronto, ON | +1-555-0100 | parity@example.com",
      "## Summary",
      "Senior summary line.",
      "## Professional Experience",
      "**Northwind Labs** | Mar 2021 - Present",
      "- Built a public REST API",
      "## Skills",
      "**Core Competencies:** Python, PostgreSQL",
      "## Education",
      "- B.Sc. in Computer Science, Test University (2018-05-31)",
    ];
    let cursor = 0;
    for (const needle of order) {
      const index = text.indexOf(needle, cursor);
      expect(index).toBeGreaterThanOrEqual(cursor);
      cursor = index + needle.length;
    }
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("DOCX renderer", () => {
  it("regenerates the checked-in template binary byte-for-byte", async () => {
    // @ts-expect-error - generator script is untyped JS by design
    const script = (await import("../../../../scripts/build-docx-template.mjs")) as {
      buildTemplateBytes: () => Buffer;
    };
    expect(Buffer.compare(loadDocxTemplateBytes(), script.buildTemplateBytes())).toBe(0);
  });

  it("renders and extracts the full resume text", () => {
    const bytes = renderDocx(fixtureModel(), loadDocxTemplateBytes());
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const paragraphs = extractDocxParagraphs(bytes);
    const joined = paragraphs.join("\n");
    expect(joined).toContain("Parity Test Candidate");
    expect(joined).toContain("Built a public REST API serving 10M daily requests");
    expect(joined).toContain("Core Competencies: Python, PostgreSQL");
    expect(joined).toContain("B.Sc. in Computer Science, Test University (2018-05-31)");
    expect(joined).not.toContain("{");
  });

  it("keeps hostile text literal without breaking document structure", () => {
    const bytes = renderDocx(hostileModel(), loadDocxTemplateBytes());
    const joined = extractDocxParagraphs(bytes).join("\n");
    expect(joined).toContain("<img src=x onerror=alert(1)>");
    expect(joined).toContain('Did <b>great</b> "quoted" things.');
  });

  it("hashes the template stably for lineage", () => {
    const bytes = loadDocxTemplateBytes();
    expect(docxTemplateHash(bytes)).toMatch(/^[a-f0-9]{64}$/);
    expect(docxTemplateHash(bytes)).toBe(
      "7846785cf836cbfa6cf29271fe6c66dad46a4ca7271a5c06465420d4ae14042f",
    );
  });
});

describe("artifact metadata", () => {
  const inputs = () => ({
    jobKey: "123E4567-E89B-12D3-A456-426614174000",
    versionNumber: 2,
    contentHash: "a".repeat(64),
    markdown: Buffer.from("# Resume\n"),
    docx: Buffer.from("PK-docx"),
    pdf: Buffer.from("%PDF-bytes"),
  });

  it("describes the complete Markdown/DOCX/PDF set", () => {
    const set = describeArtifacts(inputs());
    expect(set.stem).toBe("v2_aaaaaaaa");
    expect(set.records.map((record) => record.kind)).toEqual(["MARKDOWN", "DOCX", "PDF"]);
    expect(set.records[0]?.relativePath).toBe(
      "resumes/123e4567-e89b-12d3-a456-426614174000/v2_aaaaaaaa.md",
    );
    expect(set.records[1]?.mediaType).toBe(DOCX_MEDIA_TYPE);
    expect(set.records[2]?.mediaType).toBe("application/pdf");
    expect(set.records[0]?.byteSize).toBe(inputs().markdown.length);
    expect(set.records[0]?.sha256).toBe(
      createHash("sha256").update(inputs().markdown).digest("hex"),
    );
  });

  it("rejects hostile job keys, versions, and hashes", () => {
    expect(() => normalizeJobKey("../escape")).toThrow("Invalid job key");
    expect(() => normalizeJobKey("not-a-uuid")).toThrow("Invalid job key");
    expect(() => reserveArtifactStem(0, "a".repeat(64))).toThrow("Invalid version number");
    expect(() => reserveArtifactStem(1, "short")).toThrow("Invalid content hash");
    expect(() => describeArtifacts({ ...inputs(), jobKey: "x" })).toThrow("Invalid job key");
  });

  it("keeps presentation budgets at oracle values", () => {
    expect(RESUME_CONFIG.pageBudget).toBe(2);
    expect(RESUME_CONFIG.maxExperienceBullets).toBe(5);
    expect(RESUME_CONFIG.maxPriorRoleBullets).toBe(3);
    expect(RESUME_CONFIG.maxTotalBullets).toBe(14);
    expect(RESUME_CONFIG.maxDetailedRoles).toBe(3);
    expect(RESUME_CONFIG.variantsEnabled).toBe(false);
  });
});

describe("projection checks", () => {
  it("extracts body fragments without style content", () => {
    const fragments = htmlBodyFragments(renderHtml(fixtureModel()));
    expect(fragments).toContain("Parity Test Candidate");
    expect(fragments).toContain("Senior summary line.");
    expect(fragments.some((fragment) => fragment.includes("#213c6b"))).toBe(false);
    expect(fragments.some((fragment) => fragment.includes("font-size"))).toBe(false);
  });

  it("detects a missing fragment with a labeled error", () => {
    expect(() => assertProjectionContains(["Absent requirement text"], "Some resume", "PDF")).toThrow(
      'PDF is missing expected resume text: "Absent requirement text".',
    );
    expect(() => assertProjectionContains(["some  RESUME"], "Some resume", "PDF")).not.toThrow();
  });

  it("enforces the page budget and minimum text", () => {
    expect(() => assertPageBudget(2)).not.toThrow();
    expect(() => assertPageBudget(3)).toThrow("exceeds page budget: 3 pages");
    expect(() => assertPageBudget(0)).toThrow("exceeds page budget: 0 pages");
    expect(() => assertMinExtractableText("x".repeat(MIN_PDF_TEXT_CHARS))).not.toThrow();
    expect(() => assertMinExtractableText("short")).toThrow("insufficient extractable text");
  });
});
