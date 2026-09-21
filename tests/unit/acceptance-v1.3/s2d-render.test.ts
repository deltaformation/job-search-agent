// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyEditedBullets,
  deriveStep2Segments,
  STEP2_SCHEMA_VERSIONS,
  type MasterBullet,
  type Step2DraftOperationV1,
} from "../../../src/domain/step2";
import { buildTailoredDraft } from "../../../src/tailoring/draft";
import { validateDraft as validateBuiltDraft } from "../../../src/tailoring/validator";
import { validateDraft } from "../../../src/server/preparation";
import { applyStep2Operations } from "../../../components/tailoring/step2DraftView";
import { submitGeneration } from "../../../src/server/generations";
import { getGenerationRequest } from "../../../src/db/generation";
import { getTailoringJob } from "../../../src/db/tailoring";
import { getProfileVersion } from "../../../src/db/candidates";
import { newId } from "../../../src/db";
import { e2eProfile, e2eProposal } from "../tailoring/support";
import { makeArtifactsDir } from "./f-world";
import { s2bQ4 } from "./s2b-world";
import {
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  s2dDraft,
  s2dSaveDraft,
  s2dSubmit,
  s2dTailorProposal,
  s2dTailorProvider,
  seedS2dAccepted,
  versionForRequest,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAccepted,
} from "./s2d-world";

/**
 * WO-1.3-S2-D renderer legs (S2D3): Add/Replace/Exclude apply
 * consistently to the canonical draft and all three renderers —
 * accepted wording preserved, role attribution kept, order kept,
 * exclusions honored, and nothing silently dropped or reinstated.
 * Bullet counts are advisory length guidance: over-guidance
 * drafts validate and submit with every bullet; master bytes and
 * board pointers are untouched by generation.
 */

const OP_ADD = "11111111-1111-4111-8111-111111111111";
const OP_REP = "22222222-2222-4222-8222-222222222222";
const OP_X1 = "33333333-3333-4333-8333-333333333333";
const OP_X2 = "44444444-4444-4334-8444-444444444444";
const OP_X3 = "55555555-5555-4555-8555-555555555555";
const OP_EDIT = "66666666-6666-4666-8666-666666666666";

