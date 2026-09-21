import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  activeProviderId,
  providerChain,
} from "../../scripts/ai-provider.mjs";

/**
 * Worker-reported provider status (WO-1.2-G). The worker writes this file
 * once at boot so the web process can truthfully compare web-active,
 * saved, and worker-active configuration. It carries provider/model
 * identity and key presence only — never key material — so it is safe to
 * expose through the settings snapshot and excluded from backups by
 * construction (backups only walk evidence/artifacts/sources/candidate).
 */

export const WORKER_STATUS_FILENAME = "worker-status.json";
export const WORKER_STATUS_SCHEMA_VERSION = "worker-status/v1";

export const WorkerStatusV1 = z
  .object({
    schemaVersion: z.literal(WORKER_STATUS_SCHEMA_VERSION),
    workerId: z.string().min(1).max(128),
    startedAt: z.string().datetime({ offset: true }),
    provider: z.enum(["openrouter", "google", "meta"]),
    models: z
      .object({ primary: z.string().min(1).max(256), fallback: z.string().min(1).max(256) })
      .strict(),
    keyConfigured: z.boolean(),
    keyFingerprint: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .nullable(),
    tailorConfigured: z.boolean(),
  })
  .strict();
export type WorkerStatusV1 = z.infer<typeof WorkerStatusV1>;

const PROVIDER_KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  meta: "META_API_KEY",
} as const;

export function workerStatusPath(root: string): string {
  return join(root, WORKER_STATUS_FILENAME);
}

/** Build the status value from the worker's own boot environment. */
export function buildWorkerStatus(input: {
  env: Record<string, string | undefined>;
  workerId: string;
  startedAt: string;
  tailorConfigured: boolean;
}): WorkerStatusV1 {
  const provider = activeProviderId(input.env) as keyof typeof PROVIDER_KEY_ENV;
  const chain = providerChain(provider, input.env) as string[];
  const key = input.env[PROVIDER_KEY_ENV[provider]]?.trim() || "";
  return {
    schemaVersion: WORKER_STATUS_SCHEMA_VERSION,
    workerId: input.workerId,
    startedAt: input.startedAt,
    provider,
    models: { primary: chain[0] as string, fallback: (chain[1] ?? chain[0]) as string },
    keyConfigured: key !== "",
    keyFingerprint:
      key === "" ? null : createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8),
    tailorConfigured: input.tailorConfigured,
  };
}

/** Atomic publish: temp file on the same filesystem, then rename. */
export function writeWorkerStatus(root: string, status: WorkerStatusV1): void {
  const path = workerStatusPath(root);
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(status)}\n`, "utf8");
  renameSync(tmpPath, path);
}

/**
 * Read the last worker-reported status. Returns null when the worker has
 * never reported (not yet started since the G upgrade), the file is
 * unreadable, or the payload fails schema validation — every case means
 * "worker configuration unknown", never a guess.
 */
export function readWorkerStatus(root: string): WorkerStatusV1 | null {
  let raw: string;
  try {
    raw = readFileSync(workerStatusPath(root), "utf8");
  } catch {
    return null;
  }
  try {
    return WorkerStatusV1.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
