import { PDFParse } from "pdf-parse";
import type { Browser } from "playwright";

/**
 * PDF renderer over Playwright Chromium (port of
 * `DocumentRenderer.compile_html_to_pdf`, minus artifact publishing which
 * belongs to R4-E orchestration).
 *
 * The page is fully network-isolated: the trusted template carries no
 * external assets, so every request is aborted and any unexpected fetch
 * fails the render instead of leaking or hanging. Page size and margins
 * come from the template's `@page` rule via `preferCSSPageSize`.
 */

export const PDF_MEDIA_TYPE = "application/pdf";

export interface RenderedPdf {
  bytes: Buffer;
}

/** Render standalone trusted HTML to PDF bytes. */
export async function renderPdf(html: string, browser: Browser): Promise<RenderedPdf> {
  const context = await browser.newContext();
  try {
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      return { bytes: Buffer.from(bytes) };
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

export interface PdfText {
  pageCount: number;
  text: string;
}

/** Extract page count and text from PDF bytes (pypdf role in the oracle). */
export async function extractPdfText(pdfBytes: Buffer): Promise<PdfText> {
  const parser = new PDFParse({ data: new Uint8Array(pdfBytes) });
  try {
    const result = await parser.getText();
    return { pageCount: result.total, text: result.text };
  } finally {
    await parser.destroy();
  }
}
