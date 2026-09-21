import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import {
  CANDIDATE_IMPORT_SCHEMA_VERSION_V2,
  normalizeImportDocument,
  parseStoredProfilePayload,
  type CandidateProfilePayloadV2,
  type WorkPreferencesV1,
} from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import type { SourceOrigin } from "../domain/enums";
import { newId } from "../db/utils";
import { sha256HexUtf8 } from "../tailoring/hash";
import type { DataRootPaths } from "../security/data-root";
import {
  ensureLocalProfile,
  getActiveProfileVersion,
  getDefaultProfile,
  getProfile,
  getSourceByVersion,
  insertSource,
  listProfileVersions,
  listProfiles,
} from "../db/candidates";
import { withTransaction } from "../db/transactions";
import { activateProfileVersion, importCandidate, isUniqueViolation } from "./candidates";
import { publishSourceBytes, readSourceBytes, SOURCE_MEDIA_TYPE } from "./sources";
import {
  activeProviderId as activeProviderIdFromEnv,
  providerChain,
  providerChat,
  providerLabel,
} from "../../scripts/ai-provider.mjs";
import { readWorkerStatus, type WorkerStatusV1 } from "../worker/status";

/**
 * Settings & Data Management service (R5-A): snapshot/read models for the
 * Settings modal, AI provider + model switching (via `.env.local`
 * upsert), connection pings, master-resume re-sync, and storage stats.
 * Board reset lives in `src/server/backup.ts` beside the safety backup
 * it requires.
 */

export const AI_PROVIDER_IDS = ["openrouter", "google", "meta"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

const AiProviderIdSchema = z.enum(AI_PROVIDER_IDS);

const PROVIDER_KEY_ENV: Record<AiProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  meta: "META_API_KEY",
};

