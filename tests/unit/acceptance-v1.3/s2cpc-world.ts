// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POST as clipPOST } from "../../../app/api/intake/clip/route";
import { GET as clipTokenGET } from "../../../app/api/intake/clip-token/route";
import {
  newId,
  openDatabase,
  type DatabaseHandle,
} from "../../../src/db";
import { createProfile } from "../../../src/db/candidates";
import { readPlan, readPreparationByJob } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { canonicalText } from "../../../src/domain/canonical";
import {
  PreparationPlanV2,
  type PreparationPlanV2 as PreparationPlanV2Type,
} from "../../../src/domain/step2Correction";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import {
  getRequest,
  mutationHeaders,
  readJson,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import type { V13Basics } from "../db/v13world";
import {
  claimS2b,
  finishS2bAttempt,
  proposalForS2bV2,
  runS2bAttempt,
  s2bSnapshotIds,
  S2B_KEYED_ENV,
} from "./s2b-world";

/**
 * WO-1.3-S2-CP-C Lime world (S2CPC4/5): faithful redacted Lime
 * fixtures plus the real route/worker path — clip intake (which
 * auto-schedules preparation when a provider key is configured),
 * supervised PREPARE with a scriptable provider, and accepted-v2
 * plan reads. Setup helpers throw on any failure so a broken setup
 * can never masquerade as an expected failure.
 */

export const LIME_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "lime",
);
export const LIME_JD = readFileSync(join(LIME_DIR, "lime-jd.txt"), "utf8");
export const LIME_CLIP_HTML = readFileSync(join(LIME_DIR, "lime-clip.html"), "utf8");
export const LIME_URL = "https://jobs.ashbyhq.com/lime/ab357293-3421-4183-94d5-2b60ef711edf";

export function limeMasterDocument(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(LIME_DIR, "lime-master.json"), "utf8")) as Record<
    string,
    unknown
  >;
  delete raw["_redaction"];
  return raw;
}

export function limeMasterSummary(): string {
  return String((limeMasterDocument()["summary"] as string) ?? "");
}

/** Unsupported user edit: NetSuite/P&L/percentage claims the master never makes. */
export const LIME_EDITED =
  "Supply chain product leader who owned a NetSuite ERP rollout end to end with P&L ownership, lifting fulfillment revenue 300% in one quarter.";

export const FOREIGN_PRIORITY_ID = "f".repeat(64);

export function putRequest(path: string, body: unknown, ifMatch: string | null): Request {
  const headers: Record<string, string> = {
    ...mutationHeaders(),
    "content-type": "application/json",
  };
  if (ifMatch !== null) {
    headers["if-match"] = ifMatch;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function clipAuthed(token: string, body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/intake/clip", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "https://boards.example",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export interface LimeHarness {
  isolated: IsolatedRoot;
  savedEnv: Record<string, string | undefined>;
  withDb: <T>(fn: (handle: DatabaseHandle) => T | Promise<T>) => Promise<T>;
}

export function keyedEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(S2B_KEYED_ENV)) {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    process.env[key] = value;
  }
}

export function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function openHarness(prefix = "job-tracker-v13-s2cpc-lime-"): LimeHarness {
  const isolated = setupIsolatedRoot(prefix);
  const savedEnv: Record<string, string | undefined> = {};
  keyedEnv(savedEnv);
  const withDb = <T,>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> => {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    return Promise.resolve()
      .then(() => fn(handle))
      .finally(() => handle.close());
  };
  return { isolated, savedEnv, withDb };
}

export function closeHarness(harness: LimeHarness): void {
  restoreEnv(harness.savedEnv);
  harness.isolated.restoreEnv();
  harness.isolated.cleanup();
}

export function seedLimeProfile(handle: DatabaseHandle): {
  profileId: string;
  profileVersionId: string;
} {
  const profile = createProfile(handle, { name: "lime-pm", displayName: "Mouad PM" });
  const imported = importCandidate(handle, {
    document: limeMasterDocument(),
    actor: "human",
    profileId: profile.id,
  });
  if (!imported.ok) {
    throw new Error(`Lime master import failed: ${JSON.stringify(imported)}`);
  }
  const activated = activateProfileVersion(handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error(`Lime master activation failed: ${JSON.stringify(activated)}`);
  }
  return { profileId: profile.id, profileVersionId: imported.versionId };
}

