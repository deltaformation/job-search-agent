import { createHash } from "node:crypto";
// File imports (not directory barrels): the SCRAPE handler runs in the
// worker under the extensionless-file TS loader.
import { utcNow } from "../db/utils";
import { parseVersionedPayload } from "../domain/envelopes";
import type { ReasonCode } from "../domain/enums";
import { runExtraction } from "../extraction/extract";
import { GAP_FIELDS, type ExtractionOutcome } from "../extraction/types";
import type { HandlerOutcome, WorkHandler } from "../queue/dispatch";
import { createLogger } from "../security/logger";
import {
  SCRAPE_PAYLOAD_VERSION,
  ScrapePayloadV1,
} from "../server/intake";
import { defaultResolver, type DnsResolver } from "./ssrf";
import { canonicalizeUrl, detectAtsType } from "./urls";
import type { PersistExtractionInput } from "./evidence";
import {
  FETCH_ENVELOPE_VERSION,
  FetchEnvelopeV1,
  hashFetchEnvelope,
} from "./envelope";
import { ensureFetchShell, persistFetchOutcome } from "./evidence";
import { fetchJobPage } from "./fetch";
import type { BrowserSupplier } from "./browser";
import { OriginThrottle } from "./throttle";

const log = createLogger("scrape-handler");

/**
 * SCRAPE queue handler: parse the R2-A payload, ensure the job shell,
 * fetch the submitted URL, persist the attempt plus evidence, and return
 * the queue outcome. Database work stays in the short evidence
 * transactions; the fetch runs outside any transaction.
 */

export interface ScrapeHandlerDeps {
  evidenceDir: string;
  resolveHost?: DnsResolver;
  fetchPage?: typeof fetchJobPage;
  browser?: BrowserSupplier;
  /** Caller-owned throttle; the worker shares one across fetches. */
  throttle?: OriginThrottle;
  clock?: () => string;
}

export function hashScrapeInput(canonicalKey: string): string {
  return createHash("sha256")
    .update(`scrape-input-v1:${canonicalKey}`, "utf8")
    .digest("hex");
}

