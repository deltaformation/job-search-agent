import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
// File imports (not directory barrels): the SCRAPE handler runs in the
// worker under the extensionless-file TS loader.
import type { DatabaseHandle } from "../db/client";
import {
  jobExtractions,
  jobSources,
  jobs,
  scrapeAttempts,
  sourceArtifacts,
} from "../db/schema/jobs";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import type { ReasonCode, ScrapeState } from "../domain/enums";
import { planScrapeTransition } from "../domain/scrape";
import { resolveArtifactPath } from "../security/paths";
import type { ScrapePayloadV1 } from "../server/intake";
import {
  JOB_EXTRACTION_VERSION,
  type FieldProvenance,
  type GapField,
  type NormalizedJobFields,
} from "../extraction/types";
import { FetchArtifactRef, type FetchArtifactRef as FetchArtifactRefValue } from "./envelope";

/**
 * Evidence storage and fetch persistence for R2-C.
 *
 * Raw bytes are content-addressed (`evidence/<sha-prefix>/<sha>.<ext>`)
 * and written once: byte-identical evidence is stored a single time and
 * referenced from every attempt that observed it. Files are written
 * before the database transaction so a row never points at missing
 * bytes; a crash between the two leaves orphaned bytes, which are
 * harmless (same path, same content, reused by the next identical
 * fetch) and never referenced by any row.
 */

export interface StoredEvidence {
  relativePath: string;
  byteSize: number;
  sha256: string;
}

const KIND_EXTENSIONS = {
  HTML: "html",
  TEXT: "txt",
  JSONLD: "json",
} as const;
export type EvidenceKind = keyof typeof KIND_EXTENSIONS;

/**
 * Store raw bytes under the evidence root, skipping the write when
 * identical content already exists. The path is resolved through the
 * data-root policy even though it is hash-derived, never user input.
 */
export function storeEvidence(
  evidenceDir: string,
  kind: EvidenceKind,
  bytes: Uint8Array,
): StoredEvidence {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relativePath = `${sha256.slice(0, 2)}/${sha256}.${KIND_EXTENSIONS[kind]}`;
  const absolute = resolveArtifactPath(evidenceDir, relativePath);
  if (!existsSync(absolute)) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }
  return { relativePath, byteSize: bytes.length, sha256 };
}

export interface EnsureShellInput {
  payload: ScrapePayloadV1;
  now?: string;
}

export type EnsureShellResult =
  | { ok: true; jobId: string; isNew: boolean }
  | {
      ok: false;
      error: "already-succeeded" | "transition-forbidden";
      detail: string;
    };

function toRunningSteps(
  from: ScrapeState,
): ScrapeState[] | null {
  if (from === "RUNNING") {
    return [];
  }
  if (from === "QUEUED") {
    return ["RUNNING"];
  }
  if (from === "FAILED" || from === "BLOCKED") {
    return ["QUEUED", "RUNNING"];
  }
  return null;
}

/**
 * Find-or-create the job shell plus its source row for one canonical
 * key, leaving the job in scrape_state RUNNING. Retried shells (after a
 * crash or a human requeue) re-enter RUNNING through the domain machine;
 * SUCCEEDED shells refuse, because MVP never re-scrapes a finished job.
 */
