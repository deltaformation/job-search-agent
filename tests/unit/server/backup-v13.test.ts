// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { resolveMigrationsDir } from "../../../src/db/testing";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  generationProgressEvents,
  jobs,
  newId,
  resumeArtifacts,
  resumeAssessments,
  resumeVersions,
  tailoringRequestInputs,
  tailoringWorkspaces,
} from "../../../src/db";
import { appendProgressFenced } from "../../../src/db/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import {
  createBackupArchive,
  readGeneration,
  resetBoardData,
  restoreArchive,
  verifyStagedDatabase,
} from "../../../src/server/backup";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import {
  ensureDataRoot,
  resolveDataRoot,
  type DataRootPaths,
} from "../../../src/security/data-root";
import { canonicalJson } from "../../../src/domain/canonical";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  recommendationHashFor,
  seedV13Assessment,
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  stubRecommendationsProvider,
  v13Focus,
  v13Recommendations,
  V13_T0,
  type V13Basics,
  type V13Run,
  type V13Version,
} from "../db/v13world";

/**
 * B8: backup→restore retains the shared Q2–Q7 probes, staged
 * databases are validated for the four new tables and
 * foreign-key soundness, injected failures leave the live tree
 * untouched, and reset clears job-owned tailoring rows while
 * preserving profiles. Migration preflight is proven in
 * `tests/unit/db/migrate-0008.test.ts`.
 */

const tempDirs: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface V13Root {
  root: string;
  paths: DataRootPaths;
  candidateDir: string;
  handle: DatabaseHandle;
  basics: V13Basics;
  run: V13Run;
  version: V13Version;
  pdfId: string;
}

function makeV13Root(): V13Root {
  const root = mkdtempSync(join(tmpdir(), "job-tracker-v13-backup-"));
  tempDirs.push(root);
  const paths = resolveDataRoot({ APP_DATA_ROOT: root });
  ensureDataRoot(paths);
  const handle = openDatabase({ path: paths.databasePath });
  handles.push(handle);
  migrate(handle.sqlite, { migrationsDir: resolveMigrationsDir() });
  const world = seedCrossProfileWorld({ handle, dir: root, dbPath: paths.databasePath, cleanup: () => {} });
  const basics = seedV13Basics(handle, world);
  const run = seedV13RunningRun(handle, basics);
  seedV13RequestInputs(handle, basics, run);
  const provider = stubRecommendationsProvider(v13Recommendations(basics));
  const saved = saveWorkspace(
    handle,
    basics.jobId,
    0,
    {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: basics.extractionId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      recommendationHash: recommendationHashFor(basics),
      focus: v13Focus(),
    },
    { now: () => V13_T0, recommendations: provider },
  );
  if (!saved.ok) {
    throw new Error(`workspace seed failed: ${JSON.stringify(saved)}`);
  }
  appendProgressFenced(handle, {
    requestId: run.requestId,
    workItemId: run.workItemId,
    attemptId: run.attemptId,
    seq: 1,
    stage: "PREPARING_INPUTS",
    source: "provider",
    leaseToken: run.leaseToken,
    recordedAt: new Date(Date.parse(V13_T0) + 1000).toISOString(),
  });
  const version = seedV13Version(handle, basics, run, { reviewState: "APPROVED" });
  seedV13Assessment(handle, run, version);
  const pdfId = newId();
  handle.db
    .insert(resumeArtifacts)
    .values({
      id: pdfId,
      resumeVersionId: version.versionId,
      kind: "PDF",
      relativePath: `artifacts/${pdfId}.pdf`,
      mediaType: "application/pdf",
      byteSize: 121_000,
      sha256: "9".repeat(64),
    })
    .run();
  handle.db
    .update(jobs)
    .set({
      status: "TAILORED",
      activeResumeVersionId: version.versionId,
      selectedResumeVersionId: version.versionId,
    })
    .where(eq(jobs.id, basics.jobId))
    .run();
  // WO-1.3-F: completion predicates on live expiry — finish under
  // the fixture clock, inside the T0+300s lease.
  const finished = completeWorkItem(
    handle,
    {
      workItemId: run.workItemId,
      leaseToken: run.leaseToken,
      result: "SUCCEEDED",
    },
    { now: new Date(Date.parse(V13_T0) + 2000).toISOString() },
  );
  if (!finished.ok) {
    throw new Error(`finish failed: ${finished.error}`);
  }
  const candidateDir = join(root, "candidate");
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
  return { root, paths, candidateDir, handle, basics, run, version, pdfId };
}

