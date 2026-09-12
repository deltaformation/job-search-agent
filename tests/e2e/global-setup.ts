import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ensureDatabase, openDatabase } from "../../src/db/client";
import { newId } from "../../src/db/utils";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobNotes,
  jobSources,
  jobs,
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  scrapeAttempts,
} from "../../src/db/schema";
import { ensureDataRoot, resolveRuntimeConfig } from "../../src/security/index";

/**
 * E2E seed: wipes .e2e-data, migrates a fresh database, and inserts a
 * deterministic board (two NEW cards, one TAILORED card with a note).
 * Runs before the web server boots; the supervisor's own setup is a
 * no-op on top of the migrated database.
 */
export default async function globalSetup(): Promise<void> {
  const root = join(process.cwd(), ".e2e-data");
  rmSync(root, { recursive: true, force: true });
  const env = { ...process.env, APP_DATA_ROOT: root, PORT: "3107" };
  const config = resolveRuntimeConfig(env, process.cwd());
  ensureDataRoot(config);
  mkdirSync(join(root, "evidence"), { recursive: true });
  const migrated = ensureDatabase({
    path: config.databasePath,
    migrationsDir: join(process.cwd(), "drizzle"),
  });
  migrated.close();

  const handle = openDatabase({ path: config.databasePath });
  try {
    const alpha = newId();
    handle.db
      .insert(jobs)
      .values({
        id: alpha,
        status: "NEW",
        rank: 0,
        rowVersion: 1,
        title: "E2E Alpha Engineer",
        company: "Probe Corp",
        location: "Remote",
      })
      .run();
    handle.db
      .insert(jobSources)
      .values({
        id: newId(),
        jobId: alpha,
        submittedUrl: "https://example.com/jobs/e2e-alpha",
        canonicalUrl: "https://example.com/jobs/e2e-alpha",
        canonicalKey: "url:https://example.com/jobs/e2e-alpha",
      })
      .run();
    const beta = newId();
    handle.db
      .insert(jobs)
      .values({
        id: beta,
        status: "NEW",
        rank: 1,
        rowVersion: 1,
        title: "E2E Beta Designer",
        company: "Probe Corp",
        location: "Berlin",
      })
      .run();
    const gamma = newId();
    handle.db
      .insert(jobs)
      .values({
        id: gamma,
        status: "NEW",
        rank: 2,
        rowVersion: 1,
        title: "E2E Gamma Tester",
        company: "Probe Corp",
        tailoringState: "AWAITING_REVIEW",
      })
      .run();

    // Profile and snapshot
    handle.db.insert(candidateProfiles).values({ id: "local" }).run();
    const profileVersionId = newId();
    handle.db
      .insert(candidateProfileVersions)
      .values({
        id: profileVersionId,
        profileId: "local",
        version: 1,
        payloadJson: "{}",
        payloadHash: "0".repeat(64),
        schemaVersion: "candidate-profile-v1",
      })
      .run();
    handle.db
      .insert(candidateFacts)
      .values({
        factId: "f1",
        profileVersionId,
        kind: "experience",
        statement: "Led test automation migration in TypeScript with 99.9% reliability.",
        verification: "APPROVED",
      })
      .run();
    const candidateSnapshotId = newId();
    handle.db
      .insert(candidateSnapshots)
      .values({
        id: candidateSnapshotId,
        profileVersionId,
        canonicalJson: "{}",
        schemaVersion: "candidate-snapshot-v1",
        sha256: "1".repeat(64),
      })
      .run();
    handle.db.insert(candidateSnapshotFacts).values({ snapshotId: candidateSnapshotId, factId: "f1" }).run();

    // Scrape attempt & extraction for gamma
    const attemptId = newId();
    const now = new Date().toISOString();
    handle.db
      .insert(scrapeAttempts)
      .values({
        id: attemptId,
        jobId: gamma,
        canonicalUrl: "https://example.com/jobs/e2e-gamma",
        startedAt: now,
        finishedAt: now,
        outcome: "SUCCEEDED",
      })
      .run();
    const extractionId = newId();
    handle.db
      .insert(jobExtractions)
      .values({
        id: extractionId,
        jobId: gamma,
        scrapeAttemptId: attemptId,
        version: 1,
        schemaVersion: "job-extraction-v1",
        adapter: "generic",
        extractedJson: "{}",
      })
      .run();
    handle.db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, gamma)).run();

    // JD snapshot
    const jdSnapshotId = newId();
    handle.db
      .insert(jdSnapshots)
      .values({
        id: jdSnapshotId,
        jobId: gamma,
        extractionId,
        jdText: "We require TypeScript testing experience and Kubernetes cluster management.",
        canonicalSha256: "2".repeat(64),
      })
      .run();

    // Job Analysis with requirements & gaps
    const analysisId = newId();
    handle.db
      .insert(jobAnalyses)
      .values({
        id: analysisId,
        jobId: gamma,
        jdSnapshotId,
        candidateSnapshotId,
        requirementsJson: JSON.stringify({
          schemaVersion: "analysis-requirements/v1",
          requirements: [
            {
              requirement_id: "req_ts",
              jd_quote: "TypeScript testing experience",
              category: "skill",
              importance: "required",
              match_status: "matched",
              evidence_fact_ids: ["f1"],
              evidence_quotes: ["Led test automation migration in TypeScript."],
              review_status: "confirmed",
            },
          ],
        }),
        gapsJson: JSON.stringify({
          schemaVersion: "analysis-gaps/v1",
          gaps: [
            {
              requirement_id: "req_k8s",
              jd_quote: "Kubernetes cluster management",
              category: "skill",
              importance: "required",
              match_status: "gap",
            },
          ],
        }),
        provider: "e2e-provider",
        model: "e2e-model",
        promptVersion: "tailor-prompt/v1",
        proposalSchemaVersion: "resume-proposal/v1",
        rationale: "Requirement supported by candidate fact f1; Kubernetes identified as gap.",
      })
      .run();

    // Resume version
    const versionId = newId();
    const contentHash = "c".repeat(64);
    handle.db
      .insert(resumeVersions)
      .values({
        id: versionId,
        jobId: gamma,
        version: 1,
        parentVersionId: null,
        analysisId,
        templateId: "standard",
        templateVersion: "v1",
        templateHash: "t".repeat(64),
        rankerVersion: "ranker-v1",
        policyVersion: "policy-v1",
        configVersion: "config-v1",
        renderSchemaVersion: "render-v1",
        contentJson: JSON.stringify({
          schemaVersion: "resume-content/v1",
          summaryStrategy: "fact-grounded",
          omittedUnsupported: ["Kubernetes cluster management"],
          changeSummary: {
            addedBullets: ["Led test automation migration in TypeScript with 99.9% reliability."],
            removedBullets: [],
            summaryChanged: true,
            baselineLines: 35,
            tailoredLines: 38,
          },
          audit: {
            requirementsTotal: 2,
            supportedCount: 1,
            gapCount: 1,
            validatedClaims: 1,
            totalClaims: 1,
            rationale: "One requirement supported, one gap reported.",
            questions: [],
          },
        }),
        contentHash,
        reviewState: "AWAITING_REVIEW",
      })
      .run();
    handle.db.update(jobs).set({ activeResumeVersionId: versionId }).where(eq(jobs.id, gamma)).run();

    // Resume claim & fact citation
    const claimId = newId();
    handle.db
      .insert(resumeClaims)
      .values({
        id: claimId,
        resumeVersionId: versionId,
        claimText: "Led test automation migration in TypeScript with 99.9% reliability.",
        requirementRef: "req_ts",
        derivationKind: null,
        derivationPayload: null,
      })
      .run();
    handle.db.insert(resumeClaimFacts).values({ claimId, factId: "f1" }).run();

    // Artifacts on disk
    const artifactDir = join(config.artifactsDir, "resumes", gamma);
    mkdirSync(artifactDir, { recursive: true });
    const artifacts: Array<{ kind: "MARKDOWN" | "DOCX" | "PDF"; ext: string; mediaType: string; content: Buffer }> = [
      {
        kind: "MARKDOWN",
        ext: "md",
        mediaType: "text/markdown; charset=utf-8",
        content: Buffer.from("# E2E Gamma Tester Resume\n\n- Led test automation migration in TypeScript.\n", "utf8"),
      },
      {
        kind: "DOCX",
        ext: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: Buffer.from("PK-fake-docx-e2e-bytes", "utf8"),
      },
      {
        kind: "PDF",
        ext: "pdf",
        mediaType: "application/pdf",
        content: Buffer.from("%PDF-1.4 fake-pdf-e2e-bytes", "utf8"),
      },
    ];
    for (const a of artifacts) {
      const relPath = `resumes/${gamma}/v1_${contentHash.slice(0, 8)}.${a.ext}`;
      writeFileSync(join(config.artifactsDir, relPath), a.content);
      const sha256 = createHash("sha256").update(a.content).digest("hex");
      handle.db
        .insert(resumeArtifacts)
        .values({
          id: newId(),
          resumeVersionId: versionId,
          kind: a.kind,
          relativePath: relPath,
          mediaType: a.mediaType,
          byteSize: a.content.length,
          sha256,
        })
        .run();
    }

    const tailored = newId();
    handle.db
      .insert(jobs)
      .values({
        id: tailored,
        status: "TAILORED",
        rank: 0,
        rowVersion: 1,
        title: "E2E Tailored Analyst",
        company: "Probe Corp",
      })
      .run();
    handle.db
      .insert(jobNotes)
      .values({ id: newId(), jobId: tailored, body: "seeded note" })
      .run();
  } finally {
    handle.close();
  }
}
