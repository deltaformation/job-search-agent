// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EXIT_AUTH,
  EXIT_BAD_RESPONSE,
  EXIT_NETWORK,
  EXIT_RATE_LIMIT,
  EXIT_TIMEOUT,
  validateProposal,
} from "../../../scripts/prepare-provider.mjs";
import {
  PROVIDER_EXIT_AUTH,
  PROVIDER_EXIT_BAD_RESPONSE,
  PROVIDER_EXIT_NETWORK,
  PROVIDER_EXIT_RATE_LIMIT,
  PROVIDER_EXIT_TIMEOUT,
} from "../../../src/tailoring/commandAdapter";

/**
 * Prepare-sidecar contract pins (found by the S2CPC5 live attempt):
 * exit codes must match the adapter/tailor convention, and
 * suggestion-only model responses (no `angles` key) must validate
 * instead of crashing on block-scoped link state.
 */

const JD_TEXT = [
  "We need supply chain systems leadership here.",
  "Own the product roadmap end to end here.",
  "Lead Agile delivery with engineering here.",
].join("\n");

function sidecarInput(): Record<string, unknown> {
  return {
    jdText: JD_TEXT,
    extractionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    jdSnapshotId: "jd-1",
    candidateSnapshotId: "cand-1",
    approvedFactIds: ["fact-1", "fact-2"],
    profile: { employment: [{ id: "emp-1" }, { id: "emp-2" }] },
  };
}

describe("prepare sidecar exit codes", () => {
  it("matches the adapter contract 10/11/12/13/14", () => {
    expect([EXIT_AUTH, EXIT_RATE_LIMIT, EXIT_TIMEOUT, EXIT_BAD_RESPONSE, EXIT_NETWORK]).toEqual([
      10, 11, 12, 13, 14,
    ]);
    expect(EXIT_AUTH).toBe(PROVIDER_EXIT_AUTH);
    expect(EXIT_RATE_LIMIT).toBe(PROVIDER_EXIT_RATE_LIMIT);
    expect(EXIT_TIMEOUT).toBe(PROVIDER_EXIT_TIMEOUT);
    expect(EXIT_BAD_RESPONSE).toBe(PROVIDER_EXIT_BAD_RESPONSE);
    expect(EXIT_NETWORK).toBe(PROVIDER_EXIT_NETWORK);
  });
});

describe("validateProposal", () => {
  it("validates a suggestion-only response with no angles key", () => {
    const result = validateProposal(
      {
        priorities: [
          {
            quote: "product roadmap",
            count: 2,
            category: "delivery",
            importance: "required",
            matchStatus: "matched",
            factIds: ["fact-1"],
          },
        ],
        suggestions: [
          {
            roleId: "emp-1",
            text: "Owned the product roadmap end to end.",
            factIds: ["fact-1"],
            priorityQuotes: ["product roadmap"],
          },
        ],
        rationale: "Suggestion-only model response.",
      },
      sidecarInput(),
    );
    expect(result.ok).toBe(true);
    if (result.proposal === undefined) {
      throw new Error("expected a proposal");
    }
    expect(result.proposal.priorities).toHaveLength(1);
    expect(result.proposal.angles).toEqual([]);
    expect(result.proposal.suggestions).toHaveLength(1);
    expect(result.proposal.suggestions[0].priorityIds).toHaveLength(1);
  });

  it("resolves angle links against verified priority quotes", () => {
    const result = validateProposal(
      {
        priorities: [
          {
            quote: "supply chain systems",
            count: 1,
            category: "domain",
            importance: "required",
            matchStatus: "matched",
            factIds: ["fact-2"],
          },
        ],
        angles: [
          {
            title: "Domain transfer",
            summaryText: "Systems leader moving into supply chain.",
            factIds: ["fact-2"],
            priorityQuotes: ["supply chain systems"],
          },
        ],
        suggestions: [],
        rationale: "Angle response.",
      },
      sidecarInput(),
    );
    expect(result.ok).toBe(true);
    if (result.proposal === undefined) {
      throw new Error("expected a proposal");
    }
    expect(result.proposal.angles).toHaveLength(1);
    expect(result.proposal.angles[0].priorityIds).toHaveLength(1);
  });

  it("drops quotes that are not verbatim JD substrings", () => {
    const result = validateProposal(
      {
        priorities: [{ quote: "quantum logistics telepathy", factIds: ["fact-1"] }],
        suggestions: [],
        rationale: "Hallucinated quote.",
      },
      sidecarInput(),
    );
    expect(result.ok).toBe(true);
    if (result.proposal === undefined) {
      throw new Error("expected a proposal");
    }
    expect(result.proposal.priorities).toEqual([]);
  });
});
