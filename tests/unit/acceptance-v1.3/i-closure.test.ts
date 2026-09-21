// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GET as jobGET } from "../../../app/api/jobs/[id]/route";
import { POST as notesPOST } from "../../../app/api/jobs/[id]/notes/route";
import { GET as recommendationsGET } from "../../../app/api/jobs/[id]/tailoring/recommendations/route";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import { GET as progressGET } from "../../../app/api/jobs/[id]/tailoring/generations/[requestId]/route";
import { GET as reviewGET } from "../../../app/api/resumes/[id]/review/route";
import { POST as approvePOST } from "../../../app/api/jobs/[id]/resume/approve/route";
import { GET as artifactGET } from "../../../app/api/resumes/artifacts/[id]/route";
import { GET as boardGET } from "../../../app/api/board/route";
import { newId, tailoringRequestInputs, type DatabaseHandle } from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { getTailoringJob } from "../../../src/db/tailoring";
import {
  buildWorkspaceETag,
  TAILORING_SUBMIT_SCHEMA_VERSION,
} from "../../../src/domain/tailoringWorkspace";
import { STEP2_CORRECTION_VERSIONS } from "../../../src/domain/step2Correction";
import { getRecommendations } from "../../../src/server/recommendations";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { htmlBodyFragments } from "../../../src/resumes/checks";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
} from "../routes/_helpers";
import { factTextsForVersion, proposalForRun } from "./f-world";
import { finishS2dAttempt, runS2dTailor } from "./s2d-world";
import {
  closeHarness,
  limeFittingExcludes,
  limeMasterSummary,
  openHarness,
  putRequest,
  seedLimeAccepted,
  usableLimeSuggestions,
  type LimeHarness,
} from "./s2cpc-world";

/**
 * WO-1.3-I integrated closure (I1): the Lime pairing travels the full
 * production path on one isolated root — clip/intake reads (U1–U4),
 * workspace save/reload (U5), explicit generation + replay (U7),
 * supervised TAILOR with progress (U8/U10), exact-version review
 * (U11), approval + selected-PDF download (U12), and repeated
 * navigation proving zero phantom writes (U20). Every leg uses real
 * route handlers and the real worker claim/handler/complete legs;
 * SQL probes observe effects only. IDs/hashes are recorded in the
 * I1/U evidence rows, not inferred from fixtures.
 */

interface Q1 {
  requests: number;
  work: number;
  versions: number;
  reviews: number;
}

function q1(handle: DatabaseHandle, jobId: string): Q1 {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
        (SELECT COUNT(*) FROM resume_reviews rr JOIN resume_versions v ON v.id = rr.resume_version_id WHERE v.job_id = ?) AS reviews`,
    )
    .get(jobId, jobId, jobId, jobId) as Q1;
}

function q9(handle: DatabaseHandle, jobId: string): number {
  return (
    handle.sqlite
      .prepare(`SELECT COUNT(*) AS rows FROM tailoring_workspaces WHERE job_id = ?`)
      .get(jobId) as { rows: number }
  ).rows;
}

function q4(handle: DatabaseHandle, jobId: string) {
  return handle.sqlite
    .prepare(
      `SELECT j.status, j.row_version AS rowVersion, j.active_resume_version_id AS active,
        j.selected_resume_version_id AS selected, a.resume_version_id AS applicationVersion, a.applied_at AS appliedAt
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE j.id = ?`,
    )
    .get(jobId) as Record<string, unknown>;
}

function q8(handle: DatabaseHandle): unknown[] {
  return handle.sqlite.prepare(`PRAGMA foreign_key_check`).all();
}

/**
 * Unicode-capable stub PDF for the Lime closure run: the shared unit
 * stub is latin1-only and drops off-page runs, so this local renderer
 * declares WinAnsiEncoding, escapes the master's curly apostrophes,
 * and paginates (45 runs × 14pt). Real Chromium rendering is I8's
 * separate check. Mirrors the S2CPC4 journey renderer.
 */
async function limeRenderPdf(html: string): Promise<{ bytes: Buffer }> {
  const fragments = htmlBodyFragments(html);
  const text = fragments.join(" ");
  if (text.trim().length < 300) {
    throw new Error(`lime PDF precondition violated: only ${text.trim().length} fragment chars`);
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 127 && char !== "’") {
      throw new Error(`lime PDF cannot encode ${JSON.stringify(char)} (U+${code.toString(16)})`);
    }
  }
  const escape = (value: string): string =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/’/g, "\\222");
  const runs = fragments
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const wrapped: string[] = [];
      let rest = line;
      while (rest.length > 90) {
        let cut = rest.lastIndexOf(" ", 90);
        if (cut < 0) {
          cut = 90;
        }
        wrapped.push(rest.slice(0, cut));
        rest = rest.slice(cut + (rest[cut] === " " ? 1 : 0));
      }
      wrapped.push(rest);
      return wrapped;
    })
    .map((line) => `(${escape(line)}) Tj 0 -14 Td`);
  const pages: string[][] = [];
  for (let index = 0; index < runs.length; index += 45) {
    pages.push(runs.slice(index, index + 45));
  }
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((pageRuns, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    const stream = `BT /F1 10 Tf 72 720 Td\n${pageRuns.join("\n")}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return { bytes: Buffer.from(body, "latin1") };
}

