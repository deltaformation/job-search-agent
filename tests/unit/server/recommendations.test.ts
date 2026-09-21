// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  candidateProfiles,
  candidateProfileVersions,
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  type DatabaseHandle,
} from "../../../src/db";
import { insertFact } from "../../../src/db/candidates";
import { activateProfileVersion, importCandidate } from "../../../src/server/candidates";
import { canonicalText } from "../../../src/domain/canonical";
import {
  getRecommendations,
  getTailoringReadiness,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import {
  seedV13Basics,
  v13ExtractionJson,
  withV13Database,
  V13_T0,
} from "../db/v13world";

/**
 * D2–D5 service leg: ownership vs freshness failures, JD readiness,
 * corrupt-storage fail-closed, approved-only evidence, determinism,
 * the ≤8-statement budget, and the Generate readiness gate E
 * enforces. Every path is read-only (ΔQ1=0) and provider-free.
 */

const JD = "TypeScript APIs with Redis caching and go-to-market launches. Jira boards.";

function seedBasicsWithJd(handle: DatabaseHandle, world: Parameters<typeof seedV13Basics>[1]) {
  return seedV13Basics(handle, world, { jdText: JD, extractedJson: v13ExtractionJson(JD) });
}

function countQueries(handle: DatabaseHandle, fn: () => void): number {
  const sqlite = handle.sqlite;
  const originalPrepare = sqlite.prepare;
  let queryCount = 0;
  sqlite.prepare = ((source: string) => {
    queryCount += 1;
    return originalPrepare.call(sqlite, source);
  }) as typeof sqlite.prepare;
  try {
    fn();
  } finally {
    sqlite.prepare = originalPrepare;
  }
  return queryCount;
}

/** Q1 probe (acceptance §1): all generation effects for one job. */
function q1(handle: DatabaseHandle, jobId: string): Record<string, number> {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
        (SELECT COUNT(*) FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?) AS reviews`,
    )
    .get(jobId, jobId, jobId, jobId) as Record<string, number>;
}

describe("getRecommendations", () => {
  it("builds exact snapshot bytes for the active binding", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const first = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.recommendations.extractionId).toBe(basics.extractionId);
      expect(first.recommendations.profileVersionId).toBe(basics.profileVersionId);
      expect(first.recommendations.jdHash).toBe(basics.jdHash);
      expect(first.recommendations.phrases.length).toBeGreaterThan(0);
      // Deterministic: same binding, same hash, no clock/provider input.
      const second = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(hashRecommendation(second.recommendations)).toBe(
        hashRecommendation(first.recommendations),
      );
      expect(q1(t.handle, basics.jobId)).toEqual({ requests: 0, work: 0, versions: 0, reviews: 0 });
    });
  });

  it("404s unknown jobs and foreign bindings", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const missingJob = getRecommendations(t.handle, {
        jobId: newId(),
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(missingJob).toMatchObject({ ok: false, failure: { error: "unknown-job" } });
      // Another job's extraction is foreign to this job.
      const other = seedV13Basics(t.handle, world, {
        jdText: JD,
        extractedJson: v13ExtractionJson(JD),
      });
      const foreign = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: other.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(foreign).toMatchObject({
        ok: false,
        failure: { error: "not-found", field: "extractionId" },
      });
      const missingVersion = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: newId(),
      });
      expect(missingVersion).toMatchObject({
        ok: false,
        failure: { error: "not-found", field: "profileVersionId" },
      });
    });
  });

  it("409s owned but no-longer-active extractions and versions", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      // A second extraction steals the active pointer.
      const attemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId: basics.jobId,
          canonicalUrl: "https://example.com/jobs/second",
          startedAt: V13_T0,
          finishedAt: V13_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      const secondId = newId();
      t.handle.db
        .insert(jobExtractions)
        .values({
          id: secondId,
          jobId: basics.jobId,
          scrapeAttemptId: attemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: v13ExtractionJson("Kubernetes operators and Helm charts."),
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: secondId })
        .where(eq(jobs.id, basics.jobId))
        .run();
      const staleExtraction = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(staleExtraction).toMatchObject({
        ok: false,
        failure: { error: "input-stale", field: "extractionId" },
      });
      // A second activated version retires the first.
      const imported = importCandidate(t.handle, {
        document: {
          schemaVersion: "candidate-import/v1",
          identity: { fullName: "Second Version" },
          employment: [],
          achievements: [],
        },
        actor: "human",
        profileId: basics.profileId,
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(
        activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" }).ok,
      ).toBe(true);
      const staleVersion = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: secondId,
        profileVersionId: basics.profileVersionId,
      });
      expect(staleVersion).toMatchObject({
        ok: false,
        failure: { error: "input-stale", field: "profileVersionId" },
      });
      // The fresh binding builds (all gaps: the new version has no facts).
      const fresh = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: secondId,
        profileVersionId: imported.versionId,
      });
      expect(fresh.ok).toBe(true);
    });
  });

  it("422s bindings without JD text and reads nothing else", () => {
    withV13Database((t, world) => {
      for (const description of [null, "   "]) {
        const basics = seedV13Basics(t.handle, world, {
          jdText: "placeholder",
          extractedJson: v13ExtractionJson(description),
        });
        const result = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: basics.profileVersionId,
        });
        expect(result).toMatchObject({
          ok: false,
          failure: { error: "jd-not-ready", field: "extractionId" },
        });
      }
    });
  });

  it("fails closed on corrupt stored envelopes and payloads", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const corruptEnvelope = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(corruptEnvelope).toMatchObject({
        ok: false,
        failure: { error: "storage-unavailable", field: "extractionId" },
      });
      const fixed = seedBasicsWithJd(t.handle, world);
      const profileId = newId();
      t.handle.db
        .insert(candidateProfiles)
        .values({ id: profileId, name: "broken", displayName: "Broken" })
        .run();
      const versionId = newId();
      t.handle.db
        .insert(candidateProfileVersions)
        .values({
          id: versionId,
          profileId,
          version: 1,
          payloadJson: "not json",
          payloadHash: "0".repeat(64),
          schemaVersion: "candidate-profile/v1",
          activatedAt: V13_T0,
        })
        .run();
      const corruptPayload = getRecommendations(t.handle, {
        jobId: fixed.jobId,
        extractionId: fixed.extractionId,
        profileVersionId: versionId,
      });
      expect(corruptPayload).toMatchObject({
        ok: false,
        failure: { error: "storage-unavailable", field: "profileVersionId" },
      });
    });
  });

  it("grades support from approved facts only", () => {
    withV13Database((t, world) => {
      const jd = "Kubernetes operators with TypeScript APIs.";
      const basics = seedV13Basics(t.handle, world, {
        jdText: jd,
        extractedJson: v13ExtractionJson(jd),
      });
      insertFact(t.handle, {
        factId: "fact-k8s-pending",
        profileVersionId: basics.profileVersionId,
        kind: "delivery",
        statement: "Operated Kubernetes clusters in production.",
        evidenceJson: null,
        verification: "PENDING",
        source: null,
      });
      const result = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const kubernetes = result.recommendations.phrases.find(
        (phrase) => phrase.text === "Kubernetes",
      );
      expect(kubernetes).toBeDefined();
      expect(kubernetes?.factIds).not.toContain("fact-k8s-pending");
      expect(kubernetes?.support).toBe("gap");
      for (const phrase of result.recommendations.phrases) {
        expect(phrase.factIds).not.toContain("fact-k8s-pending");
      }
    });
  });

  it("stays within the 8-statement budget beside history rows", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      for (let n = 0; n < 200; n += 1) {
        const jobId = newId();
        t.handle.db.insert(jobs).values({ id: jobId, status: "NEW", rowVersion: 1 }).run();
      }
      const queries = countQueries(t.handle, () => {
        const result = getRecommendations(t.handle, {
          jobId: basics.jobId,
          extractionId: basics.extractionId,
          profileVersionId: basics.profileVersionId,
        });
        expect(result.ok).toBe(true);
      });
      expect(queries).toBeLessThanOrEqual(8);
    });
  });

  it("serves W without active checks: builds owned, not-ready without JD", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const built = workspaceRecommendationsProvider.getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(built.ok).toBe(true);
      const empty = seedV13Basics(t.handle, world, {
        jdText: "placeholder",
        extractedJson: v13ExtractionJson(null),
      });
      const notReady = workspaceRecommendationsProvider.getRecommendations(t.handle, {
        jobId: empty.jobId,
        extractionId: empty.extractionId,
        profileVersionId: empty.profileVersionId,
      });
      expect(notReady).toMatchObject({ ok: false, error: "extraction-not-ready" });
      const corrupt = seedV13Basics(t.handle, world);
      const broken = workspaceRecommendationsProvider.getRecommendations(t.handle, {
        jobId: corrupt.jobId,
        extractionId: corrupt.extractionId,
        profileVersionId: corrupt.profileVersionId,
      });
      expect(broken).toMatchObject({ ok: false, error: "storage-unavailable" });
    });
  });
});

describe("getTailoringReadiness", () => {
  const KEYED_ENV = { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" };

  it("reports ready only with evidence, JD text, and a provider key", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const before = q1(t.handle, basics.jobId);
      const ready = getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(ready).toEqual({ ok: true });
      expect(q1(t.handle, basics.jobId)).toEqual(before);
    });
  });

  it("requires a bound version with approved facts first", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      expect(
        getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
          extractionId: basics.extractionId,
          profileVersionId: null,
        }),
      ).toMatchObject({ ok: false, failure: { error: "profile-not-ready" } });
      expect(
        getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
          extractionId: basics.extractionId,
          profileVersionId: newId(),
        }),
      ).toMatchObject({ ok: false, failure: { error: "profile-not-ready" } });
      // A version with no approved facts is not generatable.
      const imported = importCandidate(t.handle, {
        document: {
          schemaVersion: "candidate-import/v1",
          identity: { fullName: "No Facts" },
          employment: [],
          achievements: [],
        },
        actor: "human",
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect(
        getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
          extractionId: basics.extractionId,
          profileVersionId: imported.versionId,
        }),
      ).toMatchObject({ ok: false, failure: { error: "profile-not-ready" } });
    });
  });

  it("requires bound JD text before the provider key", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      expect(
        getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
          extractionId: null,
          profileVersionId: basics.profileVersionId,
        }),
      ).toMatchObject({ ok: false, failure: { error: "jd-not-ready" } });
      const empty = seedV13Basics(t.handle, world, {
        jdText: "placeholder",
        extractedJson: v13ExtractionJson("  "),
      });
      expect(
        getTailoringReadiness(t.handle, empty.jobId, KEYED_ENV, {
          extractionId: empty.extractionId,
          profileVersionId: empty.profileVersionId,
        }),
      ).toMatchObject({ ok: false, failure: { error: "jd-not-ready" } });
      // Foreign extractions are not ready either — never a fetch.
      const other = seedV13Basics(t.handle, world, {
        jdText: JD,
        extractedJson: v13ExtractionJson(JD),
      });
      expect(
        getTailoringReadiness(t.handle, basics.jobId, KEYED_ENV, {
          extractionId: other.extractionId,
          profileVersionId: basics.profileVersionId,
        }),
      ).toMatchObject({ ok: false, failure: { error: "jd-not-ready" } });
    });
  });

  it("requires a configured key for the active provider last", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const binding = {
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      };
      expect(getTailoringReadiness(t.handle, basics.jobId, {}, binding)).toMatchObject({
        ok: false,
        failure: { error: "provider-not-ready" },
      });
      expect(
        getTailoringReadiness(
          t.handle,
          basics.jobId,
          { ACTIVE_AI_PROVIDER: "google", OPENROUTER_API_KEY: "wrong-provider" },
          binding,
        ),
      ).toMatchObject({ ok: false, failure: { error: "provider-not-ready" } });
      expect(
        getTailoringReadiness(
          t.handle,
          basics.jobId,
          { ACTIVE_AI_PROVIDER: "google", GEMINI_API_KEY: "test-key" },
          binding,
        ),
      ).toEqual({ ok: true });
    });
  });

  it("fails unknown jobs without writes", () => {
    withV13Database((t, world) => {
      const basics = seedBasicsWithJd(t.handle, world);
      const before = q1(t.handle, basics.jobId);
      expect(
        getTailoringReadiness(t.handle, newId(), KEYED_ENV, {
          extractionId: basics.extractionId,
          profileVersionId: basics.profileVersionId,
        }),
      ).toMatchObject({ ok: false, failure: { error: "unknown-job" } });
      expect(q1(t.handle, basics.jobId)).toEqual(before);
    });
  });

  it("keeps canonical JD equality with the retained extraction bytes", () => {
    withV13Database((t, world) => {
      const jd = "  TypeScript APIs with Redis caching.\r\nSecond line.  ";
      const basics = seedV13Basics(t.handle, world, {
        jdText: jd,
        extractedJson: v13ExtractionJson(jd),
      });
      const result = getRecommendations(t.handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      expect(result.ok).toBe(true);
      // D1: the adapter cites canonicalText of the retained envelope
      // description — the same bytes Step 1 renders.
      expect(canonicalText(jd)).toBe("TypeScript APIs with Redis caching.\nSecond line.");
    });
  });
});