/** Validated `ACTIVE_AI_PROVIDER` (default: openrouter). */
export function activeProviderId(env: Record<string, string | undefined>): AiProviderId {
  return activeProviderIdFromEnv(env) as AiProviderId;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Candidate profile source dir; `CANDIDATE_DIR` overrides for tests. */
export function resolveCandidateDir(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string {
  const override = env.CANDIDATE_DIR?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(cwd, "data", "candidate");
}

export function masterResumePath(candidateDir: string): string {
  return join(candidateDir, "master-resume.json");
}

/** Env file backing the model switcher; `SETTINGS_ENV_FILE` overrides for tests. */
export function resolveEnvFilePath(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string {
  const override = env.SETTINGS_ENV_FILE?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(cwd, ".env.local");
}

export interface ProviderSnapshot {
  configured: boolean;
  fingerprint: string | null;
  models: { primary: string; fallback: string };
}

export interface SavedProviderConfig {
  /** False when `.env.local` is missing: nothing has been saved yet. */
  exists: boolean;
  /** Provider the file selects (what the next restart will boot). */
  provider: AiProviderId;
  providers: Record<AiProviderId, ProviderSnapshot>;
}

export interface SettingsSnapshot {
  models: { primary: string; fallback: string };
  activeProvider: AiProviderId;
  providers: Record<AiProviderId, ProviderSnapshot>;
  /** Saved file state (WO-1.2-G): the draft baseline across refresh/reopen. */
  saved: SavedProviderConfig;
  /** Convenience alias for `saved.provider`. */
  savedProvider: AiProviderId;
  /**
   * True while the saved file differs from the running web process (or
   * from the last worker report). Clears only when the configurations
   * agree — never merely because a save succeeded.
   */
  restartNeeded: boolean;
  /** Human-readable gap list when `restartNeeded`, else null. */
  restartDetail: string | null;
  /**
   * Last worker-reported configuration, or null when the worker has not
   * reported yet (not started since the G upgrade, or status unreadable).
   */
  worker: WorkerStatusV1 | null;
  /** Whether the worker report agrees with the web-active config. */
  workerMatch: boolean | null;
  openRouter: { configured: boolean; fingerprint: string | null };
  profile: {
    activeVersion: number;
    activeVersionAt: string;
    displayName: string | null;
    approvedFacts: number;
    verifiedSkills: number;
  } | null;
  storage: {
    databaseBytes: number;
    walBytes: number;
    jobCount: number;
    evidenceBytes: number;
    evidenceFiles: number;
    artifactBytes: number;
    artifactFiles: number;
    backupCount: number;
    backupsBytes: number;
  };
}

function directoryUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (stat.isFile()) {
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

function buildProviderSnapshots(
  env: Record<string, string | undefined>,
): Record<AiProviderId, ProviderSnapshot> {
  return Object.fromEntries(
    AI_PROVIDER_IDS.map((provider) => {
      const chain = providerChain(provider, env) as string[];
      const key = env[PROVIDER_KEY_ENV[provider]]?.trim() || "";
      return [
        provider,
        {
          configured: key !== "",
          fingerprint: key === "" ? null : keyFingerprint(key),
          models: { primary: chain[0] as string, fallback: (chain[1] ?? chain[0]) as string },
        } satisfies ProviderSnapshot,
      ];
    }),
  ) as Record<AiProviderId, ProviderSnapshot>;
}

/** Env keys the settings writer owns; everything else is preserved opaque. */
const MANAGED_ENV_KEYS = new Set([
  "ACTIVE_AI_PROVIDER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
  "META_API_KEY",
  "META_MODEL",
  "META_FALLBACK_MODEL",
]);

function parseKnownEnvLines(content: string): Record<string, string | undefined> {
  const fileEnv: Record<string, string | undefined> = {};
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && MANAGED_ENV_KEYS.has(match[1])) {
      fileEnv[match[1]] = match[2]?.trim() || undefined;
    }
  }
  return fileEnv;
}

/**
 * Read the saved provider configuration from the env file. Key values are
 * fingerprinted server-side; the returned structure carries presence and
 * fingerprints only, exactly like the active snapshot.
 */
export function readSavedProviderConfig(envFilePath: string): SavedProviderConfig {
  let content: string | null = null;
  try {
    content = readFileSync(envFilePath, "utf8");
  } catch {
    content = null;
  }
  const fileEnv = content === null ? {} : parseKnownEnvLines(content);
  return {
    exists: content !== null,
    provider: activeProviderId(fileEnv),
    providers: buildProviderSnapshots(fileEnv),
  };
}

/** Compare saved file state against the running web config + worker report. */
function describeRestartGap(input: {
  saved: SavedProviderConfig;
  activeProvider: AiProviderId;
  active: Record<AiProviderId, ProviderSnapshot>;
  worker: WorkerStatusV1 | null;
}): string[] {
  const gaps: string[] = [];
  if (input.saved.provider !== input.activeProvider) {
    gaps.push(
      `saved provider is ${providerLabel(input.saved.provider)} but the web process is running ${providerLabel(input.activeProvider)}`,
    );
  }
  for (const provider of AI_PROVIDER_IDS) {
    const saved = input.saved.providers[provider];
    const active = input.active[provider];
    if (saved.models.primary !== active.models.primary) {
      gaps.push(
        `${providerLabel(provider)} primary is saved as '${saved.models.primary}' but running as '${active.models.primary}'`,
      );
    }
    if (saved.models.fallback !== active.models.fallback) {
      gaps.push(
        `${providerLabel(provider)} fallback is saved as '${saved.models.fallback}' but running as '${active.models.fallback}'`,
      );
    }
    if (saved.configured !== active.configured) {
      gaps.push(
        saved.configured
          ? `${providerLabel(provider)} key is saved but not loaded in the running process`
          : `${providerLabel(provider)} key was removed from the file but is still loaded in the running process`,
      );
    } else if (
      saved.configured &&
      active.configured &&
      saved.fingerprint !== active.fingerprint
    ) {
      gaps.push(`${providerLabel(provider)} key was replaced; the running process still holds the previous key`);
    }
  }
  const worker = input.worker;
  if (worker !== null) {
    const savedActive = input.saved.providers[worker.provider];
    if (worker.provider !== input.saved.provider) {
      gaps.push(
        `the worker last reported ${providerLabel(worker.provider)} but the file saves ${providerLabel(input.saved.provider)}`,
      );
    } else {
      if (worker.models.primary !== savedActive.models.primary) {
        gaps.push(
          `the worker last reported ${providerLabel(worker.provider)} primary '${worker.models.primary}' but the file saves '${savedActive.models.primary}'`,
        );
      }
      if (worker.models.fallback !== savedActive.models.fallback) {
        gaps.push(
          `the worker last reported ${providerLabel(worker.provider)} fallback '${worker.models.fallback}' but the file saves '${savedActive.models.fallback}'`,
        );
      }
      if (worker.keyConfigured !== savedActive.configured) {
        gaps.push(
          worker.keyConfigured
            ? `the worker holds a ${providerLabel(worker.provider)} key that the file no longer saves`
            : `the worker is missing the saved ${providerLabel(worker.provider)} key`,
        );
      }
    }
  }
  return gaps;
}

export function getSettingsSnapshot(
  handle: DatabaseHandle,
  input: {
    paths: DataRootPaths;
    env?: Record<string, string | undefined>;
    envFilePath?: string;
  },
): SettingsSnapshot {
  const env = input.env ?? process.env;
  const activeProvider = activeProviderId(env);
  const providers = buildProviderSnapshots(env);
  const saved = readSavedProviderConfig(input.envFilePath ?? resolveEnvFilePath(env));
  const worker = readWorkerStatus(input.paths.root);
  const workerMatch =
    worker === null
      ? null
      : worker.provider === activeProvider &&
        worker.models.primary === providers[activeProvider].models.primary &&
        worker.models.fallback === providers[activeProvider].models.fallback &&
        worker.keyConfigured === providers[activeProvider].configured;
  const gaps = describeRestartGap({ saved, activeProvider, active: providers, worker });
  const active = getActiveProfileVersion(handle);
  let profile: SettingsSnapshot["profile"] = null;
  if (active !== null) {
    let displayName: string | null = null;
    let verifiedSkills = 0;
    try {
      const payload = parseStoredProfilePayload(JSON.parse(active.payloadJson) as unknown);
      displayName =
        typeof payload.identity.fullName === "string" ? payload.identity.fullName : null;
      verifiedSkills = Array.isArray(payload.skills)
        ? payload.skills.filter((skill) => skill.verified === true).length
        : 0;
    } catch {
      displayName = null;
      verifiedSkills = 0;
    }
    const approvedFacts = (
      handle.sqlite
        .prepare("SELECT COUNT(*) AS count FROM candidate_facts WHERE verification = 'APPROVED'")
        .get() as { count: number }
    ).count;
    profile = {
      activeVersion: active.version,
      activeVersionAt: active.createdAt,
      displayName,
      approvedFacts,
      verifiedSkills,
    };
  }
  const jobCount = (
    handle.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
  ).count;
  const evidence = directoryUsage(input.paths.evidenceDir);
  const artifacts = directoryUsage(input.paths.artifactsDir);
  const backups = directoryUsage(join(input.paths.root, "backups"));
  return {
    models: providers[activeProvider].models,
    activeProvider,
    providers,
    saved,
    savedProvider: saved.provider,
    restartNeeded: gaps.length > 0,
    restartDetail: gaps.length === 0 ? null : gaps.join("; "),
    worker,
    workerMatch,
    openRouter: {
      configured: providers.openrouter.configured,
      fingerprint: providers.openrouter.fingerprint,
    },
    profile,
    storage: {
      databaseBytes: fileBytes(input.paths.databasePath),
      walBytes:
        fileBytes(`${input.paths.databasePath}-wal`) +
        fileBytes(`${input.paths.databasePath}-shm`),
      jobCount,
      evidenceBytes: evidence.bytes,
      evidenceFiles: evidence.files,
      artifactBytes: artifacts.bytes,
      artifactFiles: artifacts.files,
      backupCount: backups.files,
      backupsBytes: backups.bytes,
    },
  };
}

const ModelId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:/-]+$/, "model id uses letters, digits, and . _ : / - only");

