import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalJson } from "../domain/canonical";
import { sha256HexUtf8 } from "./hash";
import {
  PROVIDER_ATTEMPT_SCHEMA_VERSION,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  TAILOR_PROMPT_VERSION,
  ProviderError,
  type ProviderAttemptV1,
  type ResumeProposalV1 as ResumeProposal,
  type TailoringInputV1,
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

export class CommandProvider implements TailoringProvider {
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
    input: TailoringInputV1,
  ): Promise<{ proposal: ResumeProposal; attempt: ProviderAttemptV1 }> {
    const startedAt = this.clock();
    const executable = this.argv[0] as string;
    const stdin = canonicalJson(input);
    const stdout = await this.invoke(executable, this.argv.slice(1), stdin);
    const finishedAt = this.clock();
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `provider stdout is not JSON (${stdout.length} bytes)`,
      );
    }
    const parsed = ResumeProposalV1.safeParse(decoded);
    if (!parsed.success) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
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
        promptVersion: TAILOR_PROMPT_VERSION,
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
              "PROVIDER_UNAVAILABLE",
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
      child.on("error", () => {
        fail(new ProviderError("PROVIDER_UNAVAILABLE", `provider spawn failed: '${executable}'`));
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new ProviderError(
              "PROVIDER_UNAVAILABLE",
              `provider exited with status ${String(code)} (${stderrBytes} stderr bytes discarded)`,
            ),
          );
          return;
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (stdout.trim() === "") {
          reject(new ProviderError("PROVIDER_UNAVAILABLE", "provider stdout is empty"));
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
