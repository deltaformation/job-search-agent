// @vitest-environment node
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  ensureDatabase,
  generationRequests,
  migrate,
  newId,
  resolveMigrationsDir,
  utcNow,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { createProfile, setDefaultProfile, updateProfile } from "../../../src/db/candidates";
import { jobAnalyses, resumeVersions } from "../../../src/db/schema";
import { getResumeReviewView } from "../../../src/server/review";
import { PM_GUIDANCE, runWithWorld, type CrossProfileWorld } from "./world";

/**
 * Guidance history acceptance (R-ADR-017, §7 row F7). WO-1.2-D owns
 * persistence: the request row carries the exact submitted guidance
 * (guard below, passing), and legacy absence stays a passing
 * regression test (no fabricated guidance for versions without
 * recorded inputs — the "not recorded" rule). WO-1.2-F owns display:
 * the two F7 pins are flipped to passing — the review view surfaces
 * the recorded guidance in stored canonical order, invariant under
 * later default/profile mutations.
 */

interface GuidanceView {
  profileId?: unknown;
  profileVersionId?: unknown;
  profileVersionNumber?: unknown;
  profileDisplayName?: unknown;
  selectedKeywords?: unknown;
  directives?: unknown;
  revisionNote?: unknown;
}

function readGuidance(view: unknown): GuidanceView | undefined {
  return (view as { guidance?: GuidanceView }).guidance;
}

/**
 * Later default/profile changes that must never rewrite recorded
 * history. Shared by the guard (which proves the mutation path works)
 * and the invariance pin.
 */
function mutateProfiles(handle: DatabaseHandle, world: CrossProfileWorld): void {
  const third = createProfile(handle, { name: "staff", displayName: "Staff Engineer" });
  if (!setDefaultProfile(handle, third.id)) {
    throw new Error("mutation setup failed: setDefaultProfile returned false");
  }
  const updated = updateProfile(
    handle,
    world.pmProfileId,
    { executiveNarrative: "Rewritten positioning." },
    utcNow(),
  );
  if (updated === null) {
    throw new Error("mutation setup failed: updateProfile returned null");
  }
}

