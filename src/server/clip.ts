import { eq } from "drizzle-orm";
import { parse } from "node-html-parser";
import type { DatabaseHandle } from "../db/client";
import {
  intakeBatches,
  intakeItems,
  jobs,
  jobSources,
} from "../db/schema";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import type { ReasonCode } from "../domain/enums";
import { runExtraction } from "../extraction/extract";
import type { GapField } from "../extraction/types";
import { detectBlock } from "../scraping/blocks";
import {
  ensureFetchShell,
  persistFetchOutcome,
  type PersistArtifactInput,
} from "../scraping/evidence";
import {
  HTML_SIGNAL_CHARS,
  MAX_HTML_BYTES,
  MAX_JSONLD_BLOCK_CHARS,
  MAX_JSONLD_BLOCKS,
  MAX_TEXT_CHARS,
  TEXT_SIGNAL_CHARS,
} from "../scraping/fetch";
import { canonicalizeUrl, detectAtsType } from "../scraping/urls";
import { SCRAPE_PAYLOAD_VERSION, type ScrapePayloadV1 } from "./intake";

/**
 * Direct DOM intake: the human clips a page they are already viewing, so the
 * bytes arrive authenticated past any login/CAPTCHA the headless fetcher
 * could never cross. The clip path reuses the R2-C/R2-D pipeline verbatim —
 * canonical key dedupe, shell lifecycle, block taxonomy, extraction, and
 * content-addressed evidence — with the browser fetch replaced by
 * caller-supplied HTML. No cookies, sessions, or credentials are accepted or
 * stored; the only inputs are the URL and the DOM the user chose to send.
 */

export type ClipSource = "clip" | "paste";

export interface IngestClipInput {
  submittedUrl: string;
  /** Raw outerHTML, bounded by the caller to MAX_HTML_BYTES. */
  html: string;
  title?: string;
  /** User-selected visible text; derived from HTML when omitted. */
  selectedText?: string;
  source: ClipSource;
  evidenceDir: string;
  now?: string;
}

export type IngestClipResult =
  | {
      outcome: "created";
      batchId: string;
      intakeItemId: string;
      jobId: string;
      attemptId: string;
      extractionId: string;
      adapter: string | null;
      confidence: number | null;
      missingFields: GapField[];
    }
  | {
      outcome: "duplicate";
      batchId: string;
      intakeItemId: string;
      jobId: string;
      jobStatus: string;
    }
  | {
      outcome: "rejected";
      batchId: string;
      intakeItemId: string;
      jobId: string | null;
      reasonCode: ReasonCode;
      detail: string;
    };

/** Visible text from clipped HTML: scripts/styles removed, then capped. */
export function clipTextFromHtml(html: string): string {
  let text: string;
  try {
    const root = parse(html);
    root.querySelectorAll("script,style").forEach((node) => node.remove());
    text = root.structuredText;
  } catch {
    return "";
  }
  return text.replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_TEXT_CHARS);
}

/** JSON-LD script bodies with the same caps the fetcher enforces. */
export function clipJsonLdBlocks(html: string): string[] {
  try {
    const root = parse(html);
    return root
      .querySelectorAll('script[type="application/ld+json"]')
      .slice(0, MAX_JSONLD_BLOCKS)
      .map((element) => (element.textContent ?? "").slice(0, MAX_JSONLD_BLOCK_CHARS))
      .filter((block) => block.trim() !== "");
  } catch {
    return [];
  }
}

function createClipBatch(handle: DatabaseHandle, now: string): string {
  const batchId = newId();
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(intakeBatches)
      .values({ id: batchId, rawLineCount: 1, createdAt: now })
      .run();
  });
  return batchId;
}

function insertPendingItem(
  handle: DatabaseHandle,
  input: { batchId: string; rawInput: string; canonicalUrl: string | null; now: string },
): string {
  const intakeItemId = newId();
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(intakeItems)
      .values({
        id: intakeItemId,
        batchId: input.batchId,
        lineNumber: 1,
        rawInput: input.rawInput,
        outcome: "PENDING",
        canonicalUrl: input.canonicalUrl,
        createdAt: input.now,
      })
      .run();
  });
  return intakeItemId;
}

function finalizeItem(
  handle: DatabaseHandle,
  input: {
    intakeItemId: string;
    batchId: string;
    outcome: "ENQUEUED" | "DUPLICATE" | "INVALID" | "BLOCKED";
    reasonCode: ReasonCode | null;
    jobId: string | null;
  },
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(intakeItems)
      .set({
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        jobId: input.jobId,
      })
      .where(eq(intakeItems.id, input.intakeItemId))
      .run();
    handle.db
      .update(intakeBatches)
      .set({
        enqueuedCount: input.outcome === "ENQUEUED" ? 1 : 0,
        duplicateCount: input.outcome === "DUPLICATE" ? 1 : 0,
        invalidCount: input.outcome === "INVALID" ? 1 : 0,
        blockedCount: input.outcome === "BLOCKED" ? 1 : 0,
      })
      .where(eq(intakeBatches.id, input.batchId))
      .run();
  });
}

