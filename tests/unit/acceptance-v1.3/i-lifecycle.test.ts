// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import { POST as approvePOST } from "../../../app/api/jobs/[id]/resume/approve/route";
import { POST as declinePOST } from "../../../app/api/jobs/[id]/resume/decline/route";
import { POST as movePOST } from "../../../app/api/jobs/[id]/move/route";
import { GET as artifactGET } from "../../../app/api/resumes/artifacts/[id]/route";
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
 * WO-1.3-I lifecycle closure (U13–U16): revision, new-version,
 * decline, and applied/interviewed preservation through real routes
 * plus the supervised TAILOR legs on isolated Lime data.
 */

async function limeRenderPdf(html: string): Promise<{ bytes: Buffer }> {
  const fragments = htmlBodyFragments(html);
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
        if (cut < 0) cut = 90;
        wrapped.push(rest.slice(0, cut));
        rest = rest.slice(cut + (rest[cut] === " " ? 1 : 0));
      }
      wrapped.push(rest);
      return wrapped;
    })
    .map((line) => `(${escape(line)}) Tj 0 -14 Td`);
  const pages: string[][] = [];
  for (let i = 0; i < runs.length; i += 45) pages.push(runs.slice(i, i + 45));
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((pageRuns, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${3 + index * 2 + 1} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    objects.push(
      `<< /Length ${`BT /F1 10 Tf 72 720 Td\n${pageRuns.join("\n")}\nET`.length} >>\nstream\nBT /F1 10 Tf 72 720 Td\n${pageRuns.join("\n")}\nET\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { bytes: Buffer.from(body, "latin1") };
}

interface Published {
  requestId: string;
  workItemId: string;
  versionId: string;
  rowVersion: number;
}

async function saveDraft(
  _harness: LimeHarness,
  basics: { jobId: string; extractionId: string; profileId: string; profileVersionId: string },
  plan: { planRowId: string; planHash: string },
  revision: number,
  kind: { requestKind: "INITIAL" | "NEW_VERSION" | "REVISION"; parentVersionId: string | null; revisionNote: string | null },
  ops: unknown[],
): Promise<number> {
  const saved = await workspacePUT(
    putRequest(
      `/api/jobs/${basics.jobId}/tailoring/workspace`,
      {
        schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
        extractionId: basics.extractionId,
        profileId: basics.profileId,
        profileVersionId: basics.profileVersionId,
        requestKind: kind.requestKind,
        parentVersionId: kind.parentVersionId,
        revisionNote: kind.revisionNote,
        planId: plan.planRowId,
        planHash: plan.planHash,
        recommendationHash: null,
        draft: {
          schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
          planId: plan.planRowId,
          planHash: plan.planHash,
          summaryText: limeMasterSummary(),
          summaryOrigin: "master",
          operations: ops,
        },
      },
      buildWorkspaceETag(basics.jobId, revision),
    ),
    routeParams(basics.jobId),
  );
  if (saved.status !== 200 && saved.status !== 201) {
    throw new Error(`lifecycle save failed: ${saved.status} ${JSON.stringify(await readJson(saved))}`);
  }
  return ((await readJson(saved))["workspace"] as { revision: number }).revision;
}

async function submitAndPublish(
  harness: LimeHarness,
  jobId: string,
  workspaceRevision: number,
): Promise<Published> {
  const live = await harness.withDb((handle) => getTailoringJob(handle, jobId));
  if (live === null) throw new Error("lifecycle submit lost the job");
  const requestId = newId();
  const generated = await generationsPOST(
    postRequest(`/api/jobs/${jobId}/tailoring/generations`, {
      schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
      requestId,
      workspaceRevision,
      observedRowVersion: live.rowVersion,
    }),
    routeParams(jobId),
  );
  if (generated.status !== 202) {
    throw new Error(`lifecycle submit failed: ${generated.status} ${JSON.stringify(await readJson(generated))}`);
  }
  const workItemId = String((await readJson(generated))["workItemId"]);
  const submitted = await harness.withDb((handle) => {
    const request = getGenerationRequest(handle, requestId);
    const inputs = handle.db
      .select()
      .from(tailoringRequestInputs)
      .where(eq(tailoringRequestInputs.requestId, requestId))
      .get();
    if (request === null || inputs === undefined) throw new Error("lifecycle submit wrote no rows");
    return { jdSnapshotId: request.jdSnapshotId, candidateSnapshotId: inputs.candidateSnapshotId };
  });
  const bound = await harness.withDb((handle) => {
    const jobRow = getTailoringJob(handle, jobId);
    const prep = handle.sqlite
      .prepare(`SELECT profile_version_id AS v FROM step2_preparations WHERE job_id = ?`)
      .get(jobId) as { v: string };
    if (jobRow?.activeExtractionId === null || jobRow?.activeExtractionId === undefined) {
      throw new Error("lifecycle job lost its extraction");
    }
    return { extractionId: jobRow.activeExtractionId, profileVersionId: prep.v };
  });
  const proposal = await harness.withDb((handle) => {
    const recs = getRecommendations(handle, {
      jobId,
      extractionId: bound.extractionId,
      profileVersionId: bound.profileVersionId,
    });
    if (!recs.ok) throw new Error("lifecycle proposal seed failed");
    return proposalForRun({
      recommendations: recs.recommendations,
      factTexts: factTextsForVersion(handle, bound.profileVersionId),
      jdSnapshotId: submitted.jdSnapshotId,
      candidateSnapshotId: submitted.candidateSnapshotId,
    });
  });
  const artifactsDir = join(harness.isolated.root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const now = new Date().toISOString();
  const { claim, outcome } = await harness.withDb((handle) =>
    runS2dTailor(
      handle,
      { requestId, workItemId, ...submitted },
      new TestProvider({ proposals: { [submitted.jdSnapshotId]: proposal } }),
      artifactsDir,
      { now, renderPdf: limeRenderPdf },
    ),
  );
  if (outcome.result !== "SUCCEEDED") throw new Error(`lifecycle TAILOR failed: ${JSON.stringify(outcome)}`);
  await harness.withDb((handle) => finishS2dAttempt(handle, claim, outcome, now));
  const versionId = await harness.withDb(
    (handle) =>
      (handle.sqlite
        .prepare(`SELECT id FROM resume_versions WHERE generation_request_id = ?`)
        .get(requestId) as { id: string }).id,
  );
  const rowVersion = (await harness.withDb((handle) => getTailoringJob(handle, jobId)))?.rowVersion ?? -1;
  return { requestId, workItemId, versionId, rowVersion };
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

describe("WO-1.3-I lifecycle U13-U16", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness("job-tracker-v13-i-lifecycle-");
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("U13: awaiting parent revision reopens the v2 editor with ops preserved", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const ops = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const rev1 = await saveDraft(
      harness, basics, accepted, 0,
      { requestKind: "INITIAL", parentVersionId: null, revisionNote: null }, ops,
    );
    expect(rev1).toBe(1);
    const v1 = await submitAndPublish(harness, basics.jobId, rev1);

    // Revision save preserves ops, binds the awaiting parent + note.
    // (G submit CAS-bumps the workspace, so the next save observes rev1+1.)
    const revisionNote = "Tighten the supply-chain angle; keep every bullet.";
    const rev2 = await saveDraft(
      harness, basics, accepted, rev1 + 1,
      { requestKind: "REVISION", parentVersionId: v1.versionId, revisionNote }, ops,
    );
    expect(rev2).toBe(rev1 + 2);
    const reloaded = await workspaceGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
      routeParams(basics.jobId),
    );
    expect(reloaded.status).toBe(200);
    const draft = ((await readJson(reloaded))["workspace"] as {
      draft: { requestKind: string; parentVersionId: string; revisionNote: string; draft: { operations: unknown[] } };
    }).draft;
    expect(draft.requestKind).toBe("REVISION");
    expect(draft.parentVersionId).toBe(v1.versionId);
    expect(draft.revisionNote).toBe(revisionNote);
    expect(draft.draft.operations).toEqual(ops);

    // G REVISION atomically records the parent review + child request.
    const live = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const childId = newId();
    const child = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, {
        schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
        requestId: childId,
        workspaceRevision: rev2,
        observedRowVersion: live?.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(child.status).toBe(202);
    await harness.withDb((handle) => {
      const parent = handle.sqlite
        .prepare(`SELECT review_state AS s FROM resume_versions WHERE id = ?`)
        .get(v1.versionId) as { s: string };
      expect(parent.s).toBe("REVISION_REQUESTED");
      const reviews = handle.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM resume_reviews WHERE resume_version_id = ?`)
        .get(v1.versionId) as { n: number };
      expect(reviews.n).toBe(1);
      const request = getGenerationRequest(handle, childId);
      expect(request?.parentVersionId).toBe(v1.versionId);
    });
  });

  it("U14-U16: new-version, decline, and applied preservation", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const ops = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const rev1 = await saveDraft(
      harness, basics, accepted, 0,
      { requestKind: "INITIAL", parentVersionId: null, revisionNote: null }, ops,
    );
    const v1 = await submitAndPublish(harness, basics.jobId, rev1);
    let currentRev = rev1 + 1;
    // Approve v1 → TAILORED, selected v1.
    const live1 = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const approve1 = await approvePOST(
      postRequest(`/api/jobs/${basics.jobId}/resume/approve`, {
        resumeVersionId: v1.versionId,
        observedRowVersion: live1?.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(approve1.status).toBe(200);
    expect((await harness.withDb((handle) => q4(handle, basics.jobId)))["selected"]).toBe(v1.versionId);

    // U14: NEW_VERSION v2 awaiting; download still resolves v1.
    const rev2 = await saveDraft(
      harness, basics, accepted, currentRev,
      { requestKind: "NEW_VERSION", parentVersionId: v1.versionId, revisionNote: null }, ops,
    );
    const v2 = await submitAndPublish(harness, basics.jobId, rev2);
    currentRev = rev2 + 1;
    const selectedPdf = await harness.withDb(
      (handle) =>
        handle.sqlite
          .prepare(
            `SELECT a.id AS artifactId, a.resume_version_id AS versionId FROM jobs j
             JOIN resume_artifacts a ON a.resume_version_id = j.selected_resume_version_id AND a.kind = 'PDF'
             WHERE j.id = ?`,
          )
          .get(basics.jobId) as { artifactId: string; versionId: string },
    );
    expect(selectedPdf.versionId).toBe(v1.versionId);
    const download = await artifactGET(
      getRequest(`/api/resumes/artifacts/${selectedPdf.artifactId}?download=1`),
      { params: Promise.resolve({ id: selectedPdf.artifactId }) },
    );
    expect(download.status).toBe(200);
    // Approve v2 → selection flips to v2.
    const live2 = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const approve2 = await approvePOST(
      postRequest(`/api/jobs/${basics.jobId}/resume/approve`, {
        resumeVersionId: v2.versionId,
        observedRowVersion: live2?.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(approve2.status).toBe(200);
    expect((await harness.withDb((handle) => q4(handle, basics.jobId)))["selected"]).toBe(v2.versionId);

    // U15: decline a newer awaiting version; selected stays v2, zero work.
    const rev3 = await saveDraft(
      harness, basics, accepted, currentRev,
      { requestKind: "NEW_VERSION", parentVersionId: v2.versionId, revisionNote: null }, ops,
    );
    const v3 = await submitAndPublish(harness, basics.jobId, rev3);
    currentRev = rev3 + 1;
    const workBefore = await harness.withDb(
      (handle) =>
        (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE job_id = ?`).get(basics.jobId) as { n: number }).n,
    );
    const live3 = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const declined = await declinePOST(
      postRequest(`/api/jobs/${basics.jobId}/resume/decline`, {
        resumeVersionId: v3.versionId,
        observedRowVersion: live3?.rowVersion,
        note: "Superseded by the v2 selection; keeping v2.",
      }),
      routeParams(basics.jobId),
    );
    expect(declined.status).toBe(200);
    const workAfter = await harness.withDb(
      (handle) =>
        (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE job_id = ?`).get(basics.jobId) as { n: number }).n,
    );
    expect(workAfter).toBe(workBefore);
    expect((await harness.withDb((handle) => q4(handle, basics.jobId)))["selected"]).toBe(v2.versionId);

    // U16: record APPLIED, then generate/approve v4; application pinned.
    const live4 = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const appliedAt = new Date().toISOString();
    const applied = await movePOST(
      postRequest(`/api/jobs/${basics.jobId}/move`, {
        to: "APPLIED",
        observedRowVersion: live4?.rowVersion,
        appliedAt,
        confirmationNumber: "I16-CONF-001",
      }),
      routeParams(basics.jobId),
    );
    expect(applied.status).toBe(200);
    const appBefore = await harness.withDb((handle) => q4(handle, basics.jobId));
    expect(appBefore["status"]).toBe("APPLIED");
    expect(appBefore["applicationVersion"]).toBe(v2.versionId);
    expect(appBefore["appliedAt"]).toBe(appliedAt);
    const rev4 = await saveDraft(
      harness, basics, accepted, currentRev,
      { requestKind: "NEW_VERSION", parentVersionId: v2.versionId, revisionNote: null }, ops,
    );
    const v4 = await submitAndPublish(harness, basics.jobId, rev4);
    const live5 = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const approve4 = await approvePOST(
      postRequest(`/api/jobs/${basics.jobId}/resume/approve`, {
        resumeVersionId: v4.versionId,
        observedRowVersion: live5?.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(approve4.status).toBe(200);
    const appAfter = await harness.withDb((handle) => q4(handle, basics.jobId));
    expect(appAfter["applicationVersion"]).toBe(appBefore["applicationVersion"]);
    expect(appAfter["appliedAt"]).toBe(appBefore["appliedAt"]);
    expect(appAfter["selected"]).toBe(v4.versionId);
  });
});