export const ModelSwitchInput = z
  .object({
    provider: AiProviderIdSchema.optional(),
    primary: ModelId.optional(),
    fallback: ModelId.optional(),
    clearFallback: z.boolean().optional(),
    googleModel: ModelId.optional(),
    googleFallbackModel: ModelId.optional(),
    clearGoogleFallback: z.boolean().optional(),
    metaModel: ModelId.optional(),
    metaFallbackModel: ModelId.optional(),
    clearMetaFallback: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.provider !== undefined ||
      input.primary !== undefined ||
      input.fallback !== undefined ||
      input.clearFallback === true ||
      input.googleModel !== undefined ||
      input.googleFallbackModel !== undefined ||
      input.clearGoogleFallback === true ||
      input.metaModel !== undefined ||
      input.metaFallbackModel !== undefined ||
      input.clearMetaFallback === true,
    { message: "nothing to switch" },
  );
export type ModelSwitchInput = z.infer<typeof ModelSwitchInput>;

function upsertEnvLine(content: string, key: string, value: string | null): string {
  const lines = content === "" ? [] : content.split("\n");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return value === null ? `# ${key} removed by Settings` : `${key}=${value}`;
    }
    return line;
  });
  if (!replaced && value !== null) {
    if (next.length > 0 && (next[next.length - 1] as string) !== "") {
      next.push("");
    }
    next.push(`${key}=${value}`);
  }
  return next.join("\n");
}

/**
 * Atomic env-file write: temp file with owner-only permissions on the
 * same filesystem, then rename. The final file is chmodded 0600 because
 * it may hold API keys. Synchronous read-modify-write cannot interleave
 * within this process (no awaits); only the web process writes this
 * file, so no cross-process lock is taken — concurrent operators must
 * save serially and the last write wins visibly on the next refresh.
 */