/**
 * Ingest one clipped DOM synchronously: validate, dedupe by canonical key,
 * run block detection and extraction, and persist the attempt, evidence,
 * and NEW job. Finished (SUCCEEDED) jobs are never re-clipped — a duplicate
 * points at the existing card — while failed/blocked/in-flight shells are
 * completed by the clip.
 */
export function ingestClippedDom(
  handle: DatabaseHandle,
  input: IngestClipInput,
): IngestClipResult {
  const now = input.now ?? utcNow();
  const submittedUrl = input.submittedUrl.trim();
  const batchId = createClipBatch(handle, now);

  if (Buffer.byteLength(input.html, "utf8") > MAX_HTML_BYTES) {
    const intakeItemId = insertPendingItem(handle, {
      batchId,
      rawInput: submittedUrl,
      canonicalUrl: null,
      now,
    });
    finalizeItem(handle, {
      intakeItemId,
      batchId,
      outcome: "BLOCKED",
      reasonCode: "UNSUPPORTED_PAGE",
      jobId: null,
    });
    return {
      outcome: "rejected",
      batchId,
      intakeItemId,
      jobId: null,
      reasonCode: "UNSUPPORTED_PAGE",
      detail: `page exceeds the ${MAX_HTML_BYTES}-byte capture bound`,
    };
  }

  const canonical = canonicalizeUrl(submittedUrl);
  if (!canonical.ok) {
    const intakeItemId = insertPendingItem(handle, {
      batchId,
      rawInput: submittedUrl,
      canonicalUrl: null,
      now,
    });
    finalizeItem(handle, {
      intakeItemId,
      batchId,
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
      jobId: null,
    });
    return {
      outcome: "rejected",
      batchId,
      intakeItemId,
      jobId: null,
      reasonCode: "INVALID_URL",
      detail: canonical.detail,
    };
  }
  const { canonicalUrl, canonicalKey } = canonical.value;
  const intakeItemId = insertPendingItem(handle, {
    batchId,
    rawInput: submittedUrl,
    canonicalUrl,
    now,
  });

  const existingSource = handle.db
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .where(eq(jobSources.canonicalKey, canonicalKey))
    .get();
  if (existingSource !== undefined) {
    const job = handle.db
      .select({ status: jobs.status, scrapeState: jobs.scrapeState })
      .from(jobs)
      .where(eq(jobs.id, existingSource.jobId))
      .get();
    if (job?.scrapeState === "SUCCEEDED") {
      finalizeItem(handle, {
        intakeItemId,
        batchId,
        outcome: "DUPLICATE",
        reasonCode: "DUPLICATE_URL",
        jobId: existingSource.jobId,
      });
      return {
        outcome: "duplicate",
        batchId,
        intakeItemId,
        jobId: existingSource.jobId,
        jobStatus: job.status,
      };
    }
  }

  const payload: ScrapePayloadV1 = {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl,
    canonicalUrl,
    canonicalKey,
  };
  const shell = ensureFetchShell(handle, { payload, now });
  if (!shell.ok) {
    // Only reachable on a concurrent success between the check above and
    // the shell: re-read the winner and report it as the duplicate.
    const raced = handle.db
      .select({ jobId: jobSources.jobId })
      .from(jobSources)
      .where(eq(jobSources.canonicalKey, canonicalKey))
      .get();
    const jobId = raced?.jobId ?? existingSource?.jobId ?? null;
    finalizeItem(handle, {
      intakeItemId,
      batchId,
      outcome: jobId === null ? "BLOCKED" : "DUPLICATE",
      reasonCode: jobId === null ? "STALE_INPUT" : "DUPLICATE_URL",
      jobId,
    });
    if (jobId === null) {
      return {
        outcome: "rejected",
        batchId,
        intakeItemId,
        jobId: null,
        reasonCode: "STALE_INPUT",
        detail: shell.detail,
      };
    }
    return {
      outcome: "duplicate",
      batchId,
      intakeItemId,
      jobId,
      jobStatus: "NEW",
    };
  }

  const text =
    input.selectedText !== undefined && input.selectedText !== ""
      ? input.selectedText.slice(0, MAX_TEXT_CHARS)
      : clipTextFromHtml(input.html);
  const jsonLdBlocks = clipJsonLdBlocks(input.html);
  const title = input.title ?? "";
  const blocked = detectBlock({
    httpStatus: null,
    textSample: text.slice(0, TEXT_SIGNAL_CHARS),
    htmlSample: input.html.slice(0, HTML_SIGNAL_CHARS),
    title,
  });
  if (blocked.blocked) {
    persistFetchOutcome(handle, {
      payload,
      jobId: shell.jobId,
      intakeItemId,
      workerId: input.source,
      startedAt: now,
      finishedAt: now,
      finalUrl: submittedUrl,
      httpStatus: null,
      outcome: "BLOCKED",
      reasonCode: blocked.reasonCode,
      detail: blocked.detail,
      artifacts: [],
      evidenceDir: input.evidenceDir,
      now,
    });
    finalizeItem(handle, {
      intakeItemId,
      batchId,
      outcome: "BLOCKED",
      reasonCode: blocked.reasonCode,
      jobId: shell.jobId,
    });
    return {
      outcome: "rejected",
      batchId,
      intakeItemId,
      jobId: shell.jobId,
      reasonCode: blocked.reasonCode,
      detail: blocked.detail,
    };
  }

  return finalizeExtraction(handle, {
    payload,
    shellJobId: shell.jobId,
    intakeItemId,
    batchId,
    submittedUrl,
    canonicalUrl,
    canonicalKey,
    html: input.html,
    text,
    jsonLdBlocks,
    source: input.source,
    evidenceDir: input.evidenceDir,
    now,
  });
}

