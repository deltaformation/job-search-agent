// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import {
  normalizeTailoringGuidance,
  requestTailoring,
  tailorGuidedIdempotencyKey,
  tailorIdempotencyKey,
  TailorPayloadV1,
} from "../../../src/tailoring/enqueue";
import { seedJob } from "./support";

/**
 * Guided TAILOR enqueue (R-ADR-013): legacy job+extraction idempotency is
 * unchanged, while human guidance selects a guidance-scoped key so new
 * guidance enqueues a fresh run and identical guidance dedupes.
 */

const testDbs: TestDatabase[] = [];

afterEach(() => {
  while (testDbs.length > 0) {
    testDbs.pop()?.cleanup();
  }
});

function setup(): { t: TestDatabase; jobId: string; extractionId: string } {
  const t = createTestDatabase("tailor-enqueue-");
  testDbs.push(t);
  const { jobId, extractionId } = seedJob(t, "Do things with Kubernetes.");
  return { t, jobId, extractionId };
}

function payloadFor(t: TestDatabase, workItemId: string): Record<string, unknown> {
  const row = t.handle.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  return JSON.parse(String(row?.payloadJson)) as Record<string, unknown>;
}

describe("normalizeTailoringGuidance", () => {
  it("trims, dedupes, and drops empties", () => {
    expect(
      normalizeTailoringGuidance({
        selectedKeywords: [" Kubernetes ", "Kubernetes", "Go"],
        directives: "  ",
      }),
    ).toEqual({ selectedKeywords: ["Kubernetes", "Go"] });
    expect(normalizeTailoringGuidance({})).toBeNull();
    expect(normalizeTailoringGuidance({ selectedKeywords: [], directives: "" })).toBeNull();
    expect(normalizeTailoringGuidance({ selectedKeywords: ["x".repeat(129)] })).toBeNull();
  });
});

describe("tailorGuidedIdempotencyKey", () => {
  it("is stable for identical guidance regardless of keyword order", () => {
    const jobId = "job-1";
    const extractionId = "ext-1";
    const first = tailorGuidedIdempotencyKey(jobId, extractionId, {
      profileId: "local",
      selectedKeywords: ["a", "b"],
      directives: "note",
    });
    const reordered = tailorGuidedIdempotencyKey(jobId, extractionId, {
      profileId: "local",
      selectedKeywords: ["b", "a"],
      directives: "note",
    });
    expect(reordered).toBe(first);
    expect(first).not.toBe(tailorIdempotencyKey(jobId, extractionId));
  });

  it("forks on any guidance change", () => {
    const base = { selectedKeywords: ["a"] };
    const keys = new Set([
      tailorGuidedIdempotencyKey("job-1", "ext-1", base),
      tailorGuidedIdempotencyKey("job-1", "ext-1", { selectedKeywords: ["b"] }),
      tailorGuidedIdempotencyKey("job-1", "ext-1", { ...base, directives: "x" }),
      tailorGuidedIdempotencyKey("job-1", "ext-1", { ...base, profileId: "other" }),
      tailorGuidedIdempotencyKey("job-2", "ext-1", base),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe("TailorPayloadV1", () => {
  it("still parses legacy payloads without guidance", () => {
    expect(
      TailorPayloadV1.safeParse({
        schemaVersion: "tailor-queue/v1",
        jobId: "00000000-0000-4000-8000-000000000001",
        extractionId: "00000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(true);
  });
});

describe("requestTailoring guidance", () => {
  it("keeps the legacy key and payload without guidance", () => {
    const { t, jobId, extractionId } = setup();
    const first = requestTailoring(t.handle, { jobId, extractionId });
    expect(first.deduped).toBe(false);
    expect(payloadFor(t, first.workItemId)).toEqual({
      schemaVersion: "tailor-queue/v1",
      jobId,
      extractionId,
    });
    const second = requestTailoring(t.handle, { jobId, extractionId });
    expect(second).toEqual({ workItemId: first.workItemId, deduped: true });
  });

  it("stores guidance on the payload under a guided key", () => {
    const { t, jobId, extractionId } = setup();
    const requested = requestTailoring(t.handle, {
      jobId,
      extractionId,
      profileId: "local",
      selectedKeywords: ["Kubernetes", "Kubernetes", "Go"],
      directives: "Emphasize scale.",
    });
    expect(requested.deduped).toBe(false);
    expect(payloadFor(t, requested.workItemId)).toEqual({
      schemaVersion: "tailor-queue/v1",
      jobId,
      extractionId,
      profileId: "local",
      selectedKeywords: ["Kubernetes", "Go"],
      directives: "Emphasize scale.",
    });
  });

  it("dedupes identical guidance and forks on new guidance", () => {
    const { t, jobId, extractionId } = setup();
    const first = requestTailoring(t.handle, {
      jobId,
      extractionId,
      selectedKeywords: ["Kubernetes"],
    });
    const same = requestTailoring(t.handle, {
      jobId,
      extractionId,
      selectedKeywords: ["Kubernetes"],
    });
    expect(same).toEqual({ workItemId: first.workItemId, deduped: true });
    const changed = requestTailoring(t.handle, {
      jobId,
      extractionId,
      selectedKeywords: ["Kubernetes", "Go"],
    });
    expect(changed.deduped).toBe(false);
    expect(changed.workItemId).not.toBe(first.workItemId);
  });

  it("rejects invalid guidance instead of queueing", () => {
    const { t, jobId, extractionId } = setup();
    expect(() =>
      requestTailoring(t.handle, {
        jobId,
        extractionId,
        selectedKeywords: Array.from({ length: 21 }, (_, index) => `k${index}`),
      }),
    ).toThrow();
    expect(() =>
      requestTailoring(t.handle, { jobId, extractionId, directives: "x".repeat(1001) }),
    ).toThrow();
  });
});