describe("guidance history (R-ADR-017)", () => {
  it("legacy versions expose no fabricated guidance (not-recorded rule)", () => {
    // Honest legacy shape: rows written before 0007 carry NULL linkage
    // (new writes cannot — the triggers forbid it), so the view must
    // surface no guidance rather than inventing any.
    const realDir = resolveMigrationsDir();
    const legacyDir = mkdtempSync(join(tmpdir(), "job-tracker-guidance-legacy-"));
    const dbDir = mkdtempSync(join(tmpdir(), "job-tracker-guidance-db-"));
    try {
      for (const file of readdirSync(realDir)) {
        if (file.endsWith(".sql") && file < "0007_generation_requests.sql") {
          copyFileSync(join(realDir, file), join(legacyDir, file));
        }
      }
      const handle = ensureDatabase({
        path: join(dbDir, "legacy.sqlite"),
        migrationsDir: legacyDir,
      });
      try {
        // Raw SQL throughout: drizzle's inserts name current columns the
        // legacy tables predate.
        const sqlite = handle.sqlite;
        const jobId = newId();
        sqlite.prepare("INSERT INTO jobs (id) VALUES (?)").run(jobId);
        const extractionId = newId();
        const scrapeId = newId();
        sqlite
          .prepare(
            `INSERT INTO scrape_attempts
               (id, job_id, canonical_url, started_at, finished_at, outcome, worker_id)
             VALUES (?, ?, 'https://example.com/jobs/legacy',
                     '2026-09-11T12:00:00.000Z', '2026-09-11T12:00:00.000Z', 'SUCCEEDED', 'seed')`,
          )
          .run(scrapeId, jobId);
        sqlite
          .prepare(
            `INSERT INTO job_extractions
               (id, job_id, scrape_attempt_id, version, schema_version, adapter, extracted_json)
             VALUES (?, ?, ?, 1, 'extraction-v1', 'generic', '{}')`,
          )
          .run(extractionId, jobId, scrapeId);
        const jdSnapshotId = newId();
        sqlite
          .prepare(
            `INSERT INTO jd_snapshots (id, job_id, extraction_id, jd_text, canonical_sha256)
             VALUES (?, ?, ?, 'Legacy builder role.', 'legacy-jd')`,
          )
          .run(jdSnapshotId, jobId, extractionId);
        sqlite
          .prepare(
            `INSERT INTO candidate_profiles (id, name, display_name, is_default)
             VALUES ('legacy-profile', 'legacy', 'Legacy', 1)`,
          )
          .run();
        sqlite
          .prepare(
            `INSERT INTO candidate_profile_versions
               (id, profile_id, version, payload_json, payload_hash, schema_version)
             VALUES ('legacy-version', 'legacy-profile', 1, '{}', 'legacy-hash', 'candidate-profile-v1')`,
          )
          .run();
        const snapshotId = newId();
        sqlite
          .prepare(
            `INSERT INTO candidate_snapshots
               (id, profile_version_id, canonical_json, schema_version, sha256)
             VALUES (?, 'legacy-version', '{}', 'snapshot-v1', 'legacy-snapshot')`,
          )
          .run(snapshotId);
        const analysisId = newId();
        sqlite
          .prepare(
            `INSERT INTO job_analyses
               (id, job_id, jd_snapshot_id, candidate_snapshot_id,
                requirements_json, gaps_json, prompt_version, proposal_schema_version)
             VALUES (?, ?, ?, ?, '[]', '[]', 'prompt-v1', 'proposal-v1')`,
          )
          .run(analysisId, jobId, jdSnapshotId, snapshotId);
        const versionId = newId();
        sqlite
          .prepare(
            `INSERT INTO resume_versions
               (id, job_id, version, analysis_id, template_id, template_version,
                template_hash, ranker_version, policy_version, config_version,
                render_schema_version, content_json, content_hash, review_state)
             VALUES (?, ?, 1, ?, 'standard', 'v1', 't', 'r', 'p', 'c', 'render-v1',
                     '{}', 'legacy-content', 'AWAITING_REVIEW')`,
          )
          .run(versionId, jobId, analysisId);
        sqlite
          .prepare("UPDATE jobs SET active_resume_version_id = ?, active_extraction_id = ? WHERE id = ?")
          .run(versionId, extractionId, jobId);

        const result = migrate(handle.sqlite, { migrationsDir: realDir });
        expect(result.applied).toEqual([
          "0007_generation_requests",
          "0008_tailoring_workspaces",
          "0009_step2_preparation",
          "0010_step2_publish_fence",
          "0011_step2_correction_versions",
        ]);

        const stored = handle.db
          .select()
          .from(jobAnalyses)
          .where(eq(jobAnalyses.id, analysisId))
          .get();
        expect(stored?.generationRequestId).toBeNull();
        const storedVersion = handle.db
          .select()
          .from(resumeVersions)
          .where(eq(resumeVersions.id, versionId))
          .get();
        expect(storedVersion?.generationRequestId).toBeNull();
        const view = getResumeReviewView(handle, versionId);
        expect(view?.version.id).toBe(versionId);
        const guidance = readGuidance(view);
        expect(guidance).toBeNull();
        expect(guidance?.profileId).toBeUndefined();
        expect(guidance?.profileVersionId).toBeUndefined();
        expect(guidance?.profileVersionNumber).toBeUndefined();
        expect(guidance?.profileDisplayName).toBeUndefined();
        expect(guidance?.selectedKeywords).toBeUndefined();
        expect(guidance?.directives).toBeUndefined();
        expect(guidance?.revisionNote).toBeUndefined();
      } finally {
        handle.close();
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("guard: guided v1 world carries exact known inputs", () => {
    runWithWorld((t, world) => {
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, world.v1WorkItemId))
        .get();
      const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;
      expect(payload["schemaVersion"]).toBe("tailor-queue/v2");
      expect(payload["generationRequestId"]).toBe(world.v1RequestId);
      // D persists guidance on the request row (the payload carries
      // bindings + hash only); F will surface it on the review view.
      const request = t.handle.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, world.v1RequestId))
        .get();
      expect(request).toMatchObject({
        profileId: world.pmProfileId,
        profileVersionId: world.pmVersionId,
        directivesText: PM_GUIDANCE.directives,
      });
      expect(JSON.parse(String(request?.selectedKeywordsJson))).toEqual(
        [...PM_GUIDANCE.selectedKeywords].sort(),
      );
      const view = getResumeReviewView(t.handle, world.v1Id);
      expect(view?.version.id).toBe(world.v1Id);
      mutateProfiles(t.handle, world);
    });
  });

  it("review exposes the exact recorded guidance (F7)", () => {
    runWithWorld((t, world) => {
      const view = getResumeReviewView(t.handle, world.v1Id);
      // Flipped by WO-1.2-F: the review view surfaces the frozen
      // request bindings. Keywords assert in RECORDED (canonical
      // sorted) order — submission chip order is not stored by design
      // (R-ADR-017 canonical set semantics), so the view reports the
      // stored set rather than reconstructing an order. The v1 INITIAL
      // request carries no revision note.
      expect(readGuidance(view)).toEqual({
        profileId: world.pmProfileId,
        profileVersionId: world.pmVersionId,
        profileVersionNumber: 1,
        profileDisplayName: "Product Manager",
        selectedKeywords: [...PM_GUIDANCE.selectedKeywords].sort(),
        directives: PM_GUIDANCE.directives,
        revisionNote: null,
      });
    });
  });

  it("recorded guidance survives later default/profile changes (F7)", () => {
    runWithWorld((t, world) => {
      const before = readGuidance(getResumeReviewView(t.handle, world.v1Id));
      // Flipped by WO-1.2-F: guidance must be present (no early
      // return — a null regression must fail here, not pass
      // vacuously). The frozen bindings (including the
      // generation-time display name) never follow later default
      // switches or narrative edits.
      expect(before).not.toBeNull();
      expect(before).toBeDefined();
      mutateProfiles(t.handle, world);
      expect(readGuidance(getResumeReviewView(t.handle, world.v1Id))).toEqual(before);
    });
  });
});