const flat = (text: string): string => text.replace(/\s+/g, " ");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("S2D3 generation applier", () => {
  const master: MasterBullet[] = [
    { factId: "f-a", roleId: "emp-1", text: "Alpha one." },
    { factId: "f-b", roleId: "emp-1", text: "Beta two." },
    { factId: "f-c", roleId: "emp-2", text: "Gamma three." },
  ];

  async function planOf() {
    let captured: S2dAccepted | null = null;
    await withS2dDatabase(async (t, world) => {
      captured = await seedS2dAccepted(t.handle, world);
    });
    if (captured === null) {
      throw new Error("unreachable");
    }
    return (captured as S2dAccepted).plan;
  }

  it("chains add/replace/exclude/edit with source-op tracking", async () => {
    const plan = await planOf();
    const suggestion = plan.suggestions.find((entry) => entry.usable);
    if (suggestion === undefined) {
      throw new Error("S2-D setup produced no usable suggestion");
    }
    const groups = applyEditedBullets({
      master,
      plan,
      operations: [
        { op: "add", operationId: OP_ADD, suggestionId: suggestion.suggestionId, roleId: "emp-1", editedText: null },
        { op: "replace", operationId: OP_REP, targetFactId: "f-b", suggestionId: null, roleId: "emp-1", editedText: "Beta reworded." },
        { op: "exclude", operationId: OP_X1, targetFactId: "f-c" },
        { op: "edit", operationId: OP_EDIT, target: { kind: "suggestion", suggestionId: suggestion.suggestionId }, text: suggestion.text },
        { op: "edit", operationId: "77777777-7777-4777-8777-777777777777", target: { kind: "bullet", factId: "f-a" }, text: "Alpha one." },
      ],
    });
    const emp1 = groups.find((group) => group.roleId === "emp-1")?.bullets ?? [];
    const emp2 = groups.find((group) => group.roleId === "emp-2")?.bullets ?? [];
    // Master order first (edited in place), then instances in op order.
    expect(emp1.map((bullet) => bullet.text)).toEqual([
      "Alpha one.",
      suggestion.text,
      "Beta reworded.",
    ]);
    expect(emp1[0]).toMatchObject({ kind: "master", factId: "f-a", sourceOperationId: "77777777-7777-4777-8777-777777777777" });
    expect(emp1[1]).toMatchObject({ kind: "added", sourceOperationId: OP_EDIT });
    expect(emp1[2]).toMatchObject({ kind: "replaced", factId: "f-b", sourceOperationId: OP_REP });
    expect(emp2).toEqual([]);
    // Unknown references throw instead of rendering orphans.
    expect(() =>
      applyEditedBullets({
        master,
        plan,
        operations: [
          { op: "add", operationId: OP_ADD, suggestionId: "nope", roleId: "emp-1", editedText: null },
        ],
      }),
    ).toThrow(/unknown suggestion/);
    expect(() =>
      applyEditedBullets({
        master,
        plan,
        operations: [
          { op: "edit", operationId: OP_EDIT, target: { kind: "suggestion", suggestionId: suggestion.suggestionId }, text: "x" },
        ],
      }),
    ).toThrow(/no added instance/);
  });

  it("derives edit roles from the first add-or-replace instance", async () => {
    const plan = await planOf();
    const suggestion = plan.suggestions.find((entry) => entry.usable);
    if (suggestion === undefined) {
      throw new Error("S2-D setup produced no usable suggestion");
    }
    // Replace-only instance: the edit validates against the
    // replace role (S2-D §7.5 amendment), not a null role.
    const derived = deriveStep2Segments({
      plan,
      master,
      summaryText: "Summary.",
      operations: [
        { op: "replace", operationId: OP_REP, targetFactId: "f-a", suggestionId: suggestion.suggestionId, roleId: "emp-2", editedText: null },
        { op: "edit", operationId: OP_EDIT, target: { kind: "suggestion", suggestionId: suggestion.suggestionId }, text: "Edited." },
      ],
    });
    expect(derived.find((segment) => segment.segmentId === `op:${OP_EDIT}`)?.roleId).toBe("emp-2");
    // First instance wins when several exist.
    const derived2 = deriveStep2Segments({
      plan,
      master,
      summaryText: "Summary.",
      operations: [
        { op: "replace", operationId: OP_REP, targetFactId: "f-a", suggestionId: suggestion.suggestionId, roleId: "emp-2", editedText: null },
        { op: "add", operationId: OP_ADD, suggestionId: suggestion.suggestionId, roleId: "emp-1", editedText: null },
        { op: "edit", operationId: OP_EDIT, target: { kind: "suggestion", suggestionId: suggestion.suggestionId }, text: "Edited." },
      ],
    });
    expect(derived2.find((segment) => segment.segmentId === `op:${OP_EDIT}`)?.roleId).toBe("emp-2");
  });

  it("agrees with the editor display applier on valid inputs", async () => {
    const plan = await planOf();
    const suggestion = plan.suggestions.find((entry) => entry.usable);
    if (suggestion === undefined) {
      throw new Error("S2-D setup produced no usable suggestion");
    }
    const operations: Step2DraftOperationV1[] = [
      { op: "add", operationId: OP_ADD, suggestionId: suggestion.suggestionId, roleId: "emp-2", editedText: null },
      { op: "replace", operationId: OP_REP, targetFactId: "f-a", suggestionId: null, roleId: "emp-1", editedText: "Alpha replaced." },
      { op: "exclude", operationId: OP_X1, targetFactId: "f-c" },
    ];
    const generated = applyEditedBullets({ master, plan, operations });
    const displayed = applyStep2Operations(master, plan, operations);
    const generatedRows = generated.flatMap((group) =>
      group.bullets.map((bullet) => `${group.roleId}::${bullet.text}`),
    );
    const displayedRows = displayed.flatMap((group) =>
      group.rows
        .filter((row) => !row.excluded)
        .map((row) => `${group.roleId}::${row.text}`),
    );
    expect(generatedRows).toEqual(displayedRows);
  });

  it("binds identical texts per bullet, never by text matching", () => {
    const profile = e2eProfile();
    const proposal = e2eProposal("jd-1", "cs-1") as { requirements: unknown };
    const built = buildTailoredDraft({
      profile,
      requirements: proposal.requirements,
      jobId: "job-1",
      jobTitle: "Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
      editedPlan: {
        summary: { text: "Engineer summary.", factIds: ["f_api"] },
        bullets: [
          { roleId: "emp-1", text: "Shared words here.", factIds: ["f_scale"], strategy: "edited_plan" },
          { roleId: "emp-1", text: "Shared words here.", factIds: ["f_team"], strategy: "edited_plan" },
        ],
      },
    });
    const experience = built.draft.claims.filter((claim) => claim["section"] === "experience");
    expect(experience).toHaveLength(2);
    expect(experience[0]?.["fact_ids"]).toEqual(["f_scale"]);
    expect(experience[1]?.["fact_ids"]).toEqual(["f_team"]);
    expect(built.citedFactIds).toEqual(["f_api", "f_scale", "f_team"]);
    const report = validateBuiltDraft({
      profile,
      draft: built.draft,
      editedPlan: {
        texts: [
          { text: "Engineer summary.", factIds: ["f_api"] },
          { text: "Shared words here.", factIds: ["f_scale"] },
          { text: "Shared words here.", factIds: ["f_team"] },
        ],
      },
    });
    expect(report.valid).toBe(true);
  });

  it("renders over-guidance edited plans in full; unknown roles still refuse", () => {
    const profile = e2eProfile();
    const proposal = e2eProposal("jd-1", "cs-1") as { requirements: unknown };
    // 8 bullets on prior emp-1 (guidance 3) + 8 on current emp-2
    // (guidance 5): 16 total over the 14 total guidance. Bullet
    // counts are advisory — nothing trims, nothing throws.
    const factCycle = ["f_scale", "f_team", "f_api", "f_auth"];
    const bullets = Array.from({ length: 16 }, (_, index) => ({
      roleId: index < 8 ? "emp-1" : "emp-2",
      text: `Kept bullet ${index} with distinct wording.`,
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
      editedPlan: { summary: { text: "S.", factIds: ["f_api"] }, bullets },
    });
    const experience = built.draft.claims.filter((claim) => claim["section"] === "experience");
    expect(experience).toHaveLength(16);
    expect(experience.map((claim) => claim["text"])).toEqual(
      bullets.map((bullet) => bullet.text),
    );
    expect(experience.map((claim) => claim["entity_id"])).toEqual(
      bullets.map((bullet) => bullet.roleId),
    );
    // Unknown roles refuse instead of dropping.
    expect(() =>
      buildTailoredDraft({
        profile,
        requirements: proposal.requirements,
        jobId: "job-1",
        jobTitle: "Engineer",
        jobCompany: "Acme",
        asOf: "2024-05-01",
        editedPlan: {
          summary: { text: "S.", factIds: ["f_api"] },
          bullets: [{ roleId: "emp-9", text: "Lost.", factIds: ["f_scale"], strategy: "edited_plan" }],
        },
      }),
    ).toThrow(/unknown role.*refusing to drop/);
  });
});

describe("S2D3 renderers", () => {
  it("applies add/replace/exclude with order kept across all formats", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const angle = accepted.plan.positioning.angles[0];
      if (angle === undefined) {
        throw new Error("S2-D setup lost the plan angle");
      }
      const summary = accepted.plan.positioning.keepMasterSummary;
      const added = accepted.usableSuggestion.text;
      const replaced = angle.summaryText;
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: OP_ADD,
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: null,
          },
          {
            op: "replace",
            operationId: OP_REP,
            targetFactId: "pm-fact-roadmap",
            suggestionId: null,
            roleId: "emp-harbor",
            editedText: replaced,
          },
          { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
        ],
        summary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
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
      const gtm = accepted.statements.get("pm-fact-gtm") ?? "∅";
      const roadmap = accepted.statements.get("pm-fact-roadmap") ?? "∅";
      const pricing = accepted.statements.get("pm-fact-pricing") ?? "∅";
      const experiment = accepted.statements.get("pm-fact-experiment") ?? "∅";
      for (const [format, text] of Object.entries(texts)) {
        const body = flat(text);
        expect(body.includes(flat(summary)), `${format} summary`).toBe(true);
        expect(body.includes(flat(added)), `${format} added`).toBe(true);
        expect(body.includes(flat(replaced)), `${format} replaced`).toBe(true);
        expect(body.includes(flat(gtm)), `${format} kept master`).toBe(true);
        expect(body.includes(flat(experiment)), `${format} beacon master`).toBe(true);
        expect(body.includes(flat(roadmap)), `${format} drops replaced target`).toBe(false);
        expect(body.includes(flat(pricing)), `${format} drops excluded`).toBe(false);
      }
      // Canonical order: kept master first, then instances in op order.
      const harborHead = texts.markdown.indexOf("Harbor Analytics");
      const atGtm = texts.markdown.indexOf(gtm);
      const atAdded = texts.markdown.indexOf(added);
      const atReplaced = texts.markdown.indexOf(replaced);
      expect(harborHead).toBeGreaterThanOrEqual(0);
      expect(atGtm).toBeGreaterThan(harborHead);
      expect(atAdded).toBeGreaterThan(atGtm);
      expect(atReplaced).toBeGreaterThan(atAdded);
    });
  });

  it("replaces by reference without reinstating the excluded master twin", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const added = accepted.usableSuggestion.text;
      // Replace roadmap with the usable suggestion while the
      // suggestion's master twin (discovery) stays excluded: the
      // bytes render exactly once, from the replace instance.
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "replace",
            operationId: OP_REP,
            targetFactId: "pm-fact-roadmap",
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: null,
          },
          { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
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
      for (const [format, text] of Object.entries(texts)) {
        expect(
          countOccurrences(flat(text), flat(added)),
          `${format} renders the replacement exactly once`,
        ).toBe(1);
        expect(
          flat(text).includes(flat(accepted.statements.get("pm-fact-roadmap") ?? "∅")),
          `${format} drops the replaced target`,
        ).toBe(false);
      }
    });
  });

  it("submits over-guidance drafts with every bullet; counts never 422", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      // Keep-master draft: 5 Harbor bullets over the 3/role
      // guidance. Validation reports the advisory counts, and
      // generation queues instead of refusing BUDGET_EXCEEDED.
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
      expect(checked.value.validation.budget.exceeded).toBe(true);
      expect(checked.value.validation.budget.totalBullets).toBe(6);
      expect(checked.value.validation.budget.perRoleCounts).toContainEqual({
        roleId: "emp-harbor",
        bullets: 5,
      });
      const requestId = newId();
      const submitted = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId,
          workspaceRevision: revision,
          observedRowVersion: getTailoringJob(handle, accepted.basics.jobId)?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(submitted).toMatchObject({ ok: true });
      if (!submitted.ok) {
        throw new Error(`over-guidance submit refused: ${submitted.failure.error} ${submitted.failure.detail}`);
      }
      expect(getGenerationRequest(handle, requestId)).not.toBeNull();
    });
  });

  it("leaves master bytes, pointers, and the board untouched", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const payloadBefore = getProfileVersion(handle, accepted.basics.profileVersionId)?.payloadJson;
      const jobBefore = getTailoringJob(handle, accepted.basics.jobId);
      const q4Before = s2bQ4(handle);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: OP_ADD,
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: null,
          },
          { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const { claim, outcome } = await runS2dTailor(
        handle,
        submitted,
        s2dTailorProvider(submitted, proposal, () => accepted.now),
        makeArtifactsDir(),
        { now: accepted.now },
      );
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(handle, claim, outcome, accepted.now);
      expect(versionForRequest(handle, submitted.requestId).id).toBeTruthy();
      expect(getProfileVersion(handle, accepted.basics.profileVersionId)?.payloadJson).toBe(
        payloadBefore,
      );
      const jobAfter = getTailoringJob(handle, accepted.basics.jobId);
      expect(jobAfter?.status).toBe(jobBefore?.status);
      // Publishing moves the active pointer to the new version;
      // the human-selected pointer never moves on this path.
      const published = versionForRequest(handle, submitted.requestId);
      expect(jobAfter?.activeResumeVersionId).toBe(published.id);
      expect(jobAfter?.selectedResumeVersionId).toBe(jobBefore?.selectedResumeVersionId);
      expect(jobAfter?.selectedResumeVersionId).toBeNull();
      expect(s2bQ4(handle)).toEqual(q4Before);
    });
  });
});
