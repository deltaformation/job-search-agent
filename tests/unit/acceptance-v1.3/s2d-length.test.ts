// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkStep2Budgets,
  STEP2_SCHEMA_VERSIONS,
  Step2ValidationV1,
  type MasterBullet,
} from "../../../src/domain/step2";
import {
  STEP2_CLAIMS_POLICY_V2,
  STEP2_CORRECTION_VERSIONS,
  Step2ValidationV2,
  type Step2DraftOperationV2,
} from "../../../src/domain/step2Correction";
import { newId } from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { readDraftValidationsByHash } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { readWorkspace } from "../../../src/db/tailoringWorkspace";
import { submitGeneration } from "../../../src/server/generations";
import { validateDraft } from "../../../src/server/preparation";
import { buildTailoredDraft } from "../../../src/tailoring/draft";
import { extractDocxParagraphs, loadDocxTemplateBytes, renderDocx } from "../../../src/resumes/docx";
import { renderMarkdown } from "../../../src/resumes/markdown";
import { extractPdfText } from "../../../src/resumes/pdf";
import { renderHtml } from "../../../src/resumes/template";
import { buildViewModel } from "../../../src/resumes/viewModel";
import { e2eProfile, e2eProposal, stubRenderPdf } from "../tailoring/support";
import { makeArtifactsDir } from "./f-world";
import { s2bQ1 } from "./s2b-world";
import {
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  s2dDraft,
  s2dDraftV2,
  s2dSaveDraft,
  s2dSaveDraftV2,
  s2dSubmit,
  s2dTailorProposal,
  s2dTailorProvider,
  seedS2dAccepted,
  seedS2dAcceptedV2,
  versionForRequest,
  withS2dDatabase,
  S2D_KEYED_ENV,
} from "./s2d-world";

/**
 * Bullet-count length guidance is advisory, never a generation
 * blocker: over-guidance drafts validate and submit with every
 * kept bullet, all three renderers retain them, and no bullet
 * count returns BUDGET_EXCEEDED. Payload-byte protections (the
 * save-layer 64 KiB CHECK plus the submit-time frozen-input
 * cap), CAS, and the other genuine blockers still refuse.
 */

