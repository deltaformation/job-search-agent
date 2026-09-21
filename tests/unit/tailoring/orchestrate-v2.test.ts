// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/domain/canonical";
import { loadDocxTemplateBytes } from "../../../src/resumes/docx";
import {
  TAILORING_INPUT_SCHEMA_VERSION_V2,
  TAILOR_PROMPT_VERSION_V2,
} from "../../../src/tailoring/contract";
import { orchestrateTailoring, type OrchestrationInputs } from "../../../src/tailoring/orchestrate";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { E2E_JD_TEXT, e2eProfile, e2eProposal, stubRenderPdf } from "./support";
import { v2FocusPair } from "./v2FocusFixtures";

/**
 * E3 provider/compiler integration: the spy receives the exact frozen
 * v2 envelope (including a 4000-character revision note); the
 * deterministic compiler reorders the mapped fact, quarantines the
 * invented summary sentence as a gap, and reports focus outcomes. A
 * lone focus snapshot fails closed before any provider call.
 */

function inputs(summaryDirection: string): OrchestrationInputs {
  const { focus, recommendations } = v2FocusPair({ focus: { summaryDirection } });
  return {
    jobId: "job-e2e-v2",
    jobTitle: "Backend Engineer",
    jobCompany: "Acme",
    jobDescription: E2E_JD_TEXT,
    profile: e2eProfile(),
    jdSnapshot: { id: "jd-e2e-1", jdText: E2E_JD_TEXT, createdAt: "2026-09-01T10:00:00.000Z" },
    candidateSnapshot: {
      id: "cs-e2e-1",
      snapshotHash: "b".repeat(64),
      createdAt: "2026-09-02T10:00:00.000Z",
    },
    profileId: "local",
    selectedKeywords: ["Redis caching"],
    directives: "Emphasize caching.",
    revisionNote: "n".repeat(4000),
    focus,
    recommendations,
  };
}

describe("v2 orchestration (E3)", () => {
  it("sends the exact frozen v2 envelope and quarantines invented summary wording", async () => {
    const request = inputs(
      "NetSuite ERP rollout delivered 30% faster implementations. Backend Engineer specializing in TypeScript delivery.",
    );
    const provider = new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } });
    const result = await orchestrateTailoring(request, {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`v2 orchestration failed: ${result.reason} ${result.detail}`);
    }
    expect(provider.receivedInputs).toHaveLength(1);
    const received = provider.receivedInputs[0];
    expect(received?.schemaVersion).toBe(TAILORING_INPUT_SCHEMA_VERSION_V2);
    expect(received?.promptVersion).toBe(TAILOR_PROMPT_VERSION_V2);
    expect(canonicalJson(received)).toBe(
      canonicalJson({
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
        jobId: request.jobId,
        jobTitle: request.jobTitle,
        company: request.jobCompany,
        jdSnapshotId: request.jdSnapshot.id,
        jdText: request.jobDescription,
        candidateSnapshotId: request.candidateSnapshot.id,
        profile: request.profile,
        approvedFactIds: ["f_api", "f_auth", "f_scale", "f_team"],
        promptVersion: TAILOR_PROMPT_VERSION_V2,
        profileId: "local",
        selectedKeywords: ["Redis caching"],
        directives: "Emphasize caching.",
        revisionNote: "n".repeat(4000),
        focus: request.focus,
        recommendations: request.recommendations,
      }),
    );
    expect(result.value.content.audit.promptVersion).toBe(TAILOR_PROMPT_VERSION_V2);
    expect(result.value.content.rankedFactIds[0]).toBe("f_scale");
    expect(result.value.gaps.map((gap) => gap.requirement_id)).toContain("summary-0");
    const generated = [
      ...result.value.draft.claims.map((claim) => String(claim["text"])),
      result.value.plainText,
      result.value.markdown.toString(),
      result.value.html,
    ].join("\n");
    expect(generated).not.toContain("NetSuite");
    expect(generated).not.toContain("30%");
    expect(
      result.value.focusOutcomes.find((outcome) => outcome.field === "mappings"),
    ).toMatchObject({ outcome: "used", evidenceFactIds: ["f_scale"] });
    expect(
      result.value.focusOutcomes
        .filter((outcome) => outcome.field === "summaryDirection")
        .map((outcome) => outcome.outcome),
    ).toEqual(["unsupported", "not-assessed"]);
  });

  it("fails closed on a lone focus snapshot without calling the provider", async () => {
    const request = inputs("");
    const provider = new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } });
    const result = await orchestrateTailoring(
      { ...request, recommendations: undefined },
      {
        provider,
        renderPdf: async (html) => stubRenderPdf(html),
        docxTemplateBytes: loadDocxTemplateBytes(),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected lone-focus rejection");
    }
    expect(result.reason).toBe("STALE_INPUT");
    expect(provider.receivedInputs).toHaveLength(0);
  });
});
