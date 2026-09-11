import { eq } from "drizzle-orm";
import { z } from "zod";
// File imports (not directory barrels): the R2-C SCRAPE handler loads this
// module in the worker under the extensionless-file TS loader.
import type { DatabaseHandle } from "../db/client";
import { intakeBatches, intakeItems } from "../db/schema/intake";
import { jobSources } from "../db/schema/jobs";
import { workItems } from "../db/schema/queue";
import { withTransaction } from "../db/transactions";
import { newId } from "../db/utils";
import type { IntakeOutcome, ReasonCode } from "../domain/enums";
import { MAX_URL_LENGTH, canonicalizeUrl } from "../scraping/urls";
import { preflightHost, type DnsResolver } from "../scraping/ssrf";

/**
 * Intake application service: one multiline paste becomes a batch of
 * classified lines with transactional scrape enqueue.
 *
 * Per line: trim, validate + canonicalize (original URL always preserved),
 * SSRF preflight, then dedupe twice — within the batch first, then against
 * stored canonical keys and queue idempotency keys. Only genuinely new
 * public URLs enqueue scrape work. Every database write for a line happens
 * inside one short synchronous transaction; DNS runs outside transactions.
 * Blank lines are skipped without items but keep original line numbering.
 */

export const MAX_INTAKE_LINES = 100;

export const SCRAPE_PAYLOAD_VERSION = "scrape-payload-v1";

/**
 * Queue payload handed to the R2-C fetcher. The fetcher fetches
 * `submittedUrl` (exact user intent) and uses the canonical forms for
 * dedupe evidence.
 */
export const ScrapePayloadV1 = z
  .object({
    schemaVersion: z.literal(SCRAPE_PAYLOAD_VERSION),
    submittedUrl: z.string().min(1).max(MAX_URL_LENGTH),
    canonicalUrl: z.string().min(1).max(MAX_URL_LENGTH),
    canonicalKey: z.string().min(1).max(MAX_URL_LENGTH + 16),
  })
  .strict();
export type ScrapePayloadV1 = z.infer<typeof ScrapePayloadV1>;

export function scrapeIdempotencyKey(canonicalKey: string): string {
  return `scrape:${canonicalKey}`;
}

export interface IntakeLineResult {
  lineNumber: number;
  rawInput: string;
  outcome: IntakeOutcome;
  reasonCode: ReasonCode | null;
  /** Human-readable detail for per-line UI feedback (not persisted). */
  detail: string | null;
  canonicalUrl: string | null;
  canonicalKey: string | null;
  intakeItemId: string;
  jobId: string | null;
  workItemId: string | null;
  /** For in-batch duplicates: the first line number that enqueued. */
  duplicateOfLine: number | null;
}

export interface IntakeBatchCounts {
  rawLineCount: number;
  enqueuedCount: number;
  duplicateCount: number;
  invalidCount: number;
  blockedCount: number;
}

export interface SubmitIntakeResult {
  batchId: string;
  results: IntakeLineResult[];
  counts: IntakeBatchCounts;
}

export interface SubmitIntakeOptions {
  handle: DatabaseHandle;
  lines: string[];
  resolveHost?: DnsResolver;
  dnsTimeoutMs?: number;
}

export class IntakeError extends Error {
  readonly code: "batch-too-large";
  constructor(code: "batch-too-large", message: string) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
  }
}

export interface PreparedLine {
  lineNumber: number;
  rawInput: string;
  outcome: IntakeOutcome;
  reasonCode: ReasonCode | null;
  detail: string | null;
  canonicalUrl: string | null;
  canonicalKey: string | null;
  duplicateOfLine: number | null;
}

export interface PrepareIntakeOptions {
  lines: string[];
  resolveHost?: DnsResolver;
  dnsTimeoutMs?: number;
}

/**
 * Validate pasted lines without persisting anything: canonicalize,
 * preflight DNS, and flag in-batch duplicates. Submit runs this same
 * phase first, so prepare previews exactly what submit will classify
 * (cross-batch duplicates only resolve at submit, when work rows exist).
 */