const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("S2 length guidance", () => {
  it("counts over-guidance projections as advisory data, not errors", () => {
    // 8 bullets on each of two roles: over the 3/role guidance
    // and over the 14 total guidance.
    const master: MasterBullet[] = Array.from({ length: 16 }, (_, index) => ({
      factId: `f-${index}`,
      roleId: index < 8 ? "emp-a" : "emp-b",
      text: `Bullet ${index}.`,
    }));
    const report = checkStep2Budgets({ summaryText: "S.", master, operations: [] });
    expect(report.totalBullets).toBe(16);
    expect(report.perRoleCounts).toEqual([
      { roleId: "emp-a", bullets: 8 },
      { roleId: "emp-b", bullets: 8 },
    ]);
    // Advisory signal only: v1 and v2 validations both record it
    // via this same counter, and neither gate rejects on it.
    expect(report.exceeded).toBe(true);
  });

  it("runs an over-guidance draft end to end with every bullet in all artifacts", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      // Keep-master: 5 Harbor bullets over the 3/role guidance.
      const summary = accepted.plan.positioning.keepMasterSummary;
      const { revision } = s2dSaveDraft(handle, accepted, s2dDraft(accepted, [], summary, "master"), 0);
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
      expect(getGenerationRequest(handle, submitted.requestId)).not.toBeNull();
      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const artifactsDir = makeArtifactsDir();
      const { claim, outcome } = await runS2dTailor(
        handle,
        submitted,
        s2dTailorProvider(submitted, proposal, () => accepted.now),
        artifactsDir,
        { now: accepted.now },
      );
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(handle, claim, outcome, accepted.now);
      const version = versionForRequest(handle, submitted.requestId);
      const texts = await readS2dArtifactTexts(handle, artifactsDir, version.id);
      // Every kept master bullet renders in Markdown, DOCX, and
      // PDF: nothing trimmed, reordered, or rewritten.
      const statements = [...accepted.statements.values()];
      expect(statements).toHaveLength(6);
      for (const [format, text] of Object.entries(texts)) {
        for (const statement of statements) {
          expect(flat(text).includes(flat(statement)), `${format} keeps ${statement.slice(0, 40)}`).toBe(true);
        }
      }
      const harborOrder = statements
        .filter((statement) => statement !== (accepted.statements.get("pm-fact-experiment") ?? "∅"))
        .map((statement) => texts.markdown.indexOf(statement));
      expect(harborOrder.every((at) => at >= 0)).toBe(true);
      expect([...harborOrder].sort((a, b) => a - b)).toEqual(harborOrder);
    });
  });

  it("renders 16 kept bullets across Markdown, DOCX, and PDF without drops", async () => {
    const profile = e2eProfile();
    const proposal = e2eProposal("jd-1", "cs-1") as { requirements: unknown };
    const factCycle = ["f_scale", "f_team", "f_api", "f_auth"];
    const bullets = Array.from({ length: 16 }, (_, index) => ({
      roleId: index < 8 ? "emp-1" : "emp-2",
      text: `Kept bullet ${index} with distinct wording for format retention.`,
      factIds: [factCycle[index % factCycle.length] as string],
      strategy: "edited_plan" as const,
    }));
    const built = buildTailoredDraft({
      profile,
      requirements: proposal.requirements,
      jobId: "job-1",
      jobTitle: "Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
      editedPlan: { summary: { text: "Summary kept verbatim.", factIds: ["f_api"] }, bullets },
    });
    const model = buildViewModel({ profile, draft: built.draft });
    const markdown = renderMarkdown(model);
    const docxText = extractDocxParagraphs(
      renderDocx(model, loadDocxTemplateBytes()),
    ).join("\n");
    const pdfText = (await extractPdfText(stubRenderPdf(renderHtml(model)).bytes)).text;
    for (const [format, text] of Object.entries({ markdown, docx: docxText, pdf: pdfText })) {
      for (const bullet of bullets) {
        expect(flat(text).includes(flat(bullet.text)), `${format} keeps bullet`).toBe(true);
      }
    }
    // Roles render in recency order (current first); within each
    // role the kept order is preserved exactly.
    for (const roleId of ["emp-1", "emp-2"]) {
      const roleOrder = bullets
        .filter((bullet) => bullet.roleId === roleId)
        .map((bullet) => markdown.indexOf(bullet.text));
      expect(roleOrder.every((at) => at >= 0)).toBe(true);
      expect([...roleOrder].sort((a, b) => a - b)).toEqual(roleOrder);
    }
  });

  it("fails oversized drafts closed at save; payload bytes still block", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAcceptedV2(handle, world);
      // 50 large user-authored replaces: structurally fine
      // USER_EDITED text (~75 KiB), but the stored draft exceeds
      // the 64 KiB `v13_ws_focus` payload cap. Bullet counts are
      // advisory; payload bytes still refuse — loudly, with zero
      // rows — and generation then sees an empty editor.
      const targets: Array<{ factId: string; roleId: string }> = [
        { factId: "pm-fact-discovery", roleId: "emp-harbor" },
        { factId: "pm-fact-pricing", roleId: "emp-harbor" },
        { factId: "pm-fact-cadence", roleId: "emp-harbor" },
        { factId: "pm-fact-roadmap", roleId: "emp-harbor" },
        { factId: "pm-fact-gtm", roleId: "emp-harbor" },
        { factId: "pm-fact-experiment", roleId: "emp-beacon" },
      ];
      const operations: Step2DraftOperationV2[] = Array.from({ length: 50 }, (_, index) => {
        const target = targets[index % targets.length] as { factId: string; roleId: string };
        return {
          op: "replace",
          operationId: newId(),
          targetFactId: target.factId,
          roleId: target.roleId,
          suggestionId: null,
          editedText: `User-kept wording ${index}: ${"x".repeat(1400)}`,
        };
      });
      const summary = accepted.plan.positioning.keepMasterSummary;
      const draft = s2dDraftV2(accepted, operations, summary, "master");
      expect(() => s2dSaveDraftV2(handle, accepted, draft, 0)).toThrow(/CHECK constraint failed: v13_ws_focus/);
      expect(readWorkspace(handle, accepted.basics.jobId)).toBeNull();
      const q1Before = s2bQ1(handle);
      const refused = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: 1,
          observedRowVersion: getTailoringJob(handle, accepted.basics.jobId)?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(refused).toMatchObject({ ok: false, failure: { error: "workspace-conflict" } });
      expect(s2bQ1(handle)).toEqual(q1Before);
    });
  });

  it("keeps genuine blockers refusing on over-guidance drafts", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      // Keep-master over-guidance draft submitted against a stale
      // revision: advisory length never bypasses workspace CAS.
      const { revision } = s2dSaveDraft(
        handle,
        accepted,
        s2dDraft(accepted, [], accepted.plan.positioning.keepMasterSummary, "master"),
        0,
      );
      const refused = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision + 1,
          observedRowVersion: getTailoringJob(handle, accepted.basics.jobId)?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(refused).toMatchObject({ ok: false, failure: { error: "workspace-conflict" } });
    });
  });

  it("parses historical validation rows with advisory budget fields unchanged", async () => {
    // Stored v1 validation bytes incl. exceeded:true parse as-is.
    const v1 = Step2ValidationV1.parse({
      schemaVersion: "step2-validation/v1",
      policyVersion: "step2-claims/1",
      planId: newId(),
      planHash: "a".repeat(64),
      draftHash: "b".repeat(64),
      segments: [
        {
          segmentId: "summary",
          kind: "summary",
          roleId: null,
          textHash: "c".repeat(64),
          normalizedHash: "d".repeat(64),
          verdict: "supported",
          factIds: ["pm-fact-discovery"],
          match: "exact-plan",
          reason: null,
        },
      ],
      budget: {
        summaryChars: 10,
        perRoleCounts: [{ roleId: "emp-harbor", bullets: 5 }],
        totalBullets: 5,
        exceeded: true,
      },
      validatedAt: "2026-09-17T12:00:00.000Z",
    });
    expect(v1.budget.exceeded).toBe(true);
    // Stored v2 validation bytes incl. exceeded:true parse as-is.
    const v2 = Step2ValidationV2.parse({
      schemaVersion: STEP2_CORRECTION_VERSIONS.validation,
      policyVersion: STEP2_CLAIMS_POLICY_V2,
      planId: newId(),
      planHash: "a".repeat(64),
      draftHash: "b".repeat(64),
      segments: [
        {
          segmentId: "summary",
          kind: "summary",
          roleId: null,
          origin: { kind: "master-summary" },
          anchorFactIds: [],
          priorityIds: [],
          textHash: "c".repeat(64),
          normalizedHash: "d".repeat(64),
          provenance: "VERIFIED_SOURCE",
          structural: { ok: true, reason: null },
          match: "exact-plan",
          reason: null,
        },
        {
          segmentId: "op:bulk",
          kind: "bullet",
          roleId: "emp-harbor",
          origin: { kind: "master-bullet", factId: "pm-fact-discovery" },
          anchorFactIds: ["pm-fact-discovery"],
          priorityIds: [],
          textHash: "e".repeat(64),
          normalizedHash: "f".repeat(64),
          provenance: "VERIFIED_SOURCE",
          structural: { ok: true, reason: null },
          match: "exact-fact",
          reason: null,
        },
      ],
      provenanceCounts: { verifiedSource: 2, userAcceptedAi: 0, userEdited: 0 },
      budget: {
        summaryChars: 10,
        perRoleCounts: [{ roleId: "emp-harbor", bullets: 15 }],
        totalBullets: 15,
        exceeded: true,
      },
      validatedAt: "2026-09-17T12:00:00.000Z",
    });
    expect(v2.budget.exceeded).toBe(true);
    // A live verdict row written for an over-guidance draft
    // re-parses through the same schema with its advisory flag.
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const summary = accepted.plan.positioning.keepMasterSummary;
      const { revision } = s2dSaveDraft(handle, accepted, s2dDraft(accepted, [], summary, "master"), 0);
      const checked = validateDraft(
        handle,
        {
          jobId: accepted.basics.jobId,
          body: {
            schemaVersion: STEP2_SCHEMA_VERSIONS.validateDraft,
            workspaceRevision: revision,
            summaryText: summary,
            operations: [],
          },
          now: accepted.now,
        },
      );
      expect(checked.ok).toBe(true);
      if (!checked.ok) {
        throw new Error("unreachable");
      }
      const rows = readDraftValidationsByHash(handle, accepted.basics.jobId, checked.value.validation.draftHash);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const reparsed = Step2ValidationV1.parse(JSON.parse(row.verdictJson) as unknown);
        expect(reparsed.budget.exceeded).toBe(true);
        expect(reparsed.budget.totalBullets).toBe(6);
      }
    });
  });
});