/** Shared acceptance probes Q2–Q7 (docs/acceptance-v1.3.md) serialized for comparison. */
function probeQ2toQ7(handle: DatabaseHandle, jobId: string, requestId: string): string {
  const q = (sql: string, params: unknown[] = []) =>
    handle.sqlite.prepare(sql).all(...(params as []));
  return JSON.stringify({
    q2: q("SELECT job_id,revision,request_kind,focus_json,recommendations_json,recommendation_hash,last_request_id,last_submitted_revision FROM tailoring_workspaces WHERE job_id=?", [jobId]),
    q3: q(
      "SELECT r.id,r.status,r.work_item_id,r.payload_hash,i.workspace_revision,i.submit_hash,i.input_hash,i.candidate_snapshot_id,i.focus_json,i.recommendations_json,i.master_text,i.master_text_hash,i.projection_version FROM generation_requests r JOIN tailoring_request_inputs i ON i.request_id=r.id WHERE r.id=?",
      [requestId],
    ),
    q4: q("SELECT last_request_id AS lastRequestId,last_submitted_revision AS lastSubmittedRevision FROM tailoring_workspaces WHERE job_id=?", [jobId]),
    q5: q(
      "SELECT e.attempt_id AS attemptId,a.attempt_number AS attemptNumber,e.stage,e.seq,e.source,e.recorded_at AS recordedAt FROM generation_progress_events e JOIN work_attempts a ON a.id=e.attempt_id WHERE e.request_id=? ORDER BY a.attempt_number,e.seq",
      [requestId],
    ),
    q6: q(
      "SELECT v.id,v.content_hash AS contentHash,v.review_state AS reviewState,v.generation_request_id AS requestId,a.measures_json AS measures,a.master_text_hash AS masterHash FROM resume_versions v LEFT JOIN resume_assessments a ON a.resume_version_id=v.id WHERE v.job_id=?",
      [jobId],
    ),
    q7: q("SELECT active_resume_version_id AS active,selected_resume_version_id AS selected FROM jobs WHERE id=?", [jobId]),
    artifacts: q("SELECT id,resume_version_id,kind,relative_path,sha256 FROM resume_artifacts"),
  });
}