export async function prepareIntakeLines(
  options: PrepareIntakeOptions,
): Promise<PreparedLine[]> {
  const numbered = options.lines
    .map((rawInput, index) => ({ rawInput, lineNumber: index + 1 }))
    .filter((line) => line.rawInput.trim() !== "");
  if (numbered.length > MAX_INTAKE_LINES) {
    throw new IntakeError(
      "batch-too-large",
      `intake batch has ${numbered.length} URLs but at most ${MAX_INTAKE_LINES} are accepted`,
    );
  }
  const seen = new Map<string, number>();
  const classified: PreparedLine[] = [];
  for (const line of numbered) {
    classified.push(await classifyLine(line, seen, options));
  }
  return classified;
}

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: work_items\.idempotency_key/.test(error.message)
  );
}

export async function submitIntakeBatch(
  options: SubmitIntakeOptions,
): Promise<SubmitIntakeResult> {
  const { handle, lines } = options;
  // Phase 1 (async, no transactions): shared with prepareIntakeLines.
  const classified = await prepareIntakeLines(options);

  // Phase 2 (short sync transactions): persist batch, items, and work.
  const batchId = newId();
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(intakeBatches)
      .values({ id: batchId, rawLineCount: lines.length })
      .run();
  });

  const results: IntakeLineResult[] = classified.map((line) =>
    persistLine(handle, batchId, line),
  );

  const counts: IntakeBatchCounts = {
    rawLineCount: lines.length,
    enqueuedCount: results.filter((r) => r.outcome === "ENQUEUED").length,
    duplicateCount: results.filter((r) => r.outcome === "DUPLICATE").length,
    invalidCount: results.filter((r) => r.outcome === "INVALID").length,
    blockedCount: results.filter((r) => r.outcome === "BLOCKED").length,
  };
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(intakeBatches)
      .set({
        enqueuedCount: counts.enqueuedCount,
        duplicateCount: counts.duplicateCount,
        invalidCount: counts.invalidCount,
        blockedCount: counts.blockedCount,
      })
      .where(eq(intakeBatches.id, batchId))
      .run();
  });

  return { batchId, results, counts };
}

async function classifyLine(
  line: { rawInput: string; lineNumber: number },
  seen: Map<string, number>,
  options: PrepareIntakeOptions,
): Promise<PreparedLine> {
  const base = {
    lineNumber: line.lineNumber,
    rawInput: line.rawInput,
    duplicateOfLine: null as number | null,
  };
  const canonical = canonicalizeUrl(line.rawInput);
  if (!canonical.ok) {
    return {
      ...base,
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
      detail: canonical.detail,
      canonicalUrl: null,
      canonicalKey: null,
    };
  }
  const { canonicalUrl, canonicalKey, hostname } = canonical.value;
  const preflight = await preflightHost(hostname, {
    resolver: options.resolveHost,
    timeoutMs: options.dnsTimeoutMs,
  });
  if (!preflight.ok) {
    return {
      ...base,
      outcome: preflight.outcome,
      reasonCode: preflight.reasonCode,
      detail: preflight.detail,
      canonicalUrl,
      canonicalKey,
    };
  }
  const firstLine = seen.get(canonicalKey);
  if (firstLine !== undefined) {
    return {
      ...base,
      outcome: "DUPLICATE",
      reasonCode: "DUPLICATE_URL",
      detail: `duplicate of line ${firstLine} in this batch`,
      canonicalUrl,
      canonicalKey,
      duplicateOfLine: firstLine,
    };
  }
  seen.set(canonicalKey, line.lineNumber);
  return {
    ...base,
    outcome: "ENQUEUED",
    reasonCode: null,
    detail: null,
    canonicalUrl,
    canonicalKey,
  };
}

