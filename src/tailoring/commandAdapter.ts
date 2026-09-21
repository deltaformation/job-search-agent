import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalJson } from "../domain/canonical";
import { sha256HexUtf8 } from "./hash";
import {
  PREPARE_PROMPT_VERSION_V2,
  PROVIDER_ATTEMPT_SCHEMA_VERSION,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  TAILORING_INPUT_SCHEMA_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION_V2,
  TailoringInputAnyVersion,
  PreparationInputV2,
  PreparationProposalV2,
  ProviderError,
  type PreparationAttemptLineage,
  type PreparationInputV2Type,
  type PreparationProposalV2Type,
  type PrepareProvider,
  type ProviderAttemptV1,
  type ResumeProposalV1 as ResumeProposal,
  type TailoringInputV1,
  type TailoringInputV2,
  type TailoringProvider,
} from "./contract";

/**
 * Local command provider adapter: invokes one configured executable with
 * an argv array — never a shell string — feeding the canonical input
 * envelope on stdin and reading the proposal JSON from stdout.
 *
 * Limits are enforced, not advisory: wall-clock timeout kills the child,
 * stdout beyond `maxOutputBytes` kills the child, and stderr is counted
 * and discarded (provider chatter is never persisted, so chain-of-thought
 * cannot leak into attempts, logs, or error details).
 */

export const COMMAND_PROVIDER_ID = "command";
export const COMMAND_CONFIG_VERSION = "command-adapter/v1";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
export const DEFAULT_PROVIDER_MAX_OUTPUT_BYTES = 262_144;
const KILL_GRACE_MS = 5_000;

/**
 * Classified provider exit statuses (see `scripts/tailor-provider.mjs`).
 * stderr stays discarded by design, so the exit status is the only
 * failure signal the adapter trusts — and every code maps onto a
 * structured reason, never prose matching.
 */
export const PROVIDER_EXIT_AUTH = 10;
export const PROVIDER_EXIT_RATE_LIMIT = 11;
export const PROVIDER_EXIT_TIMEOUT = 12;
export const PROVIDER_EXIT_BAD_RESPONSE = 13;
export const PROVIDER_EXIT_NETWORK = 14;

function classifyProviderExit(code: number, stderrBytes: number): ProviderError {
  // Provider-neutral: stderr is discarded by design, so the adapter
  // cannot know which provider the sidecar used. The sidecar's own
  // diagnostics name it; these details name the check, not the vendor.
  if (code === PROVIDER_EXIT_AUTH) {
    return new ProviderError(
      "AUTHENTICATION",
      "AI provider authentication failed (HTTP 401/402): check the active provider key and account credits in Settings → AI & Models",
    );
  }
  if (code === PROVIDER_EXIT_RATE_LIMIT) {
    return new ProviderError(
      "RATE_LIMIT",
      "AI provider rate limit reached (HTTP 429): wait for quota, then retry",
    );
  }
  if (code === PROVIDER_EXIT_TIMEOUT) {
    return new ProviderError(
      "TIMEOUT",
      "AI provider request timed out or the network failed before a proposal arrived",
    );
  }
  if (code === PROVIDER_EXIT_BAD_RESPONSE) {
    return new ProviderError(
      "INVALID_RESPONSE",
      "AI provider returned an unusable response (empty, unparseable, or too few requirements)",
    );
  }
  if (code === PROVIDER_EXIT_NETWORK) {
    return new ProviderError(
      "NETWORK",
      "AI provider network request failed before a proposal arrived: check connectivity and DNS from the worker host, then retry",
    );
  }
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    `provider exited with status ${String(code)} (${stderrBytes} stderr bytes discarded)`,
  );
}

export const CommandProviderConfig = z
  .object({
    argv: z.array(z.string().min(1)).min(1).max(64),
    timeoutMs: z.number().int().min(1).max(600_000).default(DEFAULT_PROVIDER_TIMEOUT_MS),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(DEFAULT_PROVIDER_MAX_OUTPUT_BYTES),
    model: z.string().max(256).nullable().default(null),
    clock: z.custom<() => string>().optional(),
  })
  .strict();
export type CommandProviderConfig = z.infer<typeof CommandProviderConfig>;

function summarizeIssues(proposal: unknown): string {
  const parsed = ResumeProposalV1.safeParse(proposal);
  if (parsed.success) {
    return "";
  }
  // Paths and codes only: provider values never enter error details.
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .slice(0, 12)
    .join(", ");
}

function summarizePreparationIssues(proposal: unknown): string {
  const parsed = PreparationProposalV2.safeParse(proposal);
  if (parsed.success) {
    return "";
  }
  // Paths and codes only: provider values never enter error details.
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .slice(0, 12)
    .join(", ");
}

