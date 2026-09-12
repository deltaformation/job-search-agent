// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractPdfText } from "../../../src/resumes/pdf";

/**
 * PDF text/page extraction without a browser: the test hand-builds a
 * minimal two-page PDF (offsets computed programmatically) so the
 * pdf-parse integration is verified even where Chromium cannot launch.
 */
function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildMinimalPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

describe("PDF text extraction", () => {
  it("reads page count and text from a minimal PDF", async () => {
    const bytes = buildMinimalPdf(["Resume page one", "Second page text"]);
    const result = await extractPdfText(bytes);
    expect(result.pageCount).toBe(2);
    expect(result.text).toContain("Resume page one");
    expect(result.text).toContain("Second page text");
  });

  it("rejects non-PDF bytes", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});