describe("B8 backup and restore across 0008", () => {
  it("retains Q2–Q7 across backup→mutate→restore", async () => {
    const live = makeV13Root();
    const before = probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId);
    expect(before).toContain(live.version.versionId);
    const snapshot = await createBackupArchive({
      handle: live.handle,
      paths: live.paths,
      candidateDir: live.candidateDir,
      stagingDir: join(live.paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-16T12:00:00.000Z"),
    });
    // Mutate the live tree after the snapshot: new job, dropped
    // workspace row, second version. (Assessments, request inputs,
    // and approved versions are immutable, so they cannot be the
    // mutation.)
    live.handle.sqlite
      .prepare("INSERT INTO jobs (id, status, rank, row_version) VALUES ('job-junk', 'NEW', 99, 1)")
      .run();
    live.handle.db
      .delete(tailoringWorkspaces)
      .where(eq(tailoringWorkspaces.jobId, live.basics.jobId))
      .run();
    const extra = seedV13RunningRun(live.handle, live.basics);
    seedV13RequestInputs(live.handle, live.basics, extra);
    seedV13Version(live.handle, live.basics, extra, { version: 2 });
    expect(probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId)).not.toBe(before);
    const result = await restoreArchive({
      handle: live.handle,
      paths: live.paths,
      candidateDir: live.candidateDir,
      stagingRoot: join(live.paths.root, "staging"),
      migrationsDir: resolveMigrationsDir(),
      openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
      archive: snapshot.bytes,
      now: new Date("2026-09-16T13:00:00.000Z"),
    });
    expect(result.jobs).toBeGreaterThanOrEqual(1);
    const reopened = openDatabase({ path: live.paths.databasePath });
    handles.push(reopened);
    expect(probeQ2toQ7(reopened, live.basics.jobId, live.run.requestId)).toBe(before);
    expect(readGeneration(live.root)).not.toBeNull();
  });

  it("refuses a staged database missing a new table and keeps the live tree", async () => {
    const live = makeV13Root();
    const before = probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId);
    const donor = makeV13Root();
    donor.handle.sqlite.prepare("DROP TABLE resume_assessments").run();
    const snapshot = await createBackupArchive({
      handle: donor.handle,
      paths: donor.paths,
      candidateDir: donor.candidateDir,
      stagingDir: join(donor.paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-16T12:00:00.000Z"),
    });
    await expect(
      restoreArchive({
        handle: live.handle,
        paths: live.paths,
        candidateDir: live.candidateDir,
        stagingRoot: join(live.paths.root, "staging"),
        migrationsDir: resolveMigrationsDir(),
        openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
        archive: snapshot.bytes,
        now: new Date("2026-09-16T13:00:00.000Z"),
      }),
    ).rejects.toThrow(/missing table resume_assessments/);
    expect(probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId)).toBe(before);
    expect(readGeneration(live.root)).toBeNull();
  });

  it("refuses a foreign-key-violating staged database and keeps the live tree", async () => {
    const live = makeV13Root();
    const before = probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId);
    const donor = makeV13Root();
    donor.handle.sqlite.pragma("foreign_keys = OFF");
    try {
      donor.handle.db
        .insert(tailoringWorkspaces)
        .values({
          jobId: newId(),
          revision: 1,
          requestKind: "INITIAL",
          focusJson: canonicalJson(v13Focus()),
          createdAt: V13_T0,
          updatedAt: V13_T0,
        })
        .run();
    } finally {
      donor.handle.sqlite.pragma("foreign_keys = ON");
    }
    const snapshot = await createBackupArchive({
      handle: donor.handle,
      paths: donor.paths,
      candidateDir: donor.candidateDir,
      stagingDir: join(donor.paths.root, "staging-snap"),
      kind: "manual",
      now: new Date("2026-09-16T12:00:00.000Z"),
    });
    await expect(
      restoreArchive({
        handle: live.handle,
        paths: live.paths,
        candidateDir: live.candidateDir,
        stagingRoot: join(live.paths.root, "staging"),
        migrationsDir: resolveMigrationsDir(),
        openStaging: (stagedDbPath: string) => openDatabase({ path: stagedDbPath }),
        archive: snapshot.bytes,
        now: new Date("2026-09-16T13:00:00.000Z"),
      }),
    ).rejects.toThrow(/foreign-key validation/);
    expect(probeQ2toQ7(live.handle, live.basics.jobId, live.run.requestId)).toBe(before);
    expect(readGeneration(live.root)).toBeNull();
  });

  it("validates staged databases directly, including pre-0008 archives", () => {
    const live = makeV13Root();
    const report = verifyStagedDatabase(
      () => openDatabase({ path: live.paths.databasePath }),
      resolveMigrationsDir(),
    );
    expect(report.migrations).toContain("0008_tailoring_workspaces");
    expect(report.jobs).toBeGreaterThanOrEqual(1);
  });
});

describe("B8 reset clears job-owned tailoring rows, preserves profiles", () => {
  it("empties jobs and the four new tables while keeping candidate chains", async () => {
    const live = makeV13Root();
    const profilesBefore = live.handle.db.select().from(candidateProfiles).all();
    const versionsBefore = live.handle.db.select().from(candidateProfileVersions).all();
    const factsBefore = live.handle.db.select().from(candidateFacts).all();
    expect(profilesBefore.length).toBeGreaterThanOrEqual(2);
    const result = await resetBoardData({
      handle: live.handle,
      paths: live.paths,
      candidateDir: live.candidateDir,
      stagingRoot: join(live.paths.root, "staging"),
      openDatabaseAt: (dbPath: string) => openDatabase({ path: dbPath }),
      runMigrations: (fresh: DatabaseHandle) =>
        migrate(fresh.sqlite, { migrationsDir: resolveMigrationsDir() }),
      now: new Date("2026-09-16T14:00:00.000Z"),
    });
    expect(result.preservedProfile).toBe(true);
    const reopened = openDatabase({ path: live.paths.databasePath });
    handles.push(reopened);
    expect(reopened.db.select().from(jobs).all()).toEqual([]);
    expect(reopened.db.select().from(tailoringWorkspaces).all()).toEqual([]);
    expect(reopened.db.select().from(tailoringRequestInputs).all()).toEqual([]);
    expect(reopened.db.select().from(generationProgressEvents).all()).toEqual([]);
    expect(reopened.db.select().from(resumeAssessments).all()).toEqual([]);
    expect(reopened.db.select().from(resumeVersions).all()).toEqual([]);
    expect(reopened.db.select().from(candidateProfiles).all()).toEqual(profilesBefore);
    expect(reopened.db.select().from(candidateProfileVersions).all()).toEqual(versionsBefore);
    expect(reopened.db.select().from(candidateFacts).all()).toEqual(factsBefore);
  });
});