export function createScrapeHandler(deps: ScrapeHandlerDeps): WorkHandler {
  const clock = deps.clock ?? utcNow;
  const resolveHost = deps.resolveHost ?? defaultResolver;
  const runFetch = deps.fetchPage ?? fetchJobPage;
  return async (context): Promise<HandlerOutcome> => {
    const inputHash = (canonicalKey: string): string =>
      hashScrapeInput(canonicalKey);
    let rawPayload: unknown;
    try {
      rawPayload =
        context.item.payloadJson === null
          ? null
          : (JSON.parse(context.item.payloadJson) as unknown);
    } catch {
      rawPayload = undefined;
    }
    const parsed = parseVersionedPayload(
      { [SCRAPE_PAYLOAD_VERSION]: ScrapePayloadV1 },
      rawPayload,
    );
    if (!parsed.ok) {
      log.error("scrape payload failed to parse", {
        workItemId: context.item.id,
        error: parsed.error,
      });
      return {
        result: "FAILED",
        errorCode: "STALE_INPUT",
        errorDetail: `queue payload is unusable (${parsed.error}): ${parsed.detail}`,
      };
    }
    const payload = parsed.value as ScrapePayloadV1;
    const startedAt = clock();
    const shell = ensureFetchShell(context.handle, {
      payload,
      now: startedAt,
    });
    if (!shell.ok) {
      return {
        result: "FAILED",
        errorCode: "STALE_INPUT",
        errorDetail: shell.detail,
      };
    }
    const fetch = await runFetch({
      url: payload.submittedUrl,
      resolveHost,
      browser: deps.browser,
      throttle: deps.throttle,
    });
    const finishedAt = clock();
    let finalOutcome: "SUCCEEDED" | "BLOCKED" | "FAILED" = fetch.outcome;
    let finalReason: ReasonCode | null = fetch.reasonCode;
    let finalDetail: string | null = fetch.detail;
    let extraction: PersistExtractionInput | null = null;
    if (fetch.outcome === "SUCCEEDED") {
      const canonical = canonicalizeUrl(payload.canonicalUrl);
      const atsType = canonical.ok ? detectAtsType(canonical.value) : null;
      let outcome: ExtractionOutcome;
      try {
        outcome = runExtraction({
          html: fetch.html === null ? "" : fetch.html.toString("utf8"),
          text: fetch.text ?? "",
          jsonLdBlocks: fetch.jsonLdBlocks,
          finalUrl: fetch.finalUrl,
          canonicalUrl: payload.canonicalUrl,
          canonicalKey: payload.canonicalKey,
          atsType,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : String(error);
        log.error("extraction threw; recording incomplete", {
          workItemId: context.item.id,
          detail,
        });
        outcome = {
          ok: false,
          reason: "EXTRACTION_INCOMPLETE",
          detail: `extractor failed: ${detail}`.slice(0, 2000),
          missingFields: [...GAP_FIELDS],
        };
      }
      if (outcome.ok) {
        extraction = {
          fields: outcome.fields,
          provenance: outcome.provenance,
          adapterId: outcome.adapterId,
          adapterVersion: outcome.adapterVersion,
          confidence: outcome.confidence,
          missingFields: outcome.missingFields,
          contentHash: outcome.contentHash,
        };
      } else {
        // The fetch produced real bytes (artifacts below are kept) but
        // nothing usable came out: fail the job without a malformed
        // card and let bounded retry or a human requeue decide next.
        finalOutcome = "FAILED";
        finalReason = "EXTRACTION_INCOMPLETE";
        finalDetail = outcome.detail;
      }
    }
    const persisted = persistFetchOutcome(context.handle, {
      payload,
      jobId: shell.jobId,
      intakeItemId: context.item.intakeItemId,
      workerId: context.workerId,
      startedAt,
      finishedAt,
      finalUrl: fetch.finalUrl,
      httpStatus: fetch.httpStatus,
      outcome: finalOutcome,
      reasonCode: finalReason,
      detail: finalDetail,
      extraction,
      artifacts: [
        fetch.html === null
          ? null
          : {
            kind: "HTML" as const,
            bytes: fetch.html,
            mediaType: fetch.htmlMediaType ?? "text/html; charset=utf-8",
          },
        fetch.text === null
          ? null
          : {
            kind: "TEXT" as const,
            bytes: Buffer.from(fetch.text, "utf8"),
            mediaType: "text/plain; charset=utf-8",
          },
        fetch.jsonLdBlocks.length === 0
          ? null
          : {
            kind: "JSONLD" as const,
            bytes: Buffer.from(
              JSON.stringify(fetch.jsonLdBlocks),
              "utf8",
            ),
            mediaType: "application/ld+json",
          },
      ].filter((artifact) => artifact !== null),
      evidenceDir: deps.evidenceDir,
      now: finishedAt,
    });
    if (finalOutcome === "SUCCEEDED") {
      const envelope = FetchEnvelopeV1.parse({
        schemaVersion: FETCH_ENVELOPE_VERSION,
        submittedUrl: payload.submittedUrl,
        canonicalUrl: payload.canonicalUrl,
        canonicalKey: payload.canonicalKey,
        finalUrl: fetch.finalUrl,
        httpStatus: fetch.httpStatus,
        redirectChain: fetch.redirectChain.map((url) => ({ url })),
        blocked: null,
        artifacts: persisted.refs,
        fetchedAt: finishedAt,
      });
      return {
        result: "SUCCEEDED",
        inputHash: inputHash(payload.canonicalKey),
        outputHash: hashFetchEnvelope(envelope),
      };
    }
    return {
      result: finalOutcome,
      errorCode: finalReason ?? "STALE_INPUT",
      errorDetail: finalDetail ?? "fetch failed without detail",
      inputHash: inputHash(payload.canonicalKey),
    };
  };
}
