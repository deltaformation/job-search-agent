import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import {
  CANDIDATE_PROFILE_SCHEMA_VERSION,
  CandidateProfilePayloadV1,
  type WorkPreferencesV1,
} from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import { sha256HexUtf8 } from "../tailoring/hash";
import type { DataRootPaths } from "../security/data-root";
import {
  ensureLocalProfile,
  getActiveProfileVersion,
  getDefaultProfile,
  getProfile,
  listProfileVersions,
  listProfiles,
} from "../db/candidates";
import { activateProfileVersion, importCandidate } from "./candidates";
import {
  activeProviderId as activeProviderIdFromEnv,
  providerChain,
  providerChat,
} from "../../scripts/ai-provider.mjs";

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

export interface SettingsSnapshot {
  models: { primary: string; fallback: string };
  activeProvider: AiProviderId;
  providers: Record<AiProviderId, ProviderSnapshot>;
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

export function getSettingsSnapshot(
  handle: DatabaseHandle,
  input: { paths: DataRootPaths; env?: Record<string, string | undefined> },
): SettingsSnapshot {
  const env = input.env ?? process.env;
  const activeProvider = activeProviderId(env);
  const providers = Object.fromEntries(
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
  const active = getActiveProfileVersion(handle);
  let profile: SettingsSnapshot["profile"] = null;
  if (active !== null) {
    let displayName: string | null = null;
    let verifiedSkills = 0;
    try {
      const payload = CandidateProfilePayloadV1.parse(
        JSON.parse(active.payloadJson) as unknown,
      );
      const record = payload as unknown as Record<string, unknown>;
      const identity = record["identity"] as Record<string, unknown> | undefined;
      const fullName = record["full_name"];
      displayName =
        typeof identity?.["fullName"] === "string"
          ? (identity["fullName"] as string)
          : typeof fullName === "string"
            ? fullName
            : null;
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

const PROVIDER_MODEL_ENV: Record<AiProviderId, { model: string; fallback: string }> = {
  openrouter: { model: "OPENROUTER_MODEL", fallback: "OPENROUTER_FALLBACK_MODEL" },
  google: { model: "GEMINI_MODEL", fallback: "GEMINI_FALLBACK_MODEL" },
  meta: { model: "META_MODEL", fallback: "META_FALLBACK_MODEL" },
};

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
 * Switch the active AI provider and/or any provider's model chain by
 * upserting `.env.local` (comments and unrelated keys preserved).
 * Applies on app restart: the worker and routes read process env at
 * boot. Never writes API keys.
 */
export function switchModels(
  envFilePath: string,
  rawInput: unknown,
): { primary: string; fallback: string; activeProvider: AiProviderId; restartRequired: true } {
  const input = ModelSwitchInput.parse(rawInput);
  let content = "";
  try {
    content = readFileSync(envFilePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SettingsError(`cannot read env file: ${(error as Error).message}`);
    }
  }
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
    mkdirSync(dirname(envFilePath), { recursive: true });
    writeFileSync(
      envFilePath,
      content.endsWith("\n") || content === "" ? content : `${content}\n`,
      "utf8",
    );
  } catch (error: unknown) {
    throw new SettingsError(`cannot write env file: ${(error as Error).message}`);
  }
  // Response shows the file's active chain (what a fresh boot reads); a
  // real shell-exported variable still wins at runtime, matching
  // Next/script precedence, and is visible in the snapshot after restart.
  const wanted = new Set([
    "ACTIVE_AI_PROVIDER",
    ...Object.values(PROVIDER_MODEL_ENV).flatMap((keys) => [keys.model, keys.fallback]),
  ]);
  const fileEnv: Record<string, string | undefined> = {};
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && wanted.has(match[1])) {
      fileEnv[match[1]] = match[2]?.trim() || undefined;
    }
  }
  const activeProvider = activeProviderId(fileEnv);
  const chain = providerChain(activeProvider, fileEnv) as string[];
  return {
    primary: chain[0] as string,
    fallback: (chain[1] ?? chain[0]) as string,
    activeProvider,
    restartRequired: true,
  };
}

export interface AiTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  error: string | null;
}

export const AiTestInput = z
  .object({ provider: AiProviderIdSchema.optional() })
  .strict();
export type AiTestInput = z.infer<typeof AiTestInput>;

/**
 * Lightweight provider ping: one tiny JSON prompt on the provider's
 * primary model, validating auth, latency, and a well-formed JSON
 * reply. Unknown providers throw `SettingsError` (route maps to 400).
 */
export async function pingProvider(
  provider: AiProviderId,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<AiTestResult> {
  if (!AI_PROVIDER_IDS.includes(provider)) {
    throw new SettingsError(`unknown AI provider: ${String(provider)}`);
  }
  const keyName = PROVIDER_KEY_ENV[provider];
  const key = env[keyName]?.trim() || "";
  if (key === "") {
    return { ok: false, model: null, latencyMs: 0, error: `${keyName} is not configured` };
  }
  const chain = providerChain(provider, env) as string[];
  const primary = chain[0] as string;
  const started = Date.now();
  try {
    const completion = (await providerChat(provider, {
      apiKey: key,
      models: [primary],
      messages: [{ role: "user", content: 'Reply with exactly: {"ping":"ok"}' }],
      timeoutMs,
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
        error: "model did not return the expected ping payload",
      };
    }
    return { ok: true, model: completion.model, latencyMs: Date.now() - started, error: null };
  } catch (error: unknown) {
    return {
      ok: false,
      model: primary,
      latencyMs: Date.now() - started,
      error: (error as Error).message,
    };
  }
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
        const payload = CandidateProfilePayloadV1.parse(
          JSON.parse(latest.payloadJson) as unknown,
        );
        approvedFacts = payload.achievements.length;
      } catch {
        approvedFacts = 0;
      }
    }
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
    };
  });
}

