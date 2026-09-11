// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, openDatabase } from "../../../src/db";
import {
  intakeBatches,
  intakeItems,
  jobs,
  scrapeAttempts,
  workItems,
} from "../../../src/db/schema";
import {
  SCRAPE_PAYLOAD_VERSION,
  type ScrapePayloadV1,
} from "../../../src/server/intake";
import { POST as pasteContent } from "../../../app/api/attempts/[id]/content/route";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

const FIXTURE_HTML = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "extraction",
    "fixtures",
    "jobposting-jsonld.html",
  ),
  "utf8",
);
const CANONICAL_URL = "https://example.com/jobs/paste-fallback";
const SUBMITTED_URL = `${CANONICAL_URL}?ref=home`;

function payloadJson(): string {
  const payload: ScrapePayloadV1 = {
    schemaVersion: SCRAPE_PAYLOAD_VERSION,
    submittedUrl: SUBMITTED_URL,
    canonicalUrl: CANONICAL_URL,
    canonicalKey: `url:${CANONICAL_URL}`,
  };
  return JSON.stringify(payload);
}

describe("POST /api/attempts/[id]/content", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-paste-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function seedWorkItem(payload: string): string {
    const id = newId();
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      const batchId = newId();
      handle.db.insert(intakeBatches).values({ id: batchId, rawLineCount: 1 }).run();
      const intakeItemId = newId();
      handle.db
        .insert(intakeItems)
        .values({
          id: intakeItemId,
          batchId,
          lineNumber: 1,
          rawInput: SUBMITTED_URL,
          outcome: "ENQUEUED",
          canonicalUrl: CANONICAL_URL,
        })
        .run();
      handle.db
        .insert(workItems)
        .values({
          id,
          kind: "SCRAPE",
          idempotencyKey: `key-${id}`,
          intakeItemId,
          payloadJson: payload,
          state: "FAILED",
          attemptCount: 3,
          maxAttempts: 3,
        })
        .run();
      return id;
    } finally {
      handle.close();
    }
  }

  function seedAttempt(reasonCode: string | null): void {
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: newId(),
          canonicalUrl: CANONICAL_URL,
          startedAt: "2026-09-11T10:00:00.000Z",
          finishedAt: "2026-09-11T10:00:01.000Z",
          outcome: reasonCode === null ? "SUCCEEDED" : "FAILED",
          reasonCode,
        })
        .run();
    } finally {
      handle.close();
    }
  }

  function jobCount(): number {
    const handle = openDatabase({
      path: join(isolated.root, "job-tracker.sqlite"),
    });
    try {
      return handle.db.select().from(jobs).all().length;
    } finally {
      handle.close();
    }
  }

  it("ingests pasted content after a CAPTCHA block", async () => {
    const workItemId = seedWorkItem(payloadJson());
    seedAttempt("CAPTCHA_REQUIRED");
    const response = await pasteContent(
      postRequest(`/api/attempts/${workItemId}/content`, { html: FIXTURE_HTML }),
      routeParams(workItemId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body["outcome"]).toBe("created");
    expect(body["jobId"]).toBeTypeOf("string");
    expect(jobCount()).toBe(1);
  });

  it("rejects ineligible, unknown, and unusable work items", async () => {
    const blocked = seedWorkItem(payloadJson());
    seedAttempt("TIMEOUT");
    const ineligible = await pasteContent(
      postRequest(`/api/attempts/${blocked}/content`, { html: "<p>x</p>" }),
      routeParams(blocked),
    );
    expect(ineligible.status).toBe(409);

    const missing = await pasteContent(
      postRequest("/api/attempts/does-not-exist/content", { html: "<p>x</p>" }),
      routeParams("does-not-exist"),
    );
    expect(missing.status).toBe(404);

    const unusable = seedWorkItem("{}");
    const badPayload = await pasteContent(
      postRequest(`/api/attempts/${unusable}/content`, { html: "<p>x</p>" }),
      routeParams(unusable),
    );
    expect(badPayload.status).toBe(400);

    const noOrigin = await pasteContent(
      postRequest(
        `/api/attempts/${blocked}/content`,
        { html: "<p>x</p>" },
        { host: "127.0.0.1:3000", origin: "" },
      ),
      routeParams(blocked),
    );
    expect(noOrigin.status).toBe(403);
    expect(jobCount()).toBe(0);
  });

  it("rejects oversized pastes", async () => {
    const workItemId = seedWorkItem(payloadJson());
    seedAttempt("EXTRACTION_INCOMPLETE");
    const response = await pasteContent(
      postRequest(`/api/attempts/${workItemId}/content`, {
        html: "x".repeat(5_000_001),
      }),
      routeParams(workItemId),
    );
    expect(response.status).toBe(413);
    expect(jobCount()).toBe(0);
  });
});