function summarizePreparationInputIssues(input: unknown): string {
  const parsed = PreparationInputV2.safeParse(input);
  if (parsed.success) {
    return "";
  }
  // Paths and codes only: envelope values never enter error details.
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .slice(0, 12)
    .join(", ");
}

function summarizeInputIssues(input: unknown): string {
  const parsed = TailoringInputAnyVersion.safeParse(input);
  if (parsed.success) {
    return "";
  }
  // Paths and codes only: envelope values never enter error details.
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .slice(0, 12)
    .join(", ");
}

function inputSchemaVersion(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const schemaVersion = (input as Record<string, unknown>)["schemaVersion"];
  return typeof schemaVersion === "string" ? schemaVersion : null;
}

export interface RunCommandJsonInput {
  argv: string[];
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onDiagnostic?: (message: string) => void;
}

/**
 * Generic JSON-over-stdio sidecar invocation for tailoring helpers that
 * need a subprocess but not the proposal protocol (salary facts). Same
 * discipline as the provider path — argv array, never a shell string;
 * wall-clock timeout and stdout cap kill the child; stderr is counted
 * and discarded. Resolves the trimmed stdout on exit 0, else null after
 * one diagnostic line. Never throws, never rejects.
 */
export function runCommandJson(input: RunCommandJsonInput): Promise<string | null> {
  const { argv, stdin, timeoutMs, maxOutputBytes, onDiagnostic } = input;
  const diagnose = onDiagnostic ?? ((): void => {});
  return new Promise<string | null>((resolve) => {
    const [executable, ...args] = argv;
    if (executable === undefined) {
      diagnose("sidecar argv is empty");
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    const timer = setTimeout(() => {
      diagnose(`sidecar exceeded ${timeoutMs}ms`);
      child.kill("SIGTERM");
      done(null);
    }, timeoutMs);
    timer.unref();
    child.on("error", (error: Error) => {
      diagnose(`sidecar spawn failed: ${error.message}`);
      done(null);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        diagnose(`sidecar exceeded ${maxOutputBytes} output bytes`);
        child.kill("SIGTERM");
        done(null);
      } else {
        chunks.push(chunk);
      }
    });
    // Counted and discarded: never persisted, never logged.
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        diagnose(`sidecar exited with status ${String(code)}`);
        done(null);
        return;
      }
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (stdout.trim() === "") {
        diagnose("sidecar stdout is empty");
        done(null);
        return;
      }
      done(stdout);
    });
    child.stdin.on("error", () => {
      // Child exited early; the close handler reports the outcome.
    });
    child.stdin.write(stdin, "utf8");
    child.stdin.end();
  });
}

export class CommandProvider implements TailoringProvider, PrepareProvider {
  readonly providerId = COMMAND_PROVIDER_ID;
  private readonly argv: string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly model: string | null;
  private readonly clock: () => string;

  constructor(rawConfig: z.input<typeof CommandProviderConfig>) {
    const config = CommandProviderConfig.parse(rawConfig);
    this.argv = [...config.argv];
    this.timeoutMs = config.timeoutMs;
    this.maxOutputBytes = config.maxOutputBytes;
    this.model = config.model;
    this.clock = config.clock ?? (() => new Date().toISOString());
  }

  argvHash(): string {
    return sha256HexUtf8(canonicalJson(this.argv));
  }

