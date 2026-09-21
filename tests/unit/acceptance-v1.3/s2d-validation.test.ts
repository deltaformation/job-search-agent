// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId, resumeClaimFacts, resumeClaims } from "../../../src/db";
import type { DatabaseHandle } from "../../../src/db";
import { readWorkspace } from "../../../src/db/tailoringWorkspace";
import type { Step2DraftOperationV1 } from "../../../src/domain/step2";
import { submitGeneration } from "../../../src/server/generations";
import { validateClaim } from "../../../src/tailoring/validator";
import { makeArtifactsDir } from "./f-world";
import { s2bQ1 } from "./s2b-world";
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
  type S2dAccepted,
} from "./s2d-world";

/**
 * WO-1.3-S2-D validation gate (S2D1): supported edits keep their
 * exact accepted wording and role citations in canonical output;
 * invented technology, metrics, and responsibilities stay saved as
 * drafts but block generation with 422-class errors and zero Q1
 * effects. Neither a valid fact id nor a plan usability badge
 * alone can pass claim validation — only exact evidence-equal
 * text (or an allowlisted derivation, of which the policy ships
 * none) validates.
 */

const OP_ADD = "11111111-1111-4111-8111-111111111111";
const OP_X1 = "22222222-2222-4222-8222-222222222222";
const OP_X2 = "33333333-3333-4333-8333-333333333333";
const OP_X3 = "44444444-4444-4334-8444-444444444444";
const OP_REWORD = "55555555-5555-4555-8555-555555555555";

