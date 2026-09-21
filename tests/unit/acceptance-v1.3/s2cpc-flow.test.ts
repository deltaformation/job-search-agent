// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as validatePOST } from "../../../app/api/jobs/[id]/tailoring/draft/validate/route";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import { GET as planGET } from "../../../app/api/jobs/[id]/tailoring/plan/route";
import { POST as preparationPOST } from "../../../app/api/jobs/[id]/tailoring/preparation/route";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  generationRequests,
  newId,
  resumeVersions,
  tailoringRequestInputs,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { readPreparationByJob, readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { htmlBodyFragments } from "../../../src/resumes/checks";
import { STEP2_SCHEMA_VERSIONS } from "../../../src/domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  type Step2Provenance,
} from "../../../src/domain/step2Correction";
import {
  buildWorkspaceETag,
  TAILORING_SUBMIT_SCHEMA_VERSION,
} from "../../../src/domain/tailoringWorkspace";
import { getRecommendations } from "../../../src/server/recommendations";
import { validateDraftV2 } from "../../../src/server/preparation";
import { submitGeneration } from "../../../src/server/generations";
import { correctionVerifiedCoverage } from "../../../src/tailoring/step2CorrectionPolicy";
import { TestPrepareProvider, TestProvider } from "../../../src/tailoring/testProvider";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
} from "../routes/_helpers";
import {
  claimS2b,
  finishS2bAttempt,
  runS2bAttempt,
  s2bQ1,
  s2bSnapshotIds,
  S2B_KEYED_ENV,
} from "./s2b-world";
import {
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  versionForRequest,
} from "./s2d-world";
import {
  factTextsForVersion,
  makeArtifactsDir,
  proposalForRun,
} from "./f-world";
import {
  asV13Basics,
  clipAndScheduleLime,
  closeHarness,
  FOREIGN_PRIORITY_ID,
  LIME_CLIP_HTML,
  LIME_EDITED,
  LIME_JD,
  limeFittingExcludes,
  limeMasterDocument,
  limeMasterSummary,
  limeProposal,
  openHarness,
  putRequest,
  seedLimeAccepted,
  usableLimeSuggestions,
  type LimeHarness,
} from "./s2cpc-world";

/**
 * WO-1.3-S2-CP-C real-flow checkpoint (S2CPC4): a faithful redacted
 * Lime posting plus the redacted Mouad master travel the real
 * route/worker path — clip intake → preparation schedule → supervised
 * PREPARE → accepted v2 plan → W-v3 edit/save → reload → V-v2
 * validation → explicit G-v2 generation → supervised TAILOR →
 * versioned artifacts. Every leg asserts recomputed IDs and hashes;
 * the run's concrete manifest is recorded in the S2CPC4 evidence row.
 * Journey-scoped regressions pin an adversarial Lime provider,
 * verbatim user edits, foreign-role refusal, and selected-summary
 * anchors on the same real data.
 */

