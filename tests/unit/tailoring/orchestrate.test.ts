// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadDocxTemplateBytes } from "../../../src/resumes/docx";
import { extractPdfText } from "../../../src/resumes/pdf";
import { ProviderError } from "../../../src/tailoring/contract";
import { orchestrateTailoring, type OrchestrationInputs } from "../../../src/tailoring/orchestrate";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { E2E_JD_TEXT, e2eProfile, e2eProposal, stubRenderPdf } from "./support";

function inputs(): OrchestrationInputs {
  return {
    jobId: "job-e2e-1",
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
  };
}

describe("tailoring orchestration", () => {
  it("runs the full pipeline to four verified artifacts", async () => {
    const provider = new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`orchestration failed: ${result.reason} ${result.detail}`);
    }
    const value = result.value;
    expect(value.requirements).toHaveLength(5);
    expect(value.gaps.map((gap) => gap.requirement_id).sort()).toEqual(["req_cobol", "req_k8s"]);
    expect(value.draft.claims).toHaveLength(6);
    expect(value.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(value.markdown.subarray(0, 2).toString()).toBe("# ");
    expect(value.docx.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(value.html).toContain("<h1>Orchestration Candidate</h1>");
    const pdf = await extractPdfText(value.pdf);
    expect(pdf.pageCount).toBe(1);
    expect(value.content.audit.requirementsTotal).toBe(5);
    expect(value.content.audit.supportedCount).toBe(3);
    expect(value.content.audit.gapCount).toBe(2);
    expect(value.content.audit.validatedClaims).toBe(6);
    expect(value.content.audit.factsReferenced.sort()).toEqual(["f_api", "f_auth", "f_scale", "f_team"]);
    expect(value.content.audit.providerId).toBe("test-provider");
    expect(value.content.changeSummary.summaryChanged).toBe(true);
    expect(provider.receivedInputs).toHaveLength(1);
    // Skills keep their profile category with JD-matched terms first.
    expect(value.markdown.toString()).toContain("**technical:** TypeScript, SAML, COBOL");
    // Gaps never leak into claims or keywords.
    const claimTexts = value.draft.claims.map((claim) => String(claim["text"])).join("\n");
    expect(claimTexts).not.toContain("COBOL");
    expect(claimTexts).not.toContain("Kubernetes");
    expect(value.content.omittedUnsupported.length).toBeGreaterThan(0);
  });

  it("rejects proposals with fabricated JD quotes", async () => {
    const bad = e2eProposal("jd-e2e-1", "cs-e2e-1");
    const requirements = bad["requirements"] as Array<Record<string, unknown>>;
    requirements[0] = { ...requirements[0], jd_quote: "Ten years of COBOL wizardry" };
    const provider = new TestProvider({ proposals: { "jd-e2e-1": bad } });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(result.detail).toContain("must quote exact JD text");
    expect(result.proposal).toBeNull();
  });

  it("rejects proposals bound to other snapshots", async () => {
    const provider = new TestProvider({
      proposals: { "jd-e2e-1": e2eProposal("jd-other", "cs-other") },
    });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(result.detail).toContain("different snapshots");
    expect(result.proposal).toBeNull();
  });

  it("passes provider timeouts through reason-coded", async () => {
    const provider = new TestProvider({ proposals: {} });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(result.proposal).toBeNull();
  });

  it("maps provider TIMEOUT without inventing output", async () => {
    const provider = {
      providerId: "flaky",
      prepare: async () => {
        throw new ProviderError("TIMEOUT", "provider exceeded 1ms");
      },
    };
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.reason).toBe("TIMEOUT");
    expect(result.proposal).toBeNull();
  });

  it("fails closed when the PDF drops resume text", async () => {
    const provider = new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      // A degenerate renderer whose output cannot contain the fragments.
      renderPdf: async () => ({ bytes: Buffer.from("not a pdf at all") }),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.reason).toBe("RENDER_FAILED");
    // The proposal was accepted before rendering failed.
    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.requirements).toHaveLength(5);
  });

  it("rejects scripted proposals that smuggle approval fields", async () => {
    const smuggled = { ...e2eProposal("jd-e2e-1", "cs-e2e-1"), approval: "APPROVED" };
    const provider = new TestProvider({ proposals: { "jd-e2e-1": smuggled } });
    const result = await orchestrateTailoring(inputs(), {
      provider,
      renderPdf: async (html) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(result.detail).toContain("schema validation");
    expect(result.proposal).toBeNull();
  });

  it("fails closed on an empty job description", async () => {
    const provider = new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } });
    const result = await orchestrateTailoring(
      { ...inputs(), jobDescription: "   " },
      {
        provider,
        renderPdf: async (html) => stubRenderPdf(html),
        docxTemplateBytes: loadDocxTemplateBytes(),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.reason).toBe("STALE_INPUT");
    expect(provider.receivedInputs).toHaveLength(0);
  });

  it("binds human guidance into the hashed input envelope", async () => {
    const deps = () => ({
      provider: new TestProvider({ proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") } }),
      renderPdf: async (html: string) => stubRenderPdf(html),
      docxTemplateBytes: loadDocxTemplateBytes(),
    });
    const plain = await orchestrateTailoring(inputs(), deps());
    const guided = await orchestrateTailoring(
      {
        ...inputs(),
        profileId: "local",
        selectedKeywords: ["Kubernetes", "Go"],
        directives: "Emphasize scale.",
      },
      deps(),
    );
    expect(plain.ok).toBe(true);
    expect(guided.ok).toBe(true);
    if (!plain.ok || !guided.ok) {
      throw new Error("expected success");
    }
    // Guidance reaches the provider envelope verbatim ...
    const guidedProvider = new TestProvider({
      proposals: { "jd-e2e-1": e2eProposal("jd-e2e-1", "cs-e2e-1") },
    });
    await orchestrateTailoring(
      { ...inputs(), selectedKeywords: ["Kubernetes"], directives: "Emphasize scale." },
      {
        provider: guidedProvider,
        renderPdf: async (html) => stubRenderPdf(html),
        docxTemplateBytes: loadDocxTemplateBytes(),
      },
    );
    expect(guidedProvider.receivedInputs).toHaveLength(1);
    expect(guidedProvider.receivedInputs[0]).toMatchObject({
      selectedKeywords: ["Kubernetes"],
      directives: "Emphasize scale.",
    });
    // ... and forks the input hash recorded on the analysis.
    expect(guided.value.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(guided.value.inputHash).not.toBe(plain.value.inputHash);
    const repeat = await orchestrateTailoring(
      {
        ...inputs(),
        profileId: "local",
        selectedKeywords: ["Kubernetes", "Go"],
        directives: "Emphasize scale.",
      },
      deps(),
    );
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) {
      throw new Error("expected success");
    }
    expect(repeat.value.inputHash).toBe(guided.value.inputHash);
  });
});