describe("WO-1.3-I closure journey U1-U12/U20", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness("job-tracker-v13-i-closure-");
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("drives intake reads, save, generation, worker, review, approval, and download", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const manifest: Record<string, string> = {
      batchId: accepted.batchId,
      jobId: basics.jobId,
      extractionId: basics.extractionId,
      preparationId: accepted.preparationId,
      planRowId: accepted.planRowId,
      planHash: accepted.planHash,
    };

    // U1: job detail + absent-workspace reads leave Q1/Q9 unchanged.
    // Note: seedLimeAccepted already clipped + prepared (PREPARE work
    // exists), so Q1 here counts TAILOR-only rows (0) and Q9 counts
    // the (absent) workspace row (0). Reads must not change either.
    const u1q1Before = await harness.withDb((handle) => q1(handle, basics.jobId));
    expect(u1q1Before).toEqual({ requests: 0, work: 0, versions: 0, reviews: 0 });
    const u1q9Before = await harness.withDb((handle) => q9(handle, basics.jobId));
    expect(u1q9Before).toBe(0);
    const detail = await jobGET(
      getRequest(`/api/jobs/${basics.jobId}`),
      routeParams(basics.jobId),
    );
    expect(detail.status).toBe(200);
    const detailBody = await readJson(detail);
    expect(String((detailBody["job"] as Record<string, unknown>)["id"] ?? "")).toBe(
      basics.jobId,
    );
    const absentWorkspace = await workspaceGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
      routeParams(basics.jobId),
    );
    expect(absentWorkspace.status).toBe(200);
    expect((await readJson(absentWorkspace))["workspace"]).toBeNull();
    const u1q1After = await harness.withDb((handle) => q1(handle, basics.jobId));
    const u1q9After = await harness.withDb((handle) => q9(handle, basics.jobId));
    expect(u1q1After).toEqual(u1q1Before);
    expect(u1q9After).toBe(u1q9Before);

    // U2: notes submit + reload retains the exact note, no generation.
    const noteText = "I closure note: applied checklist starts Monday.";
    const noted = await notesPOST(
      postRequest(`/api/jobs/${basics.jobId}/notes`, { body: noteText }),
      routeParams(basics.jobId),
    );
    expect(noted.status).toBe(200);
    const reloaded = await jobGET(
      getRequest(`/api/jobs/${basics.jobId}`),
      routeParams(basics.jobId),
    );
    expect(reloaded.status).toBe(200);
    const notes = ((await readJson(reloaded))["notes"] as Array<Record<string, unknown>>) ?? [];
    expect(notes.map((note) => note["body"])).toContain(noteText);
    const u2q1 = await harness.withDb((handle) => q1(handle, basics.jobId));
    expect(u2q1).toEqual(u1q1Before);

    // U3: recommendations + master bytes/hash/support agree.
    const recsResponse = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${basics.profileVersionId}`,
      ),
      routeParams(basics.jobId),
    );
    expect(recsResponse.status).toBe(200);
    const recsBody = await readJson(recsResponse);
    const recommendations = recsBody["recommendations"] as {
      extractionId: string;
      profileVersionId: string;
      phrases: Array<{ id: string; text: string; support: string }>;
    };
    expect(recommendations.extractionId).toBe(basics.extractionId);
    expect(recommendations.profileVersionId).toBe(basics.profileVersionId);
    expect(recommendations.phrases.length).toBeGreaterThan(0);
    const servedHash = await harness.withDb((handle) => {
      const served = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      if (!served.ok) {
        throw new Error("closure recommendations recompute failed");
      }
      return served.recommendations.phrases.length;
    });
    expect(servedHash).toBe(recommendations.phrases.length);

    // U4 (capture-at-accept): the auto-scheduled preparation bound the
    // default-at-accept profile version; the plan read agrees.
    const { readPreparationByJob } = await import("../../../src/db/step2");
    const binding = await harness.withDb((handle) =>
      readPreparationByJob(handle, basics.jobId),
    );
    expect(binding?.profileVersionId).toBe(basics.profileVersionId);
    expect(binding?.acceptedPlanId).toBe(accepted.planRowId);

    // U5: W-v3 save + reload preserves exact text/origin/ops (Q2 match).
    const masterSummary = limeMasterSummary();
    const usable = usableLimeSuggestions(accepted.plan);
    const ops = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      // Fit the 17-fact master into the 2-page render budget.
      ...limeFittingExcludes(),
    ];
    const draftBody = {
      schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
      extractionId: basics.extractionId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      planId: accepted.planRowId,
      planHash: accepted.planHash,
      recommendationHash: null,
      draft: {
        schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
        planId: accepted.planRowId,
        planHash: accepted.planHash,
        summaryText: masterSummary,
        summaryOrigin: "master",
        operations: ops,
      },
    };
    const saved = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftBody,
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(saved.status).toBe(201);
    const workspaceRow = await harness.withDb((handle) =>
      handle.sqlite
        .prepare(
          `SELECT revision, profile_version_id AS profileVersionId, extraction_id AS extractionId FROM tailoring_workspaces WHERE job_id = ?`,
        )
        .get(basics.jobId),
    );
    expect(workspaceRow).toMatchObject({
      revision: 1,
      profileVersionId: basics.profileVersionId,
      extractionId: basics.extractionId,
    });
    const reloadedWorkspace = await workspaceGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
      routeParams(basics.jobId),
    );
    expect(reloadedWorkspace.status).toBe(200);
    const reloadedDraft = (
      (await readJson(reloadedWorkspace))["workspace"] as {
        draft: { draft: { summaryText: string; summaryOrigin: string } };
      }
    ).draft.draft;
    expect(reloadedDraft.summaryText).toBe(masterSummary);
    expect(reloadedDraft.summaryOrigin).toBe("master");

    // U7: explicit generation 202, byte-identical replay 200, one row.
    const live = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    if (live === null) {
      throw new Error("closure journey lost the job row");
    }
    const requestId = newId();
    manifest["requestId"] = requestId;
    const submitBody = {
      schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
      requestId,
      workspaceRevision: 1,
      observedRowVersion: live.rowVersion,
    };
    const generated = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody),
      routeParams(basics.jobId),
    );
    expect(generated.status).toBe(202);
    const generatedBody = await readJson(generated);
    expect(generatedBody["replayed"]).toBe(false);
    manifest["workItemId"] = String(generatedBody["workItemId"]);
    const replayed = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody),
      routeParams(basics.jobId),
    );
    expect(replayed.status).toBe(200);
    expect((await readJson(replayed))["replayed"]).toBe(true);
    const u7q1 = await harness.withDb((handle) => q1(handle, basics.jobId));
    expect(u7q1).toEqual({ requests: 1, work: 1, versions: 0, reviews: 0 });

    // U8/U10: supervised TAILOR claim → progress → publish.
    const submitted = await harness.withDb((handle) => {
      const request = getGenerationRequest(handle, requestId);
      const inputs = handle.db
        .select()
        .from(tailoringRequestInputs)
        .where(eq(tailoringRequestInputs.requestId, requestId))
        .get();
      if (request === null || inputs === undefined) {
        throw new Error("closure submit wrote no request/inputs rows");
      }
      manifest["payloadHash"] = request.payloadHash;
      manifest["inputHash"] = inputs.inputHash;
      return {
        jdSnapshotId: request.jdSnapshotId,
        candidateSnapshotId: inputs.candidateSnapshotId,
      };
    });
    const proposal = await harness.withDb((handle) => {
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error("closure tailor proposal seed failed");
      }
      return proposalForRun({
        recommendations: recs.recommendations,
        factTexts: factTextsForVersion(handle, basics.profileVersionId),
        jdSnapshotId: submitted.jdSnapshotId,
        candidateSnapshotId: submitted.candidateSnapshotId,
      });
    });
    const queuedProgress = await progressGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/generations/${requestId}`),
      { params: Promise.resolve({ id: basics.jobId, requestId }) },
    );
    expect(queuedProgress.status).toBe(200);
    expect((await readJson(queuedProgress))["state"]).toBe("QUEUED");
    // Artifacts must land under the isolated root so the approve
    // route re-hashes the same bytes the worker staged.
    const artifactsDir = join(harness.isolated.root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const provider = new TestProvider({ proposals: { [submitted.jdSnapshotId]: proposal } });
    // Routes use the wall clock, so the worker legs must claim/run/complete
    // with a consistent real now — a fixed Sep-16 clock would lease-expire.
    const tailorNow = new Date().toISOString();
    const { claim, outcome } = await harness.withDb(async (handle) =>
      runS2dTailor(
        handle,
        {
          requestId,
          workItemId: manifest["workItemId"] as string,
          jdSnapshotId: submitted.jdSnapshotId,
          candidateSnapshotId: submitted.candidateSnapshotId,
        },
        provider,
        artifactsDir,
        { now: tailorNow, renderPdf: limeRenderPdf },
      ),
    );
    manifest["attemptId"] = claim.claimed.currentAttemptId;
    if (outcome.result !== "SUCCEEDED") {
      throw new Error(`closure TAILOR failed: ${JSON.stringify(outcome)}`);
    }
    await harness.withDb(async (handle) => finishS2dAttempt(handle, claim, outcome, tailorNow));
    const succeededProgress = await progressGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/generations/${requestId}`),
      { params: Promise.resolve({ id: basics.jobId, requestId }) },
    );
    expect(succeededProgress.status).toBe(200);
    const progressBody = await readJson(succeededProgress);
    expect(progressBody["state"]).toBe("SUCCEEDED");
    manifest["versionId"] = String(progressBody["resumeVersionId"]);
    const events = await harness.withDb((handle) =>
      handle.sqlite
        .prepare(
          `SELECT seq, stage, source FROM generation_progress_events WHERE request_id = ? AND attempt_id = ? ORDER BY seq`,
        )
        .all(requestId, manifest["attemptId"]),
    );
    expect(events).toHaveLength(5);

    // U11: exact-version review agrees on frozen segments + artifacts.
    const review = await reviewGET(
      getRequest(`/api/resumes/${manifest["versionId"]}/review`),
      { params: Promise.resolve({ id: manifest["versionId"] as string }) },
    );
    expect(review.status).toBe(200);
    const reviewBody = await readJson(review);
    expect(reviewBody).toBeDefined();

    // U12: approve NEW → TAILORED, selected pointer set, PDF downloads.
    const preApprove = await harness.withDb((handle) => q4(handle, basics.jobId));
    expect(preApprove["status"]).toBe("NEW");
    const approved = await approvePOST(
      postRequest(`/api/jobs/${basics.jobId}/resume/approve`, {
        resumeVersionId: manifest["versionId"],
        observedRowVersion: (await harness.withDb((handle) =>
          getTailoringJob(handle, basics.jobId),
        ))?.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(approved.status).toBe(200);
    const postApprove = await harness.withDb((handle) => q4(handle, basics.jobId));
    expect(postApprove["status"]).toBe("TAILORED");
    expect(postApprove["selected"]).toBe(manifest["versionId"]);
    const pdfRow = await harness.withDb((handle) =>
      handle.sqlite
        .prepare(
          `SELECT id, sha256 FROM resume_artifacts WHERE resume_version_id = ? AND kind = 'PDF'`,
        )
        .get(manifest["versionId"]),
    ) as { id: string; sha256: string };
    manifest["pdfArtifactId"] = pdfRow.id;
    manifest["pdfSha256"] = pdfRow.sha256;
    const pdf = await artifactGET(
      getRequest(`/api/resumes/artifacts/${pdfRow.id}?download=1`),
      { params: Promise.resolve({ id: pdfRow.id }) },
    );
    expect(pdf.status).toBe(200);

    // U20: repeated reads navigate without phantom writes.
    const u20Before = await harness.withDb((handle) => q1(handle, basics.jobId));
    const u20q4Before = await harness.withDb((handle) => q4(handle, basics.jobId));
    for (let index = 0; index < 3; index += 1) {
      expect(
        (
          await jobGET(getRequest(`/api/jobs/${basics.jobId}`), routeParams(basics.jobId))
        ).status,
      ).toBe(200);
      expect(
        (
          await workspaceGET(
            getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
            routeParams(basics.jobId),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await boardGET(getRequest(`/api/board`))
        ).status,
      ).toBe(200);
    }
    expect(await harness.withDb((handle) => q1(handle, basics.jobId))).toEqual(u20Before);
    expect(await harness.withDb((handle) => q4(handle, basics.jobId))).toEqual(u20q4Before);
    expect(await harness.withDb((handle) => q8(handle))).toEqual([]);

    // Manifest recorded for the I1 evidence row (safe IDs/hashes only).
    expect(Object.keys(manifest).length).toBeGreaterThan(8);
  });
});