export async function clipLime(): Promise<{
  batchId: string;
  intakeItemId: string;
  jobId: string;
}> {
  const tokenResponse = await clipTokenGET(getRequest("/api/intake/clip-token"));
  if (tokenResponse.status !== 200) {
    throw new Error(`Lime clip-token failed: ${tokenResponse.status}`);
  }
  const token = String((await readJson(tokenResponse))["token"]);
  const response = await clipPOST(
    clipAuthed(token, {
      url: LIME_URL,
      html: LIME_CLIP_HTML,
      title: "Lead Product Manager, Supply Chain Systems",
    }),
  );
  if (response.status !== 200) {
    throw new Error(`Lime clip failed: ${response.status}`);
  }
  const body = await readJson(response);
  if (body["outcome"] !== "created") {
    throw new Error(`Lime clip outcome: ${JSON.stringify(body)}`);
  }
  return {
    batchId: String(body["batchId"]),
    intakeItemId: String(body["intakeItemId"]),
    jobId: String(body["jobId"]),
  };
}

export interface LimeBasics {
  jobId: string;
  extractionId: string;
  profileId: string;
  profileVersionId: string;
  jdText: string;
  rowVersion: number;
}

export async function readLimeBasics(
  harness: LimeHarness,
  jobId: string,
  profile: { profileId: string; profileVersionId: string },
): Promise<LimeBasics> {
  return harness.withDb((handle) => {
    const job = getTailoringJob(handle, jobId);
    if (job === null || job.activeExtractionId === null || job.descriptionText === null) {
      throw new Error("Lime clip produced no job/extraction/description");
    }
    return {
      jobId,
      extractionId: job.activeExtractionId,
      profileId: profile.profileId,
      profileVersionId: profile.profileVersionId,
      jdText: job.descriptionText,
      rowVersion: job.rowVersion,
    };
  });
}

export function asV13Basics(basics: LimeBasics): V13Basics {
  return {
    jobId: basics.jobId,
    extractionId: basics.extractionId,
    profileId: basics.profileId,
    profileVersionId: basics.profileVersionId,
    snapshotId: "",
    jdSnapshotId: "",
    jdHash: "",
    profileHash: "",
    jdText: basics.jdText,
  };
}

/**
 * Scripted v2 proposal over the LIVE clipped bytes: quotes locate in
 * the stored description (never fixture offsets); supported
 * priorities anchor approved Lime facts, NetSuite/Anaplan stay real
 * gaps, and the two angles partition facts for the union guard.
 */
export function limeProposal(
  handle: DatabaseHandle,
  basics: LimeBasics,
): ReturnType<typeof proposalForS2bV2> {
  const snapshots = s2bSnapshotIds(handle, asV13Basics(basics), basics.jdText);
  const canonicalJd = canonicalText(basics.jdText);
  return proposalForS2bV2({
    jdText: canonicalJd,
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    extractionId: basics.extractionId,
    jdHash: sha256HexUtf8(canonicalJd),
    quotes: [
      {
        text: "product roadmap",
        importance: "required",
        matchStatus: "matched",
        factIds: ["fact_odo_002"],
      },
      {
        text: "Agile/Scrum",
        importance: "required",
        matchStatus: "matched",
        factIds: ["fact_aot_002"],
      },
      {
        text: "cross-functional teams",
        importance: "required",
        matchStatus: "matched",
        factIds: ["fact_ibm_004"],
      },
      { text: "NetSuite ERP", importance: "required", matchStatus: "gap", factIds: [] },
      { text: "Anaplan", importance: "preferred", matchStatus: "gap", factIds: [] },
    ],
    angles: [
      {
        title: "Fleet-operations transfer",
        summaryText:
          "Product leader bringing fleet-operations and SaaS platform experience to supply chain systems.",
        factIds: ["fact_odo_001", "fact_odo_002"],
        links: [0, 2],
      },
      {
        title: "Metrics-driven delivery",
        summaryText:
          "Delivery-focused PM with measurable SaaS outcomes: NPS gains and 4x release velocity.",
        factIds: ["fact_aot_002", "fact_aot_003"],
        links: [1, 2],
      },
    ],
    suggestions: [
      {
        roleId: "emp-odotrack",
        text: "Owned backlog and roadmap for a B2B SaaS platform serving fleet operations, translating customer feedback into prioritized initiatives.",
        factIds: ["fact_odo_002"],
        links: [0],
      },
      {
        roleId: "emp-aot",
        text: "Moved an engineering-centric organization to consistent quarterly releases with Agile practices, lifting feature delivery velocity 4x within six months.",
        factIds: ["fact_aot_002"],
        links: [1],
      },
    ],
    rationale: "S2CPC4 scripted Lime proposal over live clipped bytes.",
  });
}

export interface LimeScheduled {
  basics: LimeBasics;
  batchId: string;
  preparationId: string;
  prepWorkItemId: string;
  now: string;
}