/** Harbor carries 5 master bullets; curation to 3 needs 3 excludes with one add. */
function curationExcludes(): Step2DraftOperationV1[] {
  return [
    { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
    { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
    { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
  ];
}

function supportedDraft(accepted: S2dAccepted) {
  return s2dDraft(
    accepted,
    [
      {
        op: "add",
        operationId: OP_ADD,
        suggestionId: accepted.usableSuggestion.suggestionId,
        roleId: accepted.usableSuggestion.roleId,
        editedText: null,
      },
      ...curationExcludes(),
    ],
    accepted.plan.positioning.keepMasterSummary,
    "master",
  );
}

function claimsForVersion(handle: DatabaseHandle, versionId: string) {
  const claims = handle.db
    .select()
    .from(resumeClaims)
    .where(eq(resumeClaims.resumeVersionId, versionId))
    .all();
  const facts = handle.db.select().from(resumeClaimFacts).all();
  const byClaim = new Map<string, string[]>();
  for (const row of facts) {
    const list = byClaim.get(row.claimId) ?? [];
    list.push(row.factId);
    byClaim.set(row.claimId, list);
  }
  return claims.map((claim) => ({
    text: claim.claimText,
    cited: (byClaim.get(claim.id) ?? []).sort(),
  }));
}

describe("S2D1 edited-text validation gate", () => {
  it("renders supported edits with exact wording and role citations", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const draft = supportedDraft(accepted);
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

      // Canonical claims carry the exact accepted bytes plus
      // their verdict fact bindings.
      const claims = claimsForVersion(handle, version.id);
      const summary = claims.find(
        (row) => row.text === accepted.plan.positioning.keepMasterSummary,
      );
      expect(summary).toBeDefined();
      expect(summary?.cited.length).toBeGreaterThan(0);
      const added = claims.find((row) => row.text === accepted.usableSuggestion.text);
      expect(added).toBeDefined();
      expect(added?.cited).toEqual([...accepted.usableSuggestion.factIds].sort());
      // Untouched master rows render snapshot bytes verbatim.
      const roadmap = claims.find((row) => row.text === accepted.statements.get("pm-fact-roadmap"));
      expect(roadmap?.cited).toEqual(["pm-fact-roadmap"]);
      // Excluded master bullets never become claims.
      expect(
        claims.some((row) => row.text === accepted.statements.get("pm-fact-pricing")),
      ).toBe(false);

      const texts = await readS2dArtifactTexts(handle, artifactsDir, version.id);
      // Whitespace-normalized containment: the PDF stub wraps
      // lines at 90 chars (same comparison the pipeline's own
      // projection check uses).
      const flat = (text: string): string => text.replace(/\s+/g, " ");
      for (const [format, text] of Object.entries(texts)) {
        expect(
          flat(text).includes(flat(accepted.plan.positioning.keepMasterSummary)),
          `${format} carries the edited summary`,
        ).toBe(true);
        expect(
          flat(text).includes(flat(accepted.usableSuggestion.text)),
          `${format} carries the added bullet`,
        ).toBe(true);
      }
      // Role attribution: the added bullet renders under its Harbor
      // employer heading, after the untouched Harbor bullets.
      const harborHead = texts.markdown.indexOf("Harbor Analytics");
      const addedAt = texts.markdown.indexOf(accepted.usableSuggestion.text);
      const roadmapAt = texts.markdown.indexOf(accepted.statements.get("pm-fact-roadmap") ?? "∅");
      expect(harborHead).toBeGreaterThanOrEqual(0);
      expect(addedAt).toBeGreaterThan(harborHead);
      expect(roadmapAt).toBeGreaterThan(harborHead);
      expect(roadmapAt).toBeLessThan(addedAt);
    });
  });

  it("blocks invented metrics while the draft stays saved", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: OP_ADD,
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: `${accepted.usableSuggestion.text} Lifting revenue by 47% quarter over quarter.`,
          },
          ...curationExcludes(),
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const storedBefore = readWorkspace(handle, accepted.basics.jobId)?.focusJson;
      const q1Before = s2bQ1(handle);
      const blocked = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: 1,
          actor: "human",
          now: accepted.now,
        },
        { env: { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" } },
      );
      expect(blocked).toMatchObject({
        ok: false,
        failure: { error: "unresolved-evidence" },
      });
      if (blocked.ok) {
        throw new Error("unreachable");
      }
      expect(blocked.failure.detail).toContain("NEW_METRIC");
      expect(blocked.failure.detail).toContain(OP_ADD);
      expect(s2bQ1(handle)).toEqual(q1Before);
      // The draft is untouched: same revision, same bytes.
      const storedAfter = readWorkspace(handle, accepted.basics.jobId);
      expect(storedAfter?.revision).toBe(revision);
      expect(storedAfter?.focusJson).toBe(storedBefore);
    });
  });

  it("blocks invented technology without numbers", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: OP_ADD,
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: `${accepted.usableSuggestion.text} Replatformed scheduling onto Kubernetes.`,
          },
          ...curationExcludes(),
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const q1Before = s2bQ1(handle);
      const blocked = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: 1,
          actor: "human",
          now: accepted.now,
        },
        { env: { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" } },
      );
      expect(blocked).toMatchObject({
        ok: false,
        failure: { error: "unresolved-evidence" },
      });
      if (blocked.ok) {
        throw new Error("unreachable");
      }
      expect(blocked.failure.detail).toContain("REWORDED");
      expect(s2bQ1(handle)).toEqual(q1Before);
    });
  });

  it("a plan usability badge cannot pass a reworded edit", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      expect(
        accepted.plan.suggestions.find(
          (suggestion) => suggestion.suggestionId === accepted.usableSuggestion.suggestionId,
        )?.usable,
      ).toBe(true);
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
            op: "edit",
            operationId: OP_REWORD,
            target: { kind: "suggestion", suggestionId: accepted.usableSuggestion.suggestionId },
            text: "Single-handedly reorganized the entire company around discovery rituals.",
          },
          ...curationExcludes(),
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const blocked = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: 1,
          actor: "human",
          now: accepted.now,
        },
        { env: { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" } },
      );
      expect(blocked).toMatchObject({
        ok: false,
        failure: { error: "unresolved-evidence" },
      });
      if (blocked.ok) {
        throw new Error("unreachable");
      }
      expect(blocked.failure.detail).toContain(OP_REWORD);
      expect(blocked.failure.detail).toContain("REWORDED");
    });
  });

  it("a valid fact id alone cannot pass reworded text", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "edit",
            operationId: OP_REWORD,
            target: { kind: "bullet", factId: "pm-fact-roadmap" },
            text: "Owned every roadmap on earth and several on Mars.",
          },
          {
            op: "add",
            operationId: OP_ADD,
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: null,
          },
          ...curationExcludes(),
        ],
        accepted.plan.positioning.keepMasterSummary,
        "master",
      );
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const blocked = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: 1,
          actor: "human",
          now: accepted.now,
        },
        { env: { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" } },
      );
      expect(blocked).toMatchObject({
        ok: false,
        failure: { error: "unresolved-evidence" },
      });
      if (blocked.ok) {
        throw new Error("unreachable");
      }
      // The citation is a real approved fact; the words are not its
      // statement, so the gate names the reword, not the citation.
      expect(blocked.failure.detail).toContain(OP_REWORD);
    });
  });

  it("edited_plan claims re-pin text, binding, tamper, and attribution", () => {
    const profile = {
      verified_facts: [
        {
          fact_id: "f1",
          category: "achievement",
          text: "Shipped widgets.",
          technologies: ["TypeScript"],
          metrics: ["+9%"],
          work_experience_id: "emp-1",
          verification_status: "approved",
        },
      ],
      work_experience: [
        {
          id: "emp-1",
          company: "Acme",
          role: "PM",
          start_date: "2020-01-01",
          end_date: null,
          is_current: true,
        },
      ],
      education: [],
    };
    const claim = {
      section: "experience",
      entity_id: "emp-1",
      company: "Acme",
      role: "PM",
      dates: { start: "2020-01-01", end: "Present" },
      text: "Shipped widgets.",
      fact_ids: ["f1"],
      claimed_technologies: ["TypeScript"],
      claimed_metrics: ["+9%"],
      generation_strategy: "edited_plan",
    };
    expect(
      validateClaim({
        profile,
        claim,
        editedPlan: { texts: [{ text: "Shipped widgets.", factIds: ["f1"] }] },
      }).valid,
    ).toBe(true);
    // No context: edited_plan is not an accepted strategy.
    expect(validateClaim({ profile, claim }).valid).toBe(false);
    // Reworded text is not allowlisted.
    expect(
      validateClaim({
        profile,
        claim: { ...claim, text: "Shipped many widgets fast." },
        editedPlan: { texts: [{ text: "Shipped widgets.", factIds: ["f1"] }] },
      }).valid,
    ).toBe(false);
    // Right text, wrong binding.
    expect(
      validateClaim({
        profile,
        claim,
        editedPlan: { texts: [{ text: "Shipped widgets.", factIds: ["f2"] }] },
      }).valid,
    ).toBe(false);
    // Tampered metric outside the cited union.
    expect(
      validateClaim({
        profile,
        claim: { ...claim, claimed_metrics: ["+900%"] },
        editedPlan: { texts: [{ text: "Shipped widgets.", factIds: ["f1"] }] },
      }).valid,
    ).toBe(false);
    // Misattributed employment.
    expect(
      validateClaim({
        profile,
        claim: { ...claim, entity_id: "emp-2" },
        editedPlan: { texts: [{ text: "Shipped widgets.", factIds: ["f1"] }] },
      }).valid,
    ).toBe(false);
  });
});