function persistLine(
  handle: DatabaseHandle,
  batchId: string,
  line: PreparedLine,
): IntakeLineResult {
  const intakeItemId = newId();
  const canonicalKey = line.canonicalKey;
  const canonicalUrl = line.canonicalUrl;
  if (
    line.outcome !== "ENQUEUED" ||
    canonicalKey === null ||
    canonicalUrl === null
  ) {
    withTransaction(handle.sqlite, () => {
      handle.db
        .insert(intakeItems)
        .values({
          id: intakeItemId,
          batchId,
          lineNumber: line.lineNumber,
          rawInput: line.rawInput,
          outcome: line.outcome,
          reasonCode: line.reasonCode,
          canonicalUrl: line.canonicalUrl,
        })
        .run();
    });
    return { ...line, intakeItemId, jobId: null, workItemId: null };
  }

  // Fresh const so the non-null canonicals survive into the closure below
  // (parameter narrowing does not).
  const enqueueable = { ...line, canonicalKey, canonicalUrl };
  try {
    return withTransaction(handle.sqlite, () =>
      enqueueNewUrl(handle, batchId, intakeItemId, enqueueable),
    );
  } catch (error) {
    // Lost a concurrent race for the same canonical key: the other batch
    // owns the work item, so this line is a duplicate of it.
    if (!isIdempotencyConflict(error)) {
      throw error;
    }
    const retryItemId = newId();
    return withTransaction(handle.sqlite, () => {
      handle.db
        .insert(intakeItems)
        .values({
          id: retryItemId,
          batchId,
          lineNumber: line.lineNumber,
          rawInput: line.rawInput,
          outcome: "DUPLICATE",
          reasonCode: "DUPLICATE_URL",
          canonicalUrl: line.canonicalUrl,
        })
        .run();
      return {
        ...line,
        outcome: "DUPLICATE" as const,
        reasonCode: "DUPLICATE_URL" as const,
        detail: "another batch queued this URL first",
        intakeItemId: retryItemId,
        jobId: null,
        workItemId: null,
      };
    });
  }
}

function enqueueNewUrl(
  handle: DatabaseHandle,
  batchId: string,
  intakeItemId: string,
  line: PreparedLine & { canonicalKey: string; canonicalUrl: string },
): IntakeLineResult {
  const { db } = handle;
  const idempotencyKey = scrapeIdempotencyKey(line.canonicalKey);

  const existingSource = db
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .where(eq(jobSources.canonicalKey, line.canonicalKey))
    .get();
  if (existingSource !== undefined) {
    db.insert(intakeItems)
      .values({
        id: intakeItemId,
        batchId,
        lineNumber: line.lineNumber,
        rawInput: line.rawInput,
        outcome: "DUPLICATE",
        reasonCode: "DUPLICATE_URL",
        canonicalUrl: line.canonicalUrl,
        jobId: existingSource.jobId,
      })
      .run();
    return {
      ...line,
      outcome: "DUPLICATE",
      reasonCode: "DUPLICATE_URL",
      detail: "this URL is already tracked",
      intakeItemId,
      jobId: existingSource.jobId,
      workItemId: null,
    };
  }

  const existingWork = db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.idempotencyKey, idempotencyKey))
    .get();
  if (existingWork !== undefined) {
    db.insert(intakeItems)
      .values({
        id: intakeItemId,
        batchId,
        lineNumber: line.lineNumber,
        rawInput: line.rawInput,
        outcome: "DUPLICATE",
        reasonCode: "DUPLICATE_URL",
        canonicalUrl: line.canonicalUrl,
      })
      .run();
    return {
      ...line,
      outcome: "DUPLICATE",
      reasonCode: "DUPLICATE_URL",
      detail: "this URL is already queued",
      intakeItemId,
      jobId: null,
      workItemId: existingWork.id,
    };
  }

  const workItemId = newId();
  const payload: ScrapePayloadV1 = {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl: line.rawInput.trim(),
    canonicalUrl: line.canonicalUrl,
    canonicalKey: line.canonicalKey,
  };
  db.insert(intakeItems)
    .values({
      id: intakeItemId,
      batchId,
      lineNumber: line.lineNumber,
      rawInput: line.rawInput,
      outcome: "ENQUEUED",
      reasonCode: null,
      canonicalUrl: line.canonicalUrl,
    })
    .run();
  db.insert(workItems)
    .values({
      id: workItemId,
      kind: "SCRAPE",
      idempotencyKey,
      intakeItemId,
      payloadJson: JSON.stringify(payload),
    })
    .run();
  return { ...line, intakeItemId, jobId: null, workItemId };
}