/** Clip the Lime posting; intake auto-schedules its preparation (provider key set). */
export async function clipAndScheduleLime(harness: LimeHarness): Promise<LimeScheduled> {
  const profile = await harness.withDb((handle) => seedLimeProfile(handle));
  const clipped = await clipLime();
  const basics = await readLimeBasics(harness, clipped.jobId, profile);
  const now = new Date().toISOString();

  const auto = await harness.withDb((handle) => readPreparationByJob(handle, basics.jobId));
  if (auto === null || auto.workItemId === null || auto.workItemId === undefined) {
    throw new Error("Lime clip auto-scheduled no preparation work");
  }
  if (auto.state !== "QUEUED") {
    throw new Error(`Lime auto-preparation state is ${auto.state}, expected QUEUED`);
  }
  if (auto.profileVersionId !== profile.profileVersionId) {
    throw new Error("Lime auto-preparation bound the wrong profile version");
  }
  return {
    basics,
    batchId: clipped.batchId,
    preparationId: auto.id,
    prepWorkItemId: auto.workItemId,
    now,
  };
}

export interface LimeAccepted {
  basics: LimeBasics;
  batchId: string;
  preparationId: string;
  prepWorkItemId: string;
  prepAttemptId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV2Type;
  snapshots: { jdSnapshotId: string; candidateSnapshotId: string };
  now: string;
}

/** Full intake→accepted-plan setup over real routes + the PREPARE worker leg. */
export async function seedLimeAccepted(harness: LimeHarness): Promise<LimeAccepted> {
  const scheduled = await clipAndScheduleLime(harness);
  const { basics, now } = scheduled;
  const preparationId = scheduled.preparationId;
  const prepWorkItemId = scheduled.prepWorkItemId;

  const proposal = await harness.withDb((handle) => limeProposal(handle, basics));
  const snapshots = await harness.withDb((handle) =>
    s2bSnapshotIds(handle, asV13Basics(basics), basics.jdText),
  );
  const provider = new TestPrepareProvider({ proposals: { [snapshots.jdSnapshotId]: proposal } });
  const claimed = await harness.withDb((handle) => claimS2b(handle, { now }));
  if (claimed.workItemId !== prepWorkItemId) {
    throw new Error("Lime claim took the wrong work item");
  }
  const outcome = await harness.withDb((handle) => runS2bAttempt(handle, claimed, provider, { now }));
  if (outcome.result !== "SUCCEEDED") {
    throw new Error(`Lime PREPARE cycle failed: ${outcome.result} ${outcome.errorCode ?? ""}`);
  }
  await harness.withDb((handle) => finishS2bAttempt(handle, { ...claimed, outcome, now }));

  const accepted = await harness.withDb((handle) => {
    const preparation = readPreparationByJob(handle, basics.jobId);
    if (preparation?.acceptedPlanId === null || preparation?.acceptedPlanId === undefined) {
      throw new Error("Lime PREPARE cycle produced no accepted plan");
    }
    const stored = readPlan(handle, preparation.acceptedPlanId);
    if (stored === null) {
      throw new Error("Lime accepted plan is unreadable");
    }
    return {
      planRowId: stored.id,
      planHash: stored.planHash,
      plan: PreparationPlanV2.parse(JSON.parse(stored.planJson) as unknown),
    };
  });
  return {
    basics,
    batchId: scheduled.batchId,
    preparationId,
    prepWorkItemId,
    prepAttemptId: claimed.attemptId,
    planRowId: accepted.planRowId,
    planHash: accepted.planHash,
    plan: accepted.plan,
    snapshots,
    now,
  };
}

export function usableLimeSuggestions(plan: PreparationPlanV2Type): Array<{
  suggestionId: string;
  roleId: string;
  text: string;
}> {
  const usable = plan.suggestions.filter((suggestion) => suggestion.usable);
  if (usable.length < 2) {
    throw new Error("Lime plan carries fewer than two usable suggestions");
  }
  return usable.map((suggestion) => ({
    suggestionId: suggestion.suggestionId,
    roleId: suggestion.roleId,
    text: suggestion.text,
  }));
}

/**
 * Fitting excludes for the 17-fact Lime master (budgets: 3
 * bullets/role, 14 total, 2 PDF pages). Trims to a focused
 * 8-bullet tailored resume: odotrack keeps 1 + 1 add, aot keeps
 * 1 + 1 add, every other role keeps 1.
 */
export function limeFittingExcludes(): Array<{
  op: "exclude";
  operationId: string;
  targetFactId: string;
}> {
  return [
    "fact_aot_001",
    "fact_aot_003",
    "fact_aot_004",
    "fact_ibm_001",
    "fact_ibm_002",
    "fact_ibm_003",
    "fact_ibm_005",
    "fact_ibm_006",
    "fact_odo_001",
    "fact_odo_003",
    "fact_myr_001",
  ].map((targetFactId) => ({ op: "exclude" as const, operationId: newId(), targetFactId }));
}