export function ensureFetchShell(
  handle: DatabaseHandle,
  input: EnsureShellInput,
): EnsureShellResult {
  const now = input.now ?? utcNow();
  const existing = withTransaction(handle.sqlite, () =>
    handle.db
      .select({ jobId: jobSources.jobId })
      .from(jobSources)
      .where(eq(jobSources.canonicalKey, input.payload.canonicalKey))
      .get(),
  );
  let jobId: string;
  let isNew: boolean;
  if (existing === undefined) {
    try {
      jobId = withTransaction(handle.sqlite, () => {
        const created = newId();
        handle.db
          .insert(jobs)
          .values({ id: created, scrapeState: "QUEUED" })
          .run();
        handle.db
          .insert(jobSources)
          .values({
            id: newId(),
            jobId: created,
            submittedUrl: input.payload.submittedUrl,
            canonicalUrl: input.payload.canonicalUrl,
            canonicalKey: input.payload.canonicalKey,
          })
          .run();
        return created;
      });
      isNew = true;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          /UNIQUE constraint failed: job_sources\.canonical_key/.test(
            error.message,
          )
        )
      ) {
        throw error;
      }
      const raced = withTransaction(handle.sqlite, () =>
        handle.db
          .select({ jobId: jobSources.jobId })
          .from(jobSources)
          .where(eq(jobSources.canonicalKey, input.payload.canonicalKey))
          .get(),
      );
      if (raced === undefined) {
        throw new Error(
          `canonical key ${input.payload.canonicalKey} conflicted but has no source row`,
        );
      }
      jobId = raced.jobId;
      isNew = false;
    }
  } else {
    jobId = existing.jobId;
    isNew = false;
  }
  return withTransaction(handle.sqlite, () => {
    const job = handle.db
      .select({ scrapeState: jobs.scrapeState })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (job === undefined) {
      throw new Error(`job shell ${jobId} vanished mid-fetch`);
    }
    const from = job.scrapeState as ScrapeState;
    if (from === "SUCCEEDED") {
      return {
        ok: false,
        error: "already-succeeded",
        detail: "job already scraped; MVP never re-scrapes",
      } as const;
    }
    const steps = toRunningSteps(from);
    if (steps === null) {
      return {
        ok: false,
        error: "transition-forbidden",
        detail: `cannot move scrape from ${from} to RUNNING`,
      } as const;
    }
    let current: ScrapeState = from;
    for (const next of steps) {
      const planned = planScrapeTransition(current, { to: next });
      if (!planned.ok) {
        return {
          ok: false,
          error: "transition-forbidden",
          detail: planned.detail,
        } as const;
      }
      current = next;
    }
    if (steps.length > 0) {
      handle.db
        .update(jobs)
        .set({ scrapeState: "RUNNING", updatedAt: now })
        .where(and(eq(jobs.id, jobId), eq(jobs.scrapeState, from)))
        .run();
    }
    return { ok: true, jobId, isNew } as const;
  });
}

export interface PersistArtifactInput {
  kind: EvidenceKind;
  bytes: Uint8Array;
  mediaType: string;
}

export interface PersistExtractionInput {
  fields: NormalizedJobFields;
  provenance: FieldProvenance;
  adapterId: string;
  adapterVersion: string;
  confidence: number;
  missingFields: GapField[];
  contentHash: string;
}

export interface PersistFetchInput {
  payload: ScrapePayloadV1;
  jobId: string;
  intakeItemId: string | null;
  workerId: string;
  startedAt: string;
  finishedAt: string;
  finalUrl: string;
  httpStatus: number | null;
  outcome: "SUCCEEDED" | "BLOCKED" | "FAILED";
  reasonCode: ReasonCode | null;
  detail: string | null;
  artifacts: PersistArtifactInput[];
  evidenceDir: string;
  /** R2-D extraction; only valid with a SUCCEEDED fetch outcome. */
  extraction?: PersistExtractionInput | null;
  now?: string;
}

export interface PersistFetchResult {
  attemptId: string;
  refs: FetchArtifactRefValue[];
  scrapeState: ScrapeState;
  extractionId: string | null;
}

/**
 * Persist one finished fetch: the job shell moves RUNNING → outcome, one
 * append-only `scrape_attempts` row records the attempt, and one
 * `source_artifacts` row per captured kind references the stored bytes.
 * Blocked/failed fetches persist no artifacts — the attempt row carries
 * the reason — so evidence stays a record of real postings only.
 */