  async prepare(
    input: TailoringInputV1 | TailoringInputV2,
  ): Promise<{ proposal: ResumeProposal; attempt: ProviderAttemptV1 }> {
    const acceptedInput = TailoringInputAnyVersion.safeParse(input);
    if (!acceptedInput.success) {
      const schemaVersion = inputSchemaVersion(input);
      if (
        schemaVersion !== TAILORING_INPUT_SCHEMA_VERSION &&
        schemaVersion !== TAILORING_INPUT_SCHEMA_VERSION_V2
      ) {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "unsupported tailoring input version: expected tailoring-input/v1 or tailoring-input/v2",
        );
      }
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `tailoring input failed schema validation: ${summarizeInputIssues(input)}`,
      );
    }
    const startedAt = this.clock();
    const executable = this.argv[0] as string;
    const stdin = canonicalJson(acceptedInput.data);
    const stdout = await this.invoke(executable, this.argv.slice(1), stdin);
    const finishedAt = this.clock();
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout) as unknown;
    } catch {
      throw new ProviderError(
        "INVALID_RESPONSE",
        `provider stdout is not JSON (${stdout.length} bytes)`,
      );
    }
    const parsed = ResumeProposalV1.safeParse(decoded);
    if (!parsed.success) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        `provider proposal failed schema validation: ${summarizeIssues(decoded)}`,
      );
    }
    const proposalHash = sha256HexUtf8(canonicalJson(parsed.data));
    return {
      proposal: parsed.data,
      attempt: {
        schemaVersion: PROVIDER_ATTEMPT_SCHEMA_VERSION,
        providerId: this.providerId,
        model: this.model,
        executable,
        argvHash: this.argvHash(),
        configVersion: COMMAND_CONFIG_VERSION,
        promptVersion: acceptedInput.data.promptVersion,
        proposalSchemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
        startedAt,
        finishedAt,
        exitCode: 0,
        timedOut: false,
        outputBytes: stdout.length,
        inputHash: sha256HexUtf8(stdin),
        proposalHash,
        questions: parsed.data.questions,
      },
    };
  }

  /**
   * Step 2 preparation call (WO-1.3-S2-B, S2-A §9): same
   * JSON-over-stdio discipline and exit taxonomy as `prepare`, with
   * the preparation envelope in and a validated proposal out. The
   * instance's argv must point at the prepare sidecar
   * (`scripts/prepare-provider.mjs`); output/timeout bounds come
   * from the same config (S2-A §6.4 passes tighter values).
   */
  async preparePlan(input: PreparationInputV2Type): Promise<{
    proposal: PreparationProposalV2Type;
    lineage: PreparationAttemptLineage;
  }> {
    const acceptedInput = PreparationInputV2.safeParse(input);
    if (!acceptedInput.success) {
      const schemaVersion = inputSchemaVersion(input);
      if (schemaVersion !== "preparation-input/v2") {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "unsupported preparation input version: expected preparation-input/v2",
        );
      }
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `preparation input failed schema validation: ${summarizePreparationInputIssues(input)}`,
      );
    }
    if (acceptedInput.data.promptVersion !== PREPARE_PROMPT_VERSION_V2) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "preparation prompt version does not match the input version",
      );
    }
    const startedAt = this.clock();
    const stdin = canonicalJson(acceptedInput.data);
    const stdout = await this.invoke(
      this.argv[0] as string,
      this.argv.slice(1),
      stdin,
    );
    const finishedAt = this.clock();
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout) as unknown;
    } catch {
      throw new ProviderError(
        "INVALID_RESPONSE",
        `provider stdout is not JSON (${stdout.length} bytes)`,
      );
    }
    const parsed = PreparationProposalV2.safeParse(decoded);
    if (!parsed.success) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        `provider proposal failed schema validation: ${summarizePreparationIssues(decoded)}`,
      );
    }
    return {
      proposal: parsed.data,
      lineage: {
        providerId: this.providerId,
        model: this.model,
        startedAt,
        finishedAt,
        outputBytes: stdout.length,
        inputHash: sha256HexUtf8(stdin),
        proposalHash: sha256HexUtf8(canonicalJson(parsed.data)),
      },
    };
  }

  private invoke(executable: string, args: string[], stdin: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const fail = (error: ProviderError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        const force = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, KILL_GRACE_MS);
        force.unref();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new ProviderError("TIMEOUT", `provider exceeded ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes) {
          fail(
            new ProviderError(
              "INVALID_RESPONSE",
              `provider exceeded ${this.maxOutputBytes} output bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      // Counted and discarded: never persisted, never logged.
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Local launch failure (e.g. ENOENT for a missing `node` on PATH):
        // distinct from any provider API outcome. A passing web
        // connection test cannot prove this path — the worker launches
        // its own provider command. The raw spawn errno travels on
        // spawnCode so diagnostics show a verified subcode, never prose.
        const spawnCode =
          typeof error?.code === "string" && error.code !== "" ? error.code : null;
        const reason = spawnCode ?? error?.message ?? "spawn failed";
        fail(
          new ProviderError(
            "LOCAL_LAUNCH",
            `provider spawn failed: '${executable}' could not start (${reason}); check TAILOR_PROVIDER_ARGV and that the executable exists where the worker runs — a passing web connection test does not verify this worker launch path`,
            spawnCode,
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(classifyProviderExit(code ?? 1, stderrBytes));
          return;
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (stdout.trim() === "") {
          reject(new ProviderError("INVALID_RESPONSE", "provider stdout is empty"));
          return;
        }
        resolve(stdout);
      });
      child.stdin.on("error", () => {
        // Child exited early; the close handler reports the outcome.
      });
      child.stdin.write(stdin, "utf8");
      child.stdin.end();
    });
  }
}