function finalizeExtraction(
  handle: DatabaseHandle,
  args: {
    payload: ScrapePayloadV1;
    shellJobId: string;
    intakeItemId: string;
    batchId: string;
    submittedUrl: string;
    canonicalUrl: string;
    canonicalKey: string;
    html: string;
    text: string;
    jsonLdBlocks: string[];
    source: ClipSource;
    evidenceDir: string;
    now: string;
  },
): IngestClipResult {
  const canonical = canonicalizeUrl(args.canonicalUrl);
  const atsType = canonical.ok ? detectAtsType(canonical.value) : null;
  const outcome = runExtraction({
    html: args.html,
    text: args.text,
    jsonLdBlocks: args.jsonLdBlocks,
    finalUrl: args.submittedUrl,
    canonicalUrl: args.canonicalUrl,
    canonicalKey: args.canonicalKey,
    atsType,
  });
  if (!outcome.ok) {
    persistFetchOutcome(handle, {
      payload: args.payload,
      jobId: args.shellJobId,
      intakeItemId: args.intakeItemId,
      workerId: args.source,
      startedAt: args.now,
      finishedAt: args.now,
      finalUrl: args.submittedUrl,
      httpStatus: null,
      outcome: "FAILED",
      reasonCode: "EXTRACTION_INCOMPLETE",
      detail: outcome.detail,
      artifacts: [],
      evidenceDir: args.evidenceDir,
      now: args.now,
    });
    finalizeItem(handle, {
      intakeItemId: args.intakeItemId,
      batchId: args.batchId,
      outcome: "BLOCKED",
      reasonCode: "EXTRACTION_INCOMPLETE",
      jobId: args.shellJobId,
    });
    return {
      outcome: "rejected",
      batchId: args.batchId,
      intakeItemId: args.intakeItemId,
      jobId: args.shellJobId,
      reasonCode: "EXTRACTION_INCOMPLETE",
      detail: outcome.detail,
    };
  }
  const artifacts: PersistArtifactInput[] = [
    {
      kind: "HTML",
      bytes: Buffer.from(args.html, "utf8"),
      mediaType: "text/html; charset=utf-8",
    },
    {
      kind: "TEXT",
      bytes: Buffer.from(args.text, "utf8"),
      mediaType: "text/plain; charset=utf-8",
    },
  ];
  if (args.jsonLdBlocks.length > 0) {
    artifacts.push({
      kind: "JSONLD",
      bytes: Buffer.from(JSON.stringify(args.jsonLdBlocks), "utf8"),
      mediaType: "application/ld+json",
    });
  }
  const persisted = persistFetchOutcome(handle, {
    payload: args.payload,
    jobId: args.shellJobId,
    intakeItemId: args.intakeItemId,
    workerId: args.source,
    startedAt: args.now,
    finishedAt: args.now,
    finalUrl: args.submittedUrl,
    httpStatus: null,
    outcome: "SUCCEEDED",
    reasonCode: null,
    detail: null,
    artifacts,
    evidenceDir: args.evidenceDir,
    extraction: {
      fields: outcome.fields,
      provenance: outcome.provenance,
      adapterId: outcome.adapterId,
      adapterVersion: outcome.adapterVersion,
      confidence: outcome.confidence,
      missingFields: outcome.missingFields,
      contentHash: outcome.contentHash,
    },
    now: args.now,
  });
  finalizeItem(handle, {
    intakeItemId: args.intakeItemId,
    batchId: args.batchId,
    outcome: "ENQUEUED",
    reasonCode: null,
    jobId: args.shellJobId,
  });
  if (persisted.extractionId === null) {
    throw new Error("clip persist succeeded without an extraction row");
  }
  return {
    outcome: "created",
    batchId: args.batchId,
    intakeItemId: args.intakeItemId,
    jobId: args.shellJobId,
    attemptId: persisted.attemptId,
    extractionId: persisted.extractionId,
    adapter: outcome.adapterId,
    confidence: outcome.confidence,
    missingFields: outcome.missingFields,
  };
}