export function persistFetchOutcome(
  handle: DatabaseHandle,
  input: PersistFetchInput,
): PersistFetchResult {
  const now = input.now ?? utcNow();
  const scrapeState = input.outcome as ScrapeState;
  const planned = planScrapeTransition("RUNNING", {
    to: scrapeState,
    reasonCode: input.reasonCode ?? undefined,
  });
  if (!planned.ok) {
    throw new Error(`cannot persist fetch outcome: ${planned.detail}`);
  }
  const extraction = input.extraction ?? null;
  if (extraction !== null && input.outcome !== "SUCCEEDED") {
    throw new Error("extraction rows require a SUCCEEDED fetch outcome");
  }
  const extractedJson =
    extraction === null
      ? null
      : JSON.stringify({
        schemaVersion: JOB_EXTRACTION_VERSION,
        fields: extraction.fields,
        provenance: extraction.provenance,
        adapterId: extraction.adapterId,
        adapterVersion: extraction.adapterVersion,
        confidence: extraction.confidence,
        missingFields: extraction.missingFields,
        contentHash: extraction.contentHash,
      });
  const refs = input.artifacts.map((artifact) => {
    const stored = storeEvidence(
      input.evidenceDir,
      artifact.kind,
      artifact.bytes,
    );
    return FetchArtifactRef.parse({
      kind: artifact.kind,
      relativePath: stored.relativePath,
      mediaType: artifact.mediaType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
    });
  });
  // Insert order honors both SQLite's immediate foreign keys (the
  // attempt exists before the extraction references it) and the
  // active-extraction triggers (the extraction exists before the job
  // points at it).
  const { attemptId, extractionId } = withTransaction(handle.sqlite, () => {
    const moved = handle.db
      .update(jobs)
      .set({
        scrapeState,
        scrapeReasonCode: input.reasonCode,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, input.jobId), eq(jobs.scrapeState, "RUNNING")))
      .run().changes;
    if (moved !== 1) {
      // The shell left RUNNING concurrently (a second persist won the
      // race); abort instead of recording an attempt the job disagrees
      // with. The transaction rolls back, including any rows below.
      throw new Error(
        `job shell ${input.jobId} is no longer RUNNING; refusing second persist`,
      );
    }
    const created = newId();
    handle.db
      .insert(scrapeAttempts)
      .values({
        id: created,
        intakeItemId: input.intakeItemId,
        jobId: input.jobId,
        canonicalUrl: input.payload.canonicalUrl,
        adapter: null,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        errorDetail: input.detail,
        workerId: input.workerId,
      })
      .run();
    let createdExtraction: string | null = null;
    if (extraction !== null && extractedJson !== null) {
      createdExtraction = newId();
      handle.db
        .insert(jobExtractions)
        .values({
          id: createdExtraction,
          jobId: input.jobId,
          scrapeAttemptId: created,
          version: 1,
          schemaVersion: JOB_EXTRACTION_VERSION,
          adapter: extraction.adapterId,
          adapterVersion: extraction.adapterVersion,
          extractedJson,
          confidence: extraction.confidence,
          missingFieldsJson: JSON.stringify(extraction.missingFields),
        })
        .run();
      handle.db
        .update(jobs)
        .set({
          title: extraction.fields.title,
          company: extraction.fields.company,
          location: extraction.fields.location,
          arrangement: extraction.fields.arrangement,
          salaryText: extraction.fields.salaryText,
          salaryCurrency: extraction.fields.salaryCurrency,
          salaryMinMinor: extraction.fields.salaryMinMinor,
          salaryMaxMinor: extraction.fields.salaryMaxMinor,
          descriptionText: extraction.fields.descriptionText,
          postedAt: extraction.fields.postedAt,
          activeExtractionId: createdExtraction,
          updatedAt: now,
        })
        .where(eq(jobs.id, input.jobId))
        .run();
    }
    handle.db
      .update(jobSources)
      .set({
        finalUrl: input.finalUrl,
        ...(extraction === null
          ? {}
          : { applyUrl: extraction.fields.applyUrl }),
      })
      .where(eq(jobSources.jobId, input.jobId))
      .run();
    for (const ref of refs) {
      handle.db
        .insert(sourceArtifacts)
        .values({
          id: newId(),
          scrapeAttemptId: created,
          kind: ref.kind,
          relativePath: ref.relativePath,
          mediaType: ref.mediaType,
          byteSize: ref.byteSize,
          sha256: ref.sha256,
        })
        .run();
    }
    return { attemptId: created, extractionId: createdExtraction };
  });
  return { attemptId, refs, scrapeState, extractionId };
}
