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
} from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import { sha256HexUtf8 } from "../tailoring/hash";
import type { DataRootPaths } from "../security/data-root";
import { getActiveProfileVersion } from "../db/candidates";
import { activateProfileVersion, importCandidate } from "./candidates";
import { chatCompletions, modelChain } from "../../scripts/openrouter-client.mjs";

/**
 * Settings & Data Management service (R5-A): snapshot/read models for the
 * Settings modal, OpenRouter model switching (via `.env.local` upsert),
 * connection pings, master-resume re-sync, and storage stats. Board reset
 * lives in `src/server/backup.ts` beside the safety backup it requires.
 */

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

export interface SettingsSnapshot {
  models: { primary: string; fallback: string };
  openRouter: { configured: boolean; fingerprint: string | null };
  profile: {
    activeVersion: number;
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
  const [primary, fallback] = modelChain(env);
  const key = env.OPENROUTER_API_KEY?.trim() || "";
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
    models: { primary: primary as string, fallback: (fallback ?? primary) as string },
    openRouter: { configured: key !== "", fingerprint: key === "" ? null : keyFingerprint(key) },
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
    primary: ModelId.optional(),
    fallback: ModelId.optional(),
    clearFallback: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.primary !== undefined || input.fallback !== undefined || input.clearFallback === true, {
    message: "nothing to switch",
  });
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
 * Switch the OpenRouter model chain by upserting `.env.local` (comments
 * and unrelated keys preserved). Applies on app restart: the worker and
 * routes read process env at boot. Never writes the API key.
 */
export function switchModels(
  envFilePath: string,
  rawInput: unknown,
): { primary: string; fallback: string; restartRequired: true } {
  const input = ModelSwitchInput.parse(rawInput);
  let content = "";
  try {
    content = readFileSync(envFilePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SettingsError(`cannot read env file: ${(error as Error).message}`);
    }
  }
  if (input.primary !== undefined) {
    content = upsertEnvLine(content, "OPENROUTER_MODEL", input.primary);
  }
  if (input.clearFallback === true) {
    content = upsertEnvLine(content, "OPENROUTER_FALLBACK_MODEL", null);
  } else if (input.fallback !== undefined) {
    content = upsertEnvLine(content, "OPENROUTER_FALLBACK_MODEL", input.fallback);
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
  // Response shows the file's chain (what a fresh boot reads); a real
  // shell-exported variable still wins at runtime, matching Next/script
  // precedence, and is visible in the snapshot after restart.
  const fileEnv: Record<string, string | undefined> = {};
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === "OPENROUTER_MODEL" || match?.[1] === "OPENROUTER_FALLBACK_MODEL") {
      fileEnv[match[1] as string] = (match[2] as string).trim() || undefined;
    }
  }
  const [primary, fallback] = modelChain(fileEnv);
  return { primary: primary as string, fallback: (fallback ?? primary) as string, restartRequired: true };
}

export interface AiTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  error: string | null;
}

/** Lightweight OpenRouter ping: one tiny JSON prompt on the primary model. */
export async function pingOpenRouter(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<AiTestResult> {
  const key = env.OPENROUTER_API_KEY?.trim() || "";
  if (key === "") {
    return { ok: false, model: null, latencyMs: 0, error: "OPENROUTER_API_KEY is not configured" };
  }
  const [primary] = modelChain(env);
  const started = Date.now();
  try {
    const completion = await chatCompletions({
      apiKey: key,
      models: [primary as string],
      messages: [{ role: "user", content: 'Reply with exactly: {"ping":"ok"}' }],
      timeoutMs,
    });
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
      model: primary as string,
      latencyMs: Date.now() - started,
      error: (error as Error).message,
    };
  }
}

export type ResyncResult =
  | { ok: true; versionId: string; version: number; activated: boolean; alreadyCurrent: boolean }
  | { ok: false; error: string; detail?: string };

/**
 * Re-sync the candidate profile from `master-resume.json`: import as a new
 * immutable version (no-op when the canonical payload hash matches the
 * latest version) and activate it. Never edits or deletes versions.
 */
export function resyncMasterResume(
  handle: DatabaseHandle,
  masterPath: string,
): ResyncResult {
  // Human-initiated from the Settings modal; the candidates service only
  // accepts the literal human actor.
  const actor = "human" as const;
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
  let payloadHash: string;
  try {
    const payload = CandidateProfilePayloadV1.parse({
      ...(document as Record<string, unknown>),
      schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
    });
    payloadHash = sha256HexUtf8(canonicalJson(payload));
  } catch (error: unknown) {
    return { ok: false, error: "master-resume-invalid", detail: (error as Error).message };
  }
  const latestRow = handle.sqlite
    .prepare("SELECT id AS id, payload_hash AS payloadHash FROM candidate_profile_versions ORDER BY version DESC LIMIT 1")
    .get() as { id: string; payloadHash: string } | undefined;
  if (latestRow !== undefined && latestRow.payloadHash === payloadHash) {
    const active = getActiveProfileVersion(handle);
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
  const imported = importCandidate(handle, { document, actor });
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
