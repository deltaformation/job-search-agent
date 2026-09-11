import {
  resolveRuntimeConfig,
  type RuntimeConfig,
} from "../security/runtime";

/**
 * Worker process configuration. The worker never migrates or creates
 * storage: the supervisor prepares the data root first, and the worker
 * refuses to start against an unmigrated database with an actionable
 * error. Queue dispatch arrives in R2-B; R1 only proves lifecycle.
 */

export interface WorkerConfig extends RuntimeConfig {
  workerId: string;
}

export function resolveWorkerConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  fallbackPid: number = process.pid,
): WorkerConfig {
  const runtime = resolveRuntimeConfig(env, cwd);
  const workerId = env.WORKER_ID?.trim() || `worker-${fallbackPid}`;
  return { ...runtime, workerId };
}