/**
 * Unicode-capable stub PDF for the Lime journey: the shared unit
 * stub is latin1-only and mangles the master record's curly
 * apostrophes, so this local renderer declares WinAnsiEncoding and
 * escapes them (verified to round-trip through the repo PDF
 * extractor). Any other non-ASCII char fails loudly instead of
 * mangling. Real Chromium rendering is S2CPC5's separate check.
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
  // Paginate: the extractor drops runs laid out below the page
  // box, so each page restarts at the top (45 runs × 14pt).
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

describe("S2CPC4 Lime fixture coherence", () => {
  it("the clip page embeds the verbatim JD and the master redacts contact only", () => {
    const embedded = LIME_CLIP_HTML.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    if (embedded?.[1] === undefined) {
      throw new Error("Lime clip page carries no JSON-LD block");
    }
    const posting = JSON.parse(embedded[1]) as { description?: unknown; title?: unknown };
    expect(posting.description).toBe(LIME_JD);
    expect(posting.title).toBe("Lead Product Manager, Supply Chain Systems");
    const master = limeMasterDocument();
    expect(master["schemaVersion"]).toBe("candidate-import/v2");
    expect((master["identity"] as Record<string, unknown>)["email"]).toBe(
      "mouad.atfi@example.com",
    );
    expect((master["achievements"] as unknown[])).toHaveLength(17);
    expect((master["employment"] as unknown[])).toHaveLength(6);
  });
});

describe("S2CPC4 Lime real-flow journey", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("clips, prepares, edits, validates, and generates the Lime pairing end to end", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const q1BeforeGeneration = await harness.withDb((handle) => s2bQ1(handle));

    // Completed work converges: an explicit schedule POST after
    // success replays with zero new writes.
    const liveRowVersion = await harness.withDb(
      (handle) => getTailoringJob(handle, basics.jobId)?.rowVersion ?? -1,
    );
    const converged = await preparationPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/preparation`, {
        schemaVersion: STEP2_SCHEMA_VERSIONS.prepareCommand,
        operationId: newId(),
        observedRowVersion: liveRowVersion,
        profileId: basics.profileId,
      }),
      routeParams(basics.jobId),
    );
    expect(converged.status).toBe(200);
    const convergedBody = await readJson(converged);
    expect(convergedBody["replayed"]).toBe(true);
    expect(convergedBody["preparationId"]).toBe(accepted.preparationId);

    // Plan reads carry exact server-derived eligible roles.
    const planResponse = await planGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/plan`),
      routeParams(basics.jobId),
    );
    expect(planResponse.status).toBe(200);
    const planBody = await readJson(planResponse);
    expect(String((planBody["planHash"] as string) ?? "")).toBe(accepted.planHash);
    const eligible = planBody["eligibleRoles"] as Array<{
      suggestionId: string;
      eligibleRoleIds: string[];
    }>;
    const usable = usableLimeSuggestions(accepted.plan);
    for (const suggestion of usable) {
      const entry = eligible.find((row) => row.suggestionId === suggestion.suggestionId);
      expect(entry?.eligibleRoleIds).toEqual([suggestion.roleId]);
    }

    // Edit/save over HTTP: master-exact summary, one verbatim AI
    // add, one user edit with unsupported claims.
    const masterSummary = limeMasterSummary();
    const addExactOp = {
      op: "add",
      operationId: newId(),
      suggestionId: usable[0]!.suggestionId,
      roleId: usable[0]!.roleId,
      editedText: null,
    };
    const addEditedOp = {
      op: "add",
      operationId: newId(),
      suggestionId: usable[1]!.suggestionId,
      roleId: usable[1]!.roleId,
      editedText: `${usable[1]!.text} ${LIME_EDITED}`,
    };
    const journeyOps = [addExactOp, addEditedOp, ...limeFittingExcludes()];
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
        operations: journeyOps,
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
    const savedBody = await readJson(saved);
    const workspace = savedBody["workspace"] as {
      revision: number;
      draft: { draft: { summaryText: string; summaryOrigin: string; operations: unknown[] } };
    };
    expect(workspace.revision).toBe(1);

    // Reload preserves the exact bytes and origin.
    const reloaded = await workspaceGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
      routeParams(basics.jobId),
    );
    expect(reloaded.status).toBe(200);
    const reloadedDraft = (
      (await readJson(reloaded))["workspace"] as {
        draft: { draft: { summaryText: string; summaryOrigin: string; operations: unknown[] } };
      }
    ).draft.draft;
    expect(reloadedDraft.summaryText).toBe(masterSummary);
    expect(reloadedDraft.summaryOrigin).toBe("master");
    expect(reloadedDraft.operations).toEqual(journeyOps);

    // V-v2 over HTTP derives the three provenance classes.
    const validated = await validatePOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/draft/validate`, {
        schemaVersion: STEP2_CORRECTION_VERSIONS.validateDraft,
        workspaceRevision: 1,
        summaryText: masterSummary,
        summaryOrigin: "master",
        operations: journeyOps,
      }),
      routeParams(basics.jobId),
    );
    expect(validated.status).toBe(200);
    const validatedBody = await readJson(validated);
    const validationId = String(validatedBody["validationId"]);
    const segments = (
      validatedBody["validation"] as {
        segments: Array<{ segmentId: string; kind: string; provenance: Step2Provenance }>;
      }
    ).segments;
    const provenanceOf = (segmentId: string): Step2Provenance => {
      const found = segments.find((segment) => segment.segmentId === segmentId);
      if (found === undefined) {
        throw new Error(`Lime validation produced no ${segmentId} segment`);
      }
      return found.provenance;
    };
    expect(provenanceOf("summary")).toBe("VERIFIED_SOURCE");
    expect(provenanceOf(`op:${String(addExactOp.operationId)}`)).toBe("USER_ACCEPTED_AI");
    expect(provenanceOf(`op:${String(addEditedOp.operationId)}`)).toBe("USER_EDITED");

    // Explicit generation over HTTP, then the supervised TAILOR leg.
    const live = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    if (live === null) {
      throw new Error("Lime journey lost the job row");
    }
    const requestId = newId();
    const generated = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, {
        schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
        requestId,
        workspaceRevision: 1,
        observedRowVersion: live.rowVersion,
      }),
      routeParams(basics.jobId),
    );
    expect(generated.status).toBe(202);
    const generatedBody = await readJson(generated);
    expect(generatedBody["replayed"]).toBe(false);
    const genWorkItemId = String(generatedBody["workItemId"]);

    const submitted = await harness.withDb((handle) => {
      const request = getGenerationRequest(handle, requestId);
      const inputs = handle.db
        .select()
        .from(tailoringRequestInputs)
        .where(eq(tailoringRequestInputs.requestId, requestId))
        .get();
      if (request === null || inputs === undefined) {
        throw new Error("Lime submit returned no request/inputs rows");
      }
      return {
        requestId,
        workItemId: genWorkItemId,
        jdSnapshotId: request.jdSnapshotId,
        candidateSnapshotId: inputs.candidateSnapshotId,
      };
    });
    const tailorProposal = await harness.withDb((handle) => {
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error(`Lime guidance seed failed: ${recs.failure.error}`);
      }
      return proposalForRun({
        recommendations: recs.recommendations,
        factTexts: factTextsForVersion(handle, basics.profileVersionId),
        jdSnapshotId: submitted.jdSnapshotId,
        candidateSnapshotId: submitted.candidateSnapshotId,
      });
    });
    const tailorProvider = new TestProvider({
      proposals: { [submitted.jdSnapshotId]: tailorProposal },
      clock: () => accepted.now,
    });
    const artifactsDir = makeArtifactsDir();
    const { claim, outcome } = await harness.withDb((handle) =>
      runS2dTailor(handle, submitted, tailorProvider, artifactsDir, {
        now: accepted.now,
        renderPdf: limeRenderPdf,
      }),
    );
    expect(outcome).toMatchObject({ result: "SUCCEEDED" });
    await harness.withDb((handle) =>
      finishS2dAttempt(handle, claim, outcome, accepted.now),
    );
    expect(tailorProvider.receivedInputs.length).toBe(1);

    // Version, artifacts, frozen inputs, and the recorded manifest.
    const manifest = await harness.withDb(async (handle) => {
      const version = versionForRequest(handle, requestId);
      const texts = await readS2dArtifactTexts(handle, artifactsDir, version.id);
      const squashed = (text: string): string => text.replace(/\s+/g, " ");
      expect(squashed(texts.markdown)).toContain(squashed(LIME_EDITED));
      expect(squashed(texts.docx)).toContain(squashed(LIME_EDITED));
      expect(squashed(texts.pdf)).toContain(squashed(LIME_EDITED));
      const versionRow = handle.db
        .select({ contentJson: resumeVersions.contentJson })
        .from(resumeVersions)
        .where(eq(resumeVersions.id, version.id))
        .get();
      expect(versionRow?.contentJson).toContain(LIME_EDITED);
      expect(versionRow?.contentJson).toContain(masterSummary);
      const frozen = readStep2GenerationInputs(handle, requestId);
      if (frozen === null) {
        throw new Error("Lime submit froze no generation inputs");
      }
      const artifacts = handle.sqlite
        .prepare(
          `SELECT kind, relative_path AS relativePath, byte_size AS byteSize, sha256 FROM resume_artifacts WHERE resume_version_id = ? ORDER BY kind`,
        )
        .all(version.id) as Array<{
          kind: string;
          relativePath: string;
          byteSize: number;
          sha256: string;
        }>;
      expect(artifacts.map((row) => row.kind).sort()).toEqual(["DOCX", "MARKDOWN", "PDF"]);
      for (const artifact of artifacts) {
        const bytes = readFileSync(join(artifactsDir, artifact.relativePath));
        expect(artifact.byteSize).toBe(bytes.byteLength);
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      const requestCount = handle.db
        .select({ id: generationRequests.id })
        .from(generationRequests)
        .all();
      expect(requestCount).toHaveLength(q1BeforeGeneration.requests + 1);
      const job = getTailoringJob(handle, basics.jobId);
      return {
        batchId: accepted.batchId,
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        preparationId: accepted.preparationId,
        prepWorkItemId: accepted.prepWorkItemId,
        prepAttemptId: accepted.prepAttemptId,
        planRowId: accepted.planRowId,
        planHash: accepted.planHash,
        jdSnapshotId: accepted.snapshots.jdSnapshotId,
        candidateSnapshotId: accepted.snapshots.candidateSnapshotId,
        workspaceRevision: 1,
        validationId,
        requestId,
        genWorkItemId,
        tailorAttemptId: claim.claimed.currentAttemptId,
        versionId: version.id,
        artifacts: artifacts.map((row) => `${row.kind}:${row.sha256.slice(0, 16)}`),
        provenance: segments.map((segment) => `${segment.segmentId}=${segment.provenance}`),
        jobStatus: job?.status,
      };
    });
    expect(manifest.jobStatus).toBe("NEW");
    expect(manifest.provenance).toContain("summary=VERIFIED_SOURCE");
  });
});

describe("S2CPC4 adversarial Lime provider", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("a poisoned Lime proposal fails publication with no accepted plan", async () => {
    const scheduled = await clipAndScheduleLime(harness);
    const { basics, now } = scheduled;
    const honest = await harness.withDb((handle) => limeProposal(handle, basics));
    // Schema-valid but semantically poisoned over the same live
    // bytes: every anchor unknown, every link foreign, the role
    // names no Lime employment.
    const poisoned = {
      ...honest,
      priorities: honest.priorities.map((priority) => ({ ...priority, factIds: ["no-such-fact"] })),
      angles: honest.angles.map((angle) => ({
        ...angle,
        factIds: ["no-such-fact"],
        priorityIds: [FOREIGN_PRIORITY_ID],
      })),
      suggestions: honest.suggestions.map((suggestion) => ({
        ...suggestion,
        roleId: "emp-elsewhere",
        factIds: ["no-such-fact"],
        priorityIds: [FOREIGN_PRIORITY_ID],
      })),
    };
    const snapshots = await harness.withDb((handle) =>
      s2bSnapshotIds(handle, asV13Basics(basics), basics.jdText),
    );
    const provider = new TestPrepareProvider({ proposals: { [snapshots.jdSnapshotId]: poisoned } });
    const q1Before = await harness.withDb((handle) => s2bQ1(handle));
    const claimed = await harness.withDb((handle) => claimS2b(handle, { now }));
    expect(claimed.workItemId).toBe(scheduled.prepWorkItemId);
    const outcome = await harness.withDb((handle) =>
      runS2bAttempt(handle, claimed, provider, { now }),
    );
    expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
    await harness.withDb((handle) => finishS2bAttempt(handle, { ...claimed, outcome, now }));
    const row = await harness.withDb((handle) => readPreparationByJob(handle, basics.jobId));
    expect(row?.state).toBe("FAILED");
    expect(row?.acceptedPlanId).toBeNull();
    const plans = await harness.withDb(
      (handle) =>
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM step2_plans WHERE preparation_id = ?")
          .get(row?.id) as { count: number },
    );
    expect(plans.count).toBe(0);
    expect(await harness.withDb((handle) => s2bQ1(handle))).toEqual(q1Before);
  });
});

describe("S2CPC4 Lime user-edit gate", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("unsupported Lime edits submit verbatim without touching master, facts, or coverage", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const masterSummary = limeMasterSummary();
    const editedSummary = `${masterSummary} ${LIME_EDITED}`;
    const editedBullet = `${usable[0]!.text} ${LIME_EDITED}`;
    const fitting = limeFittingExcludes();
    const cleanOps = [
      {
        op: "add" as const,
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...fitting,
    ];
    const editedOps = [
      {
        op: "add" as const,
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: editedBullet,
      },
      ...fitting,
    ];

    const before = await harness.withDb((handle) => ({
      payload: (
        handle.sqlite
          .prepare("SELECT payload_json AS payload FROM candidate_profile_versions WHERE id = ?")
          .get(basics.profileVersionId) as { payload: string }
      ).payload,
      facts: handle.sqlite.prepare("SELECT * FROM candidate_facts ORDER BY fact_id").all(),
    }));

    // Save the edited draft first: V-v2 pins validations to a
    // saved workspace revision.
    const saved = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        {
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
            summaryText: editedSummary,
            summaryOrigin: "master",
            operations: editedOps,
          },
        },
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(saved.status).toBe(201);

    const baseline = await harness.withDb(
      (handle) =>
        validateDraftV2(handle, {
          jobId: basics.jobId,
          body: {
            schemaVersion: "step2-validate-draft/v2",
            workspaceRevision: 1,
            summaryText: masterSummary,
            summaryOrigin: "master",
            operations: cleanOps,
          },
          now: accepted.now,
        }),
    );
    if (!baseline.ok) {
      throw new Error(`Lime baseline validation failed: ${baseline.error}`);
    }
    const baselineCoverage = correctionVerifiedCoverage({ validation: baseline.value.validation });

    const edited = await harness.withDb(
      (handle) =>
        validateDraftV2(handle, {
          jobId: basics.jobId,
          body: {
            schemaVersion: "step2-validate-draft/v2",
            workspaceRevision: 1,
            summaryText: editedSummary,
            summaryOrigin: "master",
            operations: editedOps,
          },
          now: accepted.now,
        }),
    );
    if (!edited.ok) {
      throw new Error(`Lime edited validation failed: ${edited.error}`);
    }
    const editedCoverage = correctionVerifiedCoverage({ validation: edited.value.validation });
    for (const segmentId of editedCoverage.verifiedSegmentIds) {
      expect(baselineCoverage.verifiedSegmentIds).toContain(segmentId);
    }
    expect(editedCoverage.verifiedSegmentIds.length).toBeLessThanOrEqual(
      baselineCoverage.verifiedSegmentIds.length,
    );
    const editedBulletSegment = edited.value.validation.segments.find(
      (segment) => segment.kind === "bullet",
    );
    expect(editedBulletSegment?.provenance).toBe("USER_EDITED");

    // Submit the edited draft; master/facts stay frozen.
    const live = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    if (live === null) {
      throw new Error("Lime user-edit leg lost the job row");
    }
    const requestId = newId();
    const submitted = await harness.withDb(
      (handle) =>
        submitGeneration(
          handle,
          {
            jobId: basics.jobId,
            requestId,
            workspaceRevision: 1,
            observedRowVersion: live.rowVersion,
            actor: "human",
            now: accepted.now,
          },
          { env: S2B_KEYED_ENV },
        ),
    );
    if (!submitted.ok) {
      throw new Error(`Lime edited submit failed: ${submitted.failure.error}`);
    }
    const frozen = await harness.withDb((handle) => readStep2GenerationInputs(handle, requestId));
    expect(frozen).not.toBeNull();
    expect(JSON.stringify(frozen)).toContain(LIME_EDITED);
    const after = await harness.withDb((handle) => ({
      payload: (
        handle.sqlite
          .prepare("SELECT payload_json AS payload FROM candidate_profile_versions WHERE id = ?")
          .get(basics.profileVersionId) as { payload: string }
      ).payload,
      facts: handle.sqlite.prepare("SELECT * FROM candidate_facts ORDER BY fact_id").all(),
    }));
    expect(after).toEqual(before);
  });
});

describe("S2CPC4 Lime foreign-role refusal", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("a foreign-role Lime save returns 422 with zero generation writes", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const foreignRoleId = usable[0]!.roleId === "emp-odotrack" ? "emp-ibm" : "emp-odotrack";
    const q1Before = await harness.withDb((handle) => s2bQ1(handle));
    const refused = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        {
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
            summaryText: limeMasterSummary(),
            summaryOrigin: "master",
            operations: [
              {
                op: "add",
                operationId: newId(),
                suggestionId: usable[0]!.suggestionId,
                roleId: foreignRoleId,
                editedText: null,
              },
            ],
          },
        },
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(refused.status).toBe(422);
    const body = await readJson(refused);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_SELECTION");
    expect(await harness.withDb((handle) => s2bQ1(handle))).toEqual(q1Before);
  });
});

describe("S2CPC4 Lime summary-union guard", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("the Lime summary cites only its selected origin anchors", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const angleOne = accepted.plan.positioning.angles.find((angle) => angle.angleId === "angle-1");
    const angleTwo = accepted.plan.positioning.angles.find((angle) => angle.angleId === "angle-2");
    if (angleOne === undefined || angleTwo === undefined) {
      throw new Error("Lime plan carries no angle-1/angle-2 pair");
    }
    const saved = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        {
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
            summaryText: angleOne.summaryText,
            summaryOrigin: "angle-1",
            operations: [],
          },
        },
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(saved.status).toBe(201);
    const validated = await harness.withDb(
      (handle) =>
        validateDraftV2(handle, {
          jobId: basics.jobId,
          body: {
            schemaVersion: "step2-validate-draft/v2",
            workspaceRevision: 1,
            summaryText: angleOne.summaryText,
            summaryOrigin: "angle-1",
            operations: [],
          },
          now: accepted.now,
        }),
    );
    if (!validated.ok) {
      throw new Error(`Lime angle validation failed: ${validated.error}`);
    }
    const summary = validated.value.validation.segments.find(
      (segment) => segment.segmentId === "summary",
    );
    if (summary === undefined) {
      throw new Error("Lime angle validation produced no summary segment");
    }
    expect([...summary.anchorFactIds].sort()).toEqual([...angleOne.factIds].sort());
    for (const factId of angleTwo.factIds) {
      expect(summary.anchorFactIds).not.toContain(factId);
    }
  });
});