function writeEnvFileAtomic(envFilePath: string, content: string): void {
  mkdirSync(dirname(envFilePath), { recursive: true });
  const text = content.endsWith("\n") || content === "" ? content : `${content}\n`;
  const tmpPath = `${envFilePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, envFilePath);
  try {
    chmodSync(envFilePath, 0o600);
  } catch {
    // Best-effort: odd filesystems (FAT, some mounts) have no chmod.
  }
}

function readEnvFileOrEmpty(envFilePath: string): string {
  try {
    return readFileSync(envFilePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SettingsError(`cannot read env file: ${(error as Error).message}`);
    }
    return "";
  }
}

/**
 * Switch the active AI provider and/or any provider's model chain by
 * upserting `.env.local` (comments and unrelated keys preserved).
 * Applies on app restart: the worker and routes read process env at
 * boot. Never writes API keys (see `saveProviderKey`).
 */
export function switchModels(
  envFilePath: string,
  rawInput: unknown,
): {
  primary: string;
  fallback: string;
  activeProvider: AiProviderId;
  savedProvider: AiProviderId;
  restartRequired: true;
} {
  const input = ModelSwitchInput.parse(rawInput);
  let content = readEnvFileOrEmpty(envFilePath);
  if (input.provider !== undefined) {
    content = upsertEnvLine(content, "ACTIVE_AI_PROVIDER", input.provider);
  }
  if (input.primary !== undefined) {
    content = upsertEnvLine(content, "OPENROUTER_MODEL", input.primary);
  }
  if (input.clearFallback === true) {
    content = upsertEnvLine(content, "OPENROUTER_FALLBACK_MODEL", null);
  } else if (input.fallback !== undefined) {
    content = upsertEnvLine(content, "OPENROUTER_FALLBACK_MODEL", input.fallback);
  }
  if (input.googleModel !== undefined) {
    content = upsertEnvLine(content, "GEMINI_MODEL", input.googleModel);
  }
  if (input.clearGoogleFallback === true) {
    content = upsertEnvLine(content, "GEMINI_FALLBACK_MODEL", null);
  } else if (input.googleFallbackModel !== undefined) {
    content = upsertEnvLine(content, "GEMINI_FALLBACK_MODEL", input.googleFallbackModel);
  }
  if (input.metaModel !== undefined) {
    content = upsertEnvLine(content, "META_MODEL", input.metaModel);
  }
  if (input.clearMetaFallback === true) {
    content = upsertEnvLine(content, "META_FALLBACK_MODEL", null);
  } else if (input.metaFallbackModel !== undefined) {
    content = upsertEnvLine(content, "META_FALLBACK_MODEL", input.metaFallbackModel);
  }
  try {
    writeEnvFileAtomic(envFilePath, content);
  } catch (error: unknown) {
    throw new SettingsError(`cannot write env file: ${(error as Error).message}`);
  }
  // Response shows the file's saved chain (what a fresh boot reads); a
  // real shell-exported variable still wins at runtime, matching
  // Next/script precedence, and is visible in the snapshot after restart.
  // `activeProvider` here is the SAVED provider (kept for backwards
  // compatibility); prefer `savedProvider`.
  const fileEnv = parseKnownEnvLines(content);
  const savedProvider = activeProviderId(fileEnv);
  const chain = providerChain(savedProvider, fileEnv) as string[];
  return {
    primary: chain[0] as string,
    fallback: (chain[1] ?? chain[0]) as string,
    activeProvider: savedProvider,
    savedProvider,
    restartRequired: true,
  };
}

export const ProviderKeysInput = z
  .object({
    provider: AiProviderIdSchema,
    /** New key value; blank/omitted retains the stored key (no-op). */
    key: z.string().max(4096).optional(),
    /** Explicit removal; never combined with `key`. */
    remove: z.boolean().optional(),
  })
  .strict()
  .refine((input) => !(input.key !== undefined && input.remove === true), {
    message: "cannot set and remove a key in one request",
  });
export type ProviderKeysInput = z.infer<typeof ProviderKeysInput>;

export interface ProviderKeyResult {
  provider: AiProviderId;
  configured: boolean;
  fingerprint: string | null;
  changed: boolean;
  message: string;
}

/**
 * Masked write-only API key add/replace/remove (WO-1.2-G). Writes only
 * `.env.local` — secrets never reach SQLite, logs, responses, or
 * backups. Blank retains the stored key; removal is explicit. Returns
 * presence and fingerprint only, never the key.
 */
export function saveProviderKey(envFilePath: string, rawInput: unknown): ProviderKeyResult {
  const input = ProviderKeysInput.parse(rawInput);
  const keyName = PROVIDER_KEY_ENV[input.provider];
  const label = providerLabel(input.provider) as string;
  const content = readEnvFileOrEmpty(envFilePath);
  if (input.remove === true) {
    const next = upsertEnvLine(content, keyName, null);
    if (next === content) {
      return {
        provider: input.provider,
        configured: false,
        fingerprint: null,
        changed: false,
        message: `No stored ${label} key — nothing to remove.`,
      };
    }
    try {
      writeEnvFileAtomic(envFilePath, next);
    } catch (error: unknown) {
      throw new SettingsError(`cannot write env file: ${(error as Error).message}`);
    }
    return {
      provider: input.provider,
      configured: false,
      fingerprint: null,
      changed: true,
      message: `${label} key removed. Restart the app to apply.`,
    };
  }
  const value = input.key?.trim() ?? "";
  if (value === "") {
    const current = readSavedProviderConfig(envFilePath).providers[input.provider];
    return {
      provider: input.provider,
      configured: current.configured,
      fingerprint: current.fingerprint,
      changed: false,
      message: "Blank key field — stored key retained.",
    };
  }
  if (/[\r\n\0]/.test(value)) {
    throw new SettingsError("API key must not contain line breaks");
  }
  try {
    writeEnvFileAtomic(envFilePath, upsertEnvLine(content, keyName, value));
  } catch (error: unknown) {
    throw new SettingsError(`cannot write env file: ${(error as Error).message}`);
  }
  return {
    provider: input.provider,
    configured: true,
    fingerprint: keyFingerprint(value),
    changed: true,
    message: `${label} key saved. Restart the app to apply.`,
  };
}

export type AiTestReasonCode =
  | "ok"
  | "missing-key"
  | "auth"
  | "rate-limit"
  | "timeout"
  | "server"
  | "invalid-request"
  | "bad-response"
  | "unknown";

export interface AiTestModelResult {
  ok: boolean;
  /** Requested model on failure, serving model on success. */
  model: string;
  latencyMs: number;
  error: string | null;
  reasonCode: AiTestReasonCode;
  /** Actionable next step; null when the ping passed. */
  action: string | null;
}

export interface AiTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  error: string | null;
  provider: AiProviderId;
  /** Exact primary model that was pinged (the entered draft or the default). */
  testedModel: string;
  /** Where the tested key came from; transient keys are never saved. */
  keySource: "stored" | "transient";
  reasonCode: AiTestReasonCode;
  /** Actionable next step for the primary result; null when ok. */
  action: string | null;
  /** Independent fallback-model ping, or null when none was requested. */
  fallback: AiTestModelResult | null;
}

export const AiTestInput = z
  .object({
    provider: AiProviderIdSchema.optional(),
    /** Draft primary model to test (default: the provider's active primary). */
    model: ModelId.optional(),
    /** Optional draft fallback model to test independently. */
    fallbackModel: ModelId.optional(),
    /**
     * Transient key draft: tested without saving. Blank/omitted reuses
     * the stored key from the running process environment.
     */
    apiKey: z.string().max(4096).optional(),
  })
  .strict();
export type AiTestInput = z.infer<typeof AiTestInput>;

/** Defensive scrub: a key value must never appear in a returned message. */
function scrubKey(text: string, key: string): string {
  if (key === "" || !text.includes(key)) {
    return text;
  }
  return text.split(key).join("[REDACTED]");
}

/**
 * Classify a provider-client failure into an actionable, secret-free
 * outcome. Every client throws `{ kind, status, message }`; anything
 * else is reported honestly as unknown. A 5xx (including the reported
 * 502) is a service-side error: the draft and active configuration are
 * unchanged, and no credential/model verdict is implied.
 */
function classifyTestError(
  error: unknown,
  input: { label: string; model: string; key: string },
): { reasonCode: AiTestReasonCode; error: string; action: string } {
  const shape = error as { kind?: unknown; status?: unknown; message?: unknown };
  const kind = typeof shape?.kind === "string" ? shape.kind : null;
  const status = typeof shape?.status === "number" ? shape.status : null;
  if (kind === "status" && status !== null) {
    if (status === 401 || status === 402 || status === 403) {
      return {
        reasonCode: "auth",
        error: `${input.label} rejected the API key (HTTP ${status}).`,
        action: "Check the key value and account credits, then test again.",
      };
    }
    if (status === 429) {
      return {
        reasonCode: "rate-limit",
        error: `${input.label} rate limit reached (HTTP 429).`,
        action: "Wait for quota to recover, then retry the test.",
      };
    }
    if (status === 408) {
      return {
        reasonCode: "timeout",
        error: `${input.label} timed out (HTTP 408).`,
        action: "Retry the test; if timeouts persist, check network connectivity.",
      };
    }
    if (status === 400) {
      return {
        reasonCode: "invalid-request",
        error: `${input.label} rejected the request (HTTP 400) for model '${input.model}'.`,
        action: `Verify the model id is valid for ${input.label}, then test again.`,
      };
    }
    if (status === 404) {
      const detail =
        typeof shape?.message === "string" && shape.message.includes(":")
          ? scrubKey(shape.message.split(":").slice(1).join(":").trim(), input.key)
          : "";
      return {
        reasonCode: "invalid-request",
        error:
          detail !== ""
            ? `${input.label} model '${input.model}' error: ${detail}`
            : `${input.label} rejected the request (HTTP 404): model '${input.model}' was not found.`,
        action: `Verify the model id is valid for ${input.label}, then test again.`,
      };
    }
    if (status >= 500) {
      return {
        reasonCode: "server",
        error: `${input.label} returned HTTP ${status}: a service-side error. The tested draft and the active configuration are unchanged.`,
        action: "Retry the test shortly, or check the provider status page.",
      };
    }
    return {
      reasonCode: "invalid-request",
      error: `${input.label} returned HTTP ${status}.`,
      action: "Verify the model id and key, then test again.",
    };
  }
  if (kind === "timeout") {
    return {
      reasonCode: "timeout",
      error: `${input.label} test timed out.`,
      action: "Check network connectivity and retry the test.",
    };
  }
  if (kind === "network") {
    return {
      reasonCode: "timeout",
      error: `${input.label} test could not reach the service.`,
      action: "Check network connectivity and retry the test.",
    };
  }
  if (kind === "bad-response") {
    return {
      reasonCode: "bad-response",
      error: `${input.label} returned an unusable response for model '${input.model}'.`,
      action: "Retry the test; if it persists, try another model.",
    };
  }
  const detail = scrubKey(
    typeof shape?.message === "string" && shape.message !== "" ? shape.message : "unknown failure",
    input.key,
  );
  return {
    reasonCode: "unknown",
    error: `${input.label} test failed: ${detail.slice(0, 300)}`,
    action: "Retry the test.",
  };
}

async function pingOneModel(input: {
  provider: AiProviderId;
  label: string;
  model: string;
  key: string;
  timeoutMs: number;
}): Promise<AiTestModelResult> {
  const started = Date.now();
  try {
    const completion = (await providerChat(input.provider, {
      apiKey: input.key,
      models: [input.model],
      messages: [{ role: "user", content: 'Reply with exactly: {"ping":"ok"}' }],
      timeoutMs: input.timeoutMs,
    })) as { model: string; content: string };
    const parsed = JSON.parse(completion.content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["ping"] !== "ok"
    ) {
      return {
        ok: false,
        model: completion.model,
        latencyMs: Date.now() - started,
        error: "The model did not return the expected ping payload.",
        reasonCode: "bad-response",
        action: "Retry the test; if it persists, try another model.",
      };
    }
    return {
      ok: true,
      model: completion.model,
      latencyMs: Date.now() - started,
      error: null,
      reasonCode: "ok",
      action: null,
    };
  } catch (error: unknown) {
    const classified = classifyTestError(error, {
      label: input.label,
      model: input.model,
      key: input.key,
    });
    return {
      ok: false,
      model: input.model,
      latencyMs: Date.now() - started,
      error: classified.error,
      reasonCode: classified.reasonCode,
      action: classified.action,
    };
  }
}

async function runDraftTest(
  input: AiTestInput,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<AiTestResult> {
  const provider = input.provider ?? activeProviderId(env);
  const label = providerLabel(provider) as string;
  const transient = input.apiKey?.trim() || "";
  const stored = env[PROVIDER_KEY_ENV[provider]]?.trim() || "";
  const key = transient !== "" ? transient : stored;
  const keySource = transient !== "" ? "transient" : "stored";
  const chain = providerChain(provider, env) as string[];
  const primary = input.model ?? (chain[0] as string);
  const fallbackModel =
    input.fallbackModel !== undefined && input.fallbackModel !== primary
      ? input.fallbackModel
      : null;
  if (key === "") {
    const keyName = PROVIDER_KEY_ENV[provider];
    return {
      ok: false,
      model: null,
      latencyMs: 0,
      error: `${keyName} is not configured. Enter a key to test, or save one first — the draft model was not pinged.`,
      provider,
      testedModel: primary,
      keySource: "stored",
      reasonCode: "missing-key",
      action: `Enter ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} key in the test field, or save one under Settings → AI & Models.`,
      fallback: null,
    };
  }
  const first = await pingOneModel({ provider, label, model: primary, key, timeoutMs });
  const second =
    fallbackModel === null
      ? null
      : await pingOneModel({ provider, label, model: fallbackModel, key, timeoutMs });
  return {
    ok: first.ok && (second === null || second.ok),
    model: first.model,
    latencyMs: first.latencyMs,
    error: first.error,
    provider,
    testedModel: primary,
    keySource,
    reasonCode: first.reasonCode,
    action: first.action,
    fallback: second,
  };
}

/**
 * Test the exact entered provider/model/transient-key draft without
 * saving anything. A blank key draft explicitly reuses the stored key
 * from the running process. Unknown providers throw `SettingsError`
 * (route maps to 400); provider outcomes are returned, never thrown.
 */
export async function testProviderDraft(
  rawInput: unknown,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<AiTestResult> {
  return runDraftTest(AiTestInput.parse(rawInput), env, timeoutMs);
}

/**
 * Lightweight provider ping: one tiny JSON prompt on the provider's
 * active primary model with the stored key. Unknown providers throw
 * `SettingsError` (route maps to 400).
 */
export async function pingProvider(
  provider: AiProviderId,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<AiTestResult> {
  if (!AI_PROVIDER_IDS.includes(provider)) {
    throw new SettingsError(`unknown AI provider: ${String(provider)}`);
  }
  return runDraftTest({ provider }, env, timeoutMs);
}

/** Backwards-compatible OpenRouter ping. */
export async function pingOpenRouter(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<AiTestResult> {
  return pingProvider("openrouter", env, timeoutMs);
}

/**
 * One career profile with its version ledger position for the Settings
 * UI. `approvedFacts` counts the achievements (approved by construction)
 * in the profile's latest version payload, or 0 when it has no versions
 * or the payload no longer parses.
 */
export interface ActiveSourceSummary {
  origin: string;
  byteSize: number;
  sha256: string;
  recordedAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  workPreferences: WorkPreferencesV1 | null;
  executiveNarrative: string | null;
  versionCount: number;
  latestVersion: number | null;
  latestVersionAt: string | null;
  activeVersion: number | null;
  approvedFacts: number;
  /** Recorded source for the active version; null when none is recorded. */
  activeSource: ActiveSourceSummary | null;
}

export function listProfileSummaries(handle: DatabaseHandle): ProfileSummary[] {
  const profiles = listProfiles(handle);
  return profiles.map((profile) => {
    const versions = listProfileVersions(handle, profile.id);
    const latest = versions.length === 0 ? null : versions[versions.length - 1];
    const active = getActiveProfileVersion(handle, profile.id);
    let approvedFacts = 0;
    if (latest !== null && latest !== undefined) {
      try {
        const payload = parseStoredProfilePayload(JSON.parse(latest.payloadJson) as unknown);
        approvedFacts = payload.achievements.length;
      } catch {
        approvedFacts = 0;
      }
    }
    const sourceRow = active === null ? null : getSourceByVersion(handle, active.id);
    return {
      id: profile.id,
      name: profile.name,
      displayName: profile.displayName,
      isDefault: profile.isDefault,
      workPreferences: profile.workPreferences,
      executiveNarrative: profile.executiveNarrative,
      versionCount: versions.length,
      latestVersion: latest?.version ?? null,
      latestVersionAt: latest?.createdAt ?? null,
      activeVersion: active?.version ?? null,
      approvedFacts,
      activeSource:
        sourceRow === null
          ? null
          : {
              origin: sourceRow.origin,
              byteSize: sourceRow.byteSize,
              sha256: sourceRow.sha256,
              recordedAt: sourceRow.createdAt,
            },
    };
  });
}

export type ResyncResult =
  | {
      ok: true;
      versionId: string;
      version: number;
      activated: boolean;
      alreadyCurrent: boolean;
      insertedFacts: string[];
      reusedFacts: string[];
      remappedFacts: Array<{ from: string; to: string }>;
    }
  | { ok: false; error: string; detail?: string };

export type ParsedMasterResume =
  | {
      ok: true;
      payload: CandidateProfilePayloadV2;
      payloadHash: string;
      editedFrom: Map<string, string>;
      importVersion: 1 | 2 | "unstamped";
    }
  | { ok: false; error: "master-resume-invalid"; detail: string };

/**
 * Validate one master-resume document against the profile payload schema
 * and return its canonical hash. Shared by file re-sync and JSON upload
 * so both accept exactly the same documents.
 */
export function parseMasterResumeDocument(document: unknown): ParsedMasterResume {
  try {
    const normalized = normalizeImportDocument(document);
    return {
      ok: true,
      payload: normalized.payload,
      payloadHash: sha256HexUtf8(canonicalJson(normalized.payload)),
      editedFrom: normalized.editedFrom,
      importVersion: normalized.importVersion,
    };
  } catch (error: unknown) {
    return { ok: false, error: "master-resume-invalid", detail: (error as Error).message };
  }
}

/** One field-level validation issue with its JSON path (WO-1.2-C). */
export interface MasterResumeIssue {
  path: Array<string | number>;
  message: string;
}

export type ValidatedMasterResume =
  | {
      ok: true;
      payload: CandidateProfilePayloadV2;
      payloadHash: string;
      importVersion: 1 | 2 | "unstamped";
    }
  | { ok: false; issues: MasterResumeIssue[] };

/**
 * No-write validation for the settings review flow: same acceptance as
 * `parseMasterResumeDocument`, but structured per-field issues instead
 * of one flattened message so the UI can highlight exact controls.
 */
export function validateMasterResumeDocument(document: unknown): ValidatedMasterResume {
  try {
    const normalized = normalizeImportDocument(document);
    return {
      ok: true,
      payload: normalized.payload,
      payloadHash: sha256HexUtf8(canonicalJson(normalized.payload)),
      importVersion: normalized.importVersion,
    };
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        issues: error.issues.map((issue) => ({
          path: issue.path.map((segment) =>
            typeof segment === "number" ? segment : String(segment),
          ),
          message: issue.message,
        })),
      };
    }
    return { ok: false, issues: [{ path: [], message: (error as Error).message }] };
  }
}

export interface ImportMasterInput {
  /** Parsed master document (import v1/v2, payload v1/v2, or unstamped body). */
  document: unknown;
  /** Verbatim bytes to store (file/CLI inputs); re-serialized when absent. */
  sourceBytes?: Buffer;
  /** Explicit target profile; default profile, else ensured local, otherwise. */
  profileId?: string;
  origin: SourceOrigin;
  sourcesDir: string;
  /** Activate the new version (default true; false stages a draft). */
  activate?: boolean;
}

/**
 * Validate, stage, publish, and import one master document into a
 * profile (R-ADR-016): parse/validate first, publish source bytes
 * recoverably, then commit version + source row + optional activation
 * in one short transaction. Any failure leaves the previous active
 * source/version and exports untouched; orphaned bytes are adopted by
 * the backfill or quarantined by reconcile. Shared by upload, resync,
 * and the CLI so all three accept exactly the same documents.
 */
export function importMasterDocument(
  handle: DatabaseHandle,
  input: ImportMasterInput,
): ResyncResult {
  // Human-initiated; the candidates service only accepts the literal actor.
  const actor = "human" as const;
  const activate = input.activate ?? true;
  const parsed = parseMasterResumeDocument(input.document);
  if (!parsed.ok) {
    return parsed;
  }
  // An explicit target wins (id or name, resolved to the row id);
  // otherwise the default profile; the legacy local profile only when
  // no default exists yet (fresh database).
  const explicit = input.profileId === undefined ? null : getProfile(handle, input.profileId);
  if (input.profileId !== undefined && explicit === null) {
    return {
      ok: false,
      error: "profile-not-found",
      detail: `unknown profile '${input.profileId}'`,
    };
  }
  const profileId = explicit?.id ?? getDefaultProfile(handle)?.id ?? ensureLocalProfile(handle);
  const bytes =
    input.sourceBytes ??
    Buffer.from(
      `${JSON.stringify({ ...parsed.payload, schemaVersion: CANDIDATE_IMPORT_SCHEMA_VERSION_V2 }, null, 2)}\n`,
      "utf8",
    );
  const latestRow = handle.sqlite
    .prepare(
      "SELECT id AS id, version AS version, payload_hash AS payloadHash FROM candidate_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(profileId) as { id: string; version: number; payloadHash: string } | undefined;
  if (latestRow !== undefined && latestRow.payloadHash === parsed.payloadHash) {
    // Same content: no new version. Self-heal a missing source row for
    // the latest version (pre-backfill databases), then report current.
    if (getSourceByVersion(handle, latestRow.id) === null) {
      const published = publishSourceBytes(input.sourcesDir, profileId, latestRow.id, bytes);
      insertSource(handle, {
        profileId,
        profileVersionId: latestRow.id,
        relativePath: published.relativePath,
        mediaType: SOURCE_MEDIA_TYPE,
        byteSize: published.byteSize,
        sha256: published.sha256,
        origin: input.origin,
      });
    }
    const active = getActiveProfileVersion(handle, profileId);
    if (!activate || (active !== null && active.id === latestRow.id)) {
      return {
        ok: true,
        versionId: latestRow.id,
        version: latestRow.version,
        activated: active !== null && active.id === latestRow.id,
        alreadyCurrent: true,
        insertedFacts: [],
        reusedFacts: [],
        remappedFacts: [],
      };
    }
    const activated = activateProfileVersion(handle, { versionId: latestRow.id, actor });
    if (!activated.ok) {
      return { ok: false, error: "activation-failed", detail: activated.error };
    }
    return {
      ok: true,
      versionId: latestRow.id,
      version: activated.version,
      activated: true,
      alreadyCurrent: true,
      insertedFacts: [],
      reusedFacts: [],
      remappedFacts: [],
    };
  }
  const versionId = newId();
  const published = publishSourceBytes(input.sourcesDir, profileId, versionId, bytes);
  try {
    return withTransaction(handle.sqlite, () => {
      const imported = importCandidate(handle, {
        document: input.document,
        actor,
        profileId,
        versionId,
      });
      if (!imported.ok) {
        return {
          ok: false,
          error: imported.error,
          detail: "detail" in imported ? String(imported.detail) : undefined,
        } as const;
      }
      insertSource(handle, {
        profileId,
        profileVersionId: imported.versionId,
        relativePath: published.relativePath,
        mediaType: SOURCE_MEDIA_TYPE,
        byteSize: published.byteSize,
        sha256: published.sha256,
        origin: input.origin,
      });
      if (!activate) {
        return {
          ok: true,
          versionId: imported.versionId,
          version: imported.version,
          activated: false,
          alreadyCurrent: false,
          insertedFacts: imported.insertedFacts,
          reusedFacts: imported.reusedFacts,
          remappedFacts: imported.remappedFacts,
        } as const;
      }
      const activated = activateProfileVersion(handle, { versionId: imported.versionId, actor });
      if (!activated.ok) {
        return { ok: false, error: "activation-failed", detail: activated.error } as const;
      }
      return {
        ok: true,
        versionId: imported.versionId,
        version: imported.version,
        activated: true,
        alreadyCurrent: false,
        insertedFacts: imported.insertedFacts,
        reusedFacts: imported.reusedFacts,
        remappedFacts: imported.remappedFacts,
      } as const;
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error, "candidate_sources")) {
      return { ok: false, error: "version-conflict", detail: "re-run the import" };
    }
    throw error;
  }
}

/**
 * Re-sync one career profile from a `master-resume.json` file: import
 * as a new immutable version (no-op when the canonical payload hash
 * matches that profile's latest version) and activate it. Defaults to
 * the default profile. The file is read-only input — it is never
 * overwritten, and failures leave the previous active version intact.
 * Never edits or deletes versions.
 */
export function resyncMasterResume(
  handle: DatabaseHandle,
  masterPath: string,
  options: { profileId?: string; sourcesDir: string },
): ResyncResult {
  if (options.profileId !== undefined && getProfile(handle, options.profileId) === null) {
    return {
      ok: false,
      error: "profile-not-found",
      detail: `unknown profile '${options.profileId}'`,
    };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(masterPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        error: "master-resume-missing",
        detail: `no master resume at ${masterPath}; add data/candidate/master-resume.json first`,
      };
    }
    return { ok: false, error: "master-resume-unreadable", detail: (error as Error).message };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return { ok: false, error: "master-resume-invalid", detail: "file is not valid JSON" };
  }
  return importMasterDocument(handle, {
    document,
    sourceBytes: raw,
    profileId: options.profileId,
    origin: "upload",
    sourcesDir: options.sourcesDir,
  });
}

export type ReadActiveMasterResult =
  | { ok: true; bytes: Buffer; mediaType: string; profileId: string; versionId: string; origin: string }
  | { ok: false; error: "profile-not-found" | "no-master" | "source-missing"; detail: string }
  | {
      ok: false;
      error: "source-unreadable" | "source-corrupt" | "version-not-found" | "version-profile-mismatch";
      detail: string;
    };

/**
 * Read one profile's active master source bytes (default profile when
 * no id is given). Ownership, traversal, and byte-integrity failures
 * come from the sources layer; this function only resolves addressing.
 */
export function readActiveMasterSource(
  handle: DatabaseHandle,
  sourcesDir: string,
  profileIdOrName?: string,
): ReadActiveMasterResult {
  const profile =
    profileIdOrName !== undefined ? getProfile(handle, profileIdOrName) : getDefaultProfile(handle);
  if (profile === null) {
    return profileIdOrName !== undefined
      ? { ok: false, error: "profile-not-found", detail: `unknown profile '${profileIdOrName}'` }
      : { ok: false, error: "no-master", detail: "no master resume saved yet" };
  }
  const active = getActiveProfileVersion(handle, profile.id);
  if (active === null) {
    return { ok: false, error: "no-master", detail: "no master resume saved yet" };
  }
  const read = readSourceBytes(handle, sourcesDir, profile.id, active.id);
  if (!read.ok) {
    if (read.error === "source-missing") {
      return { ok: false, error: "source-missing", detail: read.detail };
    }
    return { ok: false, error: read.error, detail: read.detail };
  }
  return {
    ok: true,
    bytes: read.bytes,
    mediaType: read.row.mediaType,
    profileId: profile.id,
    versionId: active.id,
    origin: read.row.origin,
  };
}

export function makeStagingDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