export type ResyncResult =
  | { ok: true; versionId: string; version: number; activated: boolean; alreadyCurrent: boolean }
  | { ok: false; error: string; detail?: string };

export type ParsedMasterResume =
  | { ok: true; payloadHash: string }
  | { ok: false; error: "master-resume-invalid"; detail: string };

/**
 * Validate one master-resume document against the profile payload schema
 * and return its canonical hash. Shared by file re-sync and JSON upload
 * so both accept exactly the same documents.
 */
export function parseMasterResumeDocument(document: unknown): ParsedMasterResume {
  try {
    const payload = CandidateProfilePayloadV1.parse({
      ...((document ?? {}) as Record<string, unknown>),
      schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
    });
    return { ok: true, payloadHash: sha256HexUtf8(canonicalJson(payload)) };
  } catch (error: unknown) {
    return { ok: false, error: "master-resume-invalid", detail: (error as Error).message };
  }
}

/**
 * Re-sync one career profile from `master-resume.json`: import as a new
 * immutable version (no-op when the canonical payload hash matches that
 * profile's latest version) and activate it. Defaults to the default
 * profile. Never edits or deletes versions.
 */
export function resyncMasterResume(
  handle: DatabaseHandle,
  masterPath: string,
  options: { profileId?: string } = {},
): ResyncResult {
  // Human-initiated from the Settings modal; the candidates service only
  // accepts the literal human actor.
  const actor = "human" as const;
  // An explicit target wins; otherwise the default profile; the legacy
  // local profile only when no default exists yet (fresh database).
  const profileId =
    options.profileId ?? getDefaultProfile(handle)?.id ?? ensureLocalProfile(handle);
  if (options.profileId !== undefined && getProfile(handle, options.profileId) === null) {
    return {
      ok: false,
      error: "profile-not-found",
      detail: `unknown profile '${options.profileId}'`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(masterPath, "utf8");
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
    document = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "master-resume-invalid", detail: "file is not valid JSON" };
  }
  const parsed = parseMasterResumeDocument(document);
  if (!parsed.ok) {
    return parsed;
  }
  const latestRow = handle.sqlite
    .prepare(
      "SELECT id AS id, payload_hash AS payloadHash FROM candidate_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(profileId) as { id: string; payloadHash: string } | undefined;
  if (latestRow !== undefined && latestRow.payloadHash === parsed.payloadHash) {
    const active = getActiveProfileVersion(handle, profileId);
    if (active !== null && active.id === latestRow.id) {
      return {
        ok: true,
        versionId: latestRow.id,
        version: active.version,
        activated: true,
        alreadyCurrent: true,
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
    };
  }
  const imported = importCandidate(handle, { document, actor, profileId });
  if (!imported.ok) {
    return {
      ok: false,
      error: imported.error,
      detail: "detail" in imported ? String(imported.detail) : undefined,
    };
  }
  const activated = activateProfileVersion(handle, { versionId: imported.versionId, actor });
  if (!activated.ok) {
    return { ok: false, error: "activation-failed", detail: activated.error };
  }
  return {
    ok: true,
    versionId: imported.versionId,
    version: imported.version,
    activated: true,
    alreadyCurrent: false,
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
