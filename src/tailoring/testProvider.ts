import { canonicalJson } from "../domain/canonical";
import { sha256HexUtf8 } from "./hash";
import {
  PROVIDER_ATTEMPT_SCHEMA_VERSION,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  PreparationProposalV2,
  ProviderError,
  type PreparationAttemptLineage,
  type PreparationInputV2Type,
  type PreparationProposalV2Type,
  type PrepareProvider,
  type ProviderAttemptV1,
  type TailoringInputV1,
  type TailoringInputV2,
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
export const TEST_PREPARE_PROVIDER_ID = "test-prepare-provider";

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
  readonly receivedInputs: Array<TailoringInputV1 | TailoringInputV2> = [];

  constructor(options: TestProviderOptions) {
    this.proposals = options.proposals;
    this.model = options.model ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async prepare(input: TailoringInputV1 | TailoringInputV2): Promise<{
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
    input: TailoringInputV1 | TailoringInputV2,
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
      promptVersion: input.promptVersion,
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

export interface TestPrepareProviderOptions {
  proposals: Record<string, unknown>;
  failures?: Record<string, { reason: "AUTHENTICATION" | "RATE_LIMIT" | "TIMEOUT" | "NETWORK" | "INVALID_RESPONSE" | "LOCAL_LAUNCH" | "PROVIDER_UNAVAILABLE"; detail?: string; spawnCode?: string | null }>;
  model?: string | null;
  clock?: () => string;
}

/**
 * Deterministic fixture preparation provider for tests. Returns deep
 * copies of scripted proposals keyed by JD snapshot id; records
 * every input so tests can assert envelope identity and zero-call
 * behavior. Scripted proposals still pass strict schema validation.
 */
export class TestPrepareProvider implements PrepareProvider {
  readonly providerId = TEST_PREPARE_PROVIDER_ID;
  private readonly proposals: Record<string, unknown>;
  private readonly failures: NonNullable<TestPrepareProviderOptions["failures"]>;
  private readonly model: string | null;
  private readonly clock: () => string;
  readonly receivedInputs: PreparationInputV2Type[] = [];

  constructor(options: TestPrepareProviderOptions) {
    this.proposals = options.proposals;
    this.failures = options.failures ?? {};
    this.model = options.model ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async preparePlan(input: PreparationInputV2Type): Promise<{
    proposal: PreparationProposalV2Type;
    lineage: PreparationAttemptLineage;
  }> {
    const startedAt = this.clock();
    this.receivedInputs.push(structuredClone(input));
    const scriptedFailure = this.failures[input.jdSnapshotId];
    if (scriptedFailure !== undefined) {
      throw new ProviderError(
        scriptedFailure.reason,
        scriptedFailure.detail ?? `scripted ${scriptedFailure.reason}`,
        scriptedFailure.spawnCode ?? null,
      );
    }
    const scripted = this.proposals[input.jdSnapshotId];
    if (scripted === undefined) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `test prepare provider has no scripted proposal for jd snapshot '${input.jdSnapshotId}'`,
      );
    }
    const parsed = PreparationProposalV2.safeParse(structuredClone(scripted));
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}`);
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `scripted proposal failed schema validation: ${paths.join(", ")}`,
      );
    }
    const finishedAt = this.clock();
    const stdin = canonicalJson(input);
    return {
      proposal: parsed.data,
      lineage: {
        providerId: this.providerId,
        model: this.model,
        startedAt,
        finishedAt,
        outputBytes: canonicalJson(parsed.data).length,
        inputHash: sha256HexUtf8(stdin),
        proposalHash: sha256HexUtf8(canonicalJson(parsed.data)),
      },
    };
  }
}
