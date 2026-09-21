import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocxParagraphs, loadDocxTemplateBytes, renderDocx } from "../../../src/resumes/docx";
import { extractPdfText } from "../../../src/resumes/pdf";
import { buildViewModel, type ResumeViewModel } from "../../../src/resumes/viewModel";

/**
 * Release 1.2 acceptance fixtures (WO-1.2-A). Deterministic synthetic
 * inputs shared by the B–I acceptance specs: the PM / Senior PM import
 * payloads, the JD corpus manifest, and document bytes that are valid
 * by construction — never placeholder bytes. DOCX fixtures render
 * through the trusted product renderer; PDF fixtures are minimal but
 * structurally complete files verified with the product PDF parser.
 */

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures", "v1.2");

export interface V12ProfileFixture {
  identity: {
    fullName: string;
    headline?: string;
    email?: string;
    phone?: string;
    location?: string;
  };
  summary?: string;
  employment: Array<{
    id: string;
    company: string;
    role: string;
    location?: string;
    startDate: string;
    endDate?: string;
    isCurrent: boolean;
  }>;
  achievements: Array<{ factId: string; employmentId?: string; text: string }>;
  skills: Array<{ name: string; category?: string }>;
  education: Array<{
    degree: string;
    fieldOfStudy?: string;
    institution: string;
    endDate?: string;
  }>;
}

export function loadV12Profile(name: "pm-profile.json" | "spm-profile.json"): V12ProfileFixture {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), "utf8")) as V12ProfileFixture;
}

/** Map an import-shaped fixture to the canonical view-model input. */
export function v12ProfileViewModel(fixture: V12ProfileFixture): ResumeViewModel {
  const skillGroups = new Map<string, string[]>();
  for (const skill of fixture.skills) {
    const group = skillGroups.get(skill.category ?? "General") ?? [];
    group.push(skill.name);
    skillGroups.set(skill.category ?? "General", group);
  }
  return buildViewModel({
    profile: {
      full_name: fixture.identity.fullName,
      location: fixture.identity.location ?? "",
      phone: fixture.identity.phone ?? "",
      email: fixture.identity.email ?? "",
      work_experience: fixture.employment.map((entry) => ({
        id: entry.id,
        company: entry.company,
        role: entry.role,
        location: entry.location ?? "",
        start_date: entry.startDate,
        end_date: entry.endDate ?? null,
        is_current: entry.isCurrent,
      })),
      education: fixture.education.map((entry) => ({
        degree: entry.degree,
        field_of_study: entry.fieldOfStudy ?? "",
        institution: entry.institution,
        end_date: entry.endDate ?? "",
      })),
    },
    draft: {
      claims: [
        ...(fixture.summary === undefined
          ? []
          : [{ section: "summary", text: fixture.summary }]),
        ...fixture.achievements.map((achievement) => ({
          section: "experience",
          entity_id: achievement.employmentId ?? "",
          text: achievement.text,
          fact_ids: [achievement.factId],
        })),
      ],
    },
    skillRows: [...skillGroups.entries()].map(([label, terms]) => ({ label, terms })),
  });
}

/** Render the PM fixture through the trusted DOCX renderer. */
export function renderV12DocxFixture(): Buffer {
  return renderDocx(v12ProfileViewModel(loadV12Profile("pm-profile.json")), loadDocxTemplateBytes());
}

/** Paragraph texts of a DOCX fixture (parity-proof extraction). */
export function v12DocxParagraphs(docxBytes: Buffer): string[] {
  return extractDocxParagraphs(docxBytes);
}

function escapePdfText(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Build a minimal single-page PDF carrying the given lines. Hand-built
 * but structurally complete (catalog, pages, font, content stream,
 * cross-reference table, trailer), so the product PDF parser reads it
 * exactly like a rendered artifact.
 */
export function renderV12PdfFixture(lines: string[]): Buffer {
  const textOps = lines
    .map((line, index) => `${index === 0 ? "" : "0 -18 Td "}(${escapePdfText(line)}) Tj`)
    .join(" ");
  const stream = `BT /F1 12 Tf 72 720 Td ${textOps} ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(stream, "utf8")} >> stream\n${stream}\nendstream endobj`,
  ];
  const header = "%PDF-1.4\n";
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${object}\n`;
  }
  const xrefAt = Buffer.byteLength(body, "utf8");
  const entries = ["0000000000 65535 f ", ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)];
  body += `xref\n0 ${entries.length}\n${entries.join("\n")}\n`;
  body += `trailer << /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

/** Extract text from a PDF fixture with the product parser. */
export async function v12PdfText(pdfBytes: Buffer): Promise<{ pageCount: number; text: string }> {
  return extractPdfText(pdfBytes);
}
