import { sha256HexUtf8 } from "./hash";
import {
  PROVIDER_ATTEMPT_SCHEMA_VERSION,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  TAILOR_PROMPT_VERSION,
  ProviderError,
  type ProviderAttemptV1,
  type TailoringInputV1,
  type TailoringProvider,
} from "./contract";

/**
 * Deterministic fixture provider for tests and offline development.
 * Returns deep copies of scripted proposals keyed by JD snapshot id;
 * records every input it receives so tests can assert envelope
 * immutability. Scripted proposals still pass strict schema validation,
 * so a bad fixture fails loudly instead of testing nothing.
 */

export const TEST_PROVIDER_ID = "test-provider";

export interface TestProviderOptions {
  proposals: Record<string, unknown>;
  model?: string | null;
  clock?: () => string;
}

function canonicalProposalHash(proposal: ResumeProposalV1): string {
  return sha256HexUtf8(JSON.stringify(proposal));
}

export class TestProvider implements TailoringProvider {
  readonly providerId = TEST_PROVIDER_ID;
  private readonly proposals: Record<string, unknown>;
  private readonly model: string | null;
  private readonly clock: () => string;
  readonly receivedInputs: TailoringInputV1[] = [];

  constructor(options: TestProviderOptions) {
    this.proposals = options.proposals;
    this.model = options.model ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async prepare(input: TailoringInputV1): Promise<{
    proposal: ResumeProposalV1;
    attempt: ProviderAttemptV1;
  }> {
    const startedAt = this.clock();
    this.receivedInputs.push(structuredClone(input));
    const scripted = this.proposals[input.jdSnapshotId];
    if (scripted === undefined) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `test provider has no scripted proposal for jd snapshot '${input.jdSnapshotId}'`,
      );
    }
    const parsed = ResumeProposalV1.safeParse(structuredClone(scripted));
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}`);
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `scripted proposal failed schema validation: ${paths.join(", ")}`,
      );
    }
    const finishedAt = this.clock();
    return {
      proposal: parsed.data,
      attempt: this.buildAttempt(input, parsed.data, startedAt, finishedAt),
    };
  }

  private buildAttempt(
    input: TailoringInputV1,
    proposal: ResumeProposalV1,
    startedAt: string,
    finishedAt: string,
  ): ProviderAttemptV1 {
    return {
      schemaVersion: PROVIDER_ATTEMPT_SCHEMA_VERSION,
      providerId: this.providerId,
      model: this.model,
      executable: null,
      argvHash: null,
      configVersion: "test-provider/v1",
      promptVersion: TAILOR_PROMPT_VERSION,
      proposalSchemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
      startedAt,
      finishedAt,
      exitCode: 0,
      timedOut: false,
      outputBytes: JSON.stringify(proposal).length,
      inputHash: sha256HexUtf8(JSON.stringify(input)),
      proposalHash: canonicalProposalHash(proposal),
      questions: proposal.questions,
    };
  }
}
