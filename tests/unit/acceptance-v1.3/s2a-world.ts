// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStoredProfilePayload,
  type StoredProfilePayload,
} from "../../../src/domain/candidate";
import { canonicalText } from "../../../src/domain/canonical";
import {
  PreparationPlanV1,
  type PreparationPlanV1 as PreparationPlanV1Type,
} from "../../../src/domain/step2";
import type { Step2SnapshotFact } from "../../../src/domain/step2Claims";

/**
 * S2-A fixture world: loads the fixed evaluation fixtures in
 * `tests/fixtures/step2/` and builds typed validation inputs. The
 * JSON files are the frozen expectations; this module only loads and
 * shapes them (plus strict-parses the recorded plans).
 */

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures", "step2");

export interface ExpectedPriority {
  key: string;
  priorityId: string;
  quote: { text: string; startByte: number; endByte: number };
  count: number;
  category: string;
  importance: string;
  support: string;
  factIds: string[];
}

export interface ExpectedSegment {
  case: string;
  segmentId: string;
  kind: "summary" | "bullet";
  roleId: string | null;
  text: string;
  citedFactIds: string[];
  derivation?: { finalText: string; factIds: string[] };
  verdict: "supported" | "needs-evidence";
  match: string;
  reason: string | null;
}

export interface PmExpected {
  caseId: string;
  extractionId: string;
  profileVersionId: string;
  planId: string;
  preparationId: string;
  jdHash: string;
  payloadHash: string;
  evidenceHash: string;
  masterProjectionHash: string;
  planHash: string;
  versionCreatedAt: string;
  planAcceptedAt: string;
  now: string;
  priorities: ExpectedPriority[];
  featuredKeys: string[];
  plan: unknown;
  prohibitedClaimCases: string[];
  segments: ExpectedSegment[];
}

export interface SparseExpected {
  caseId: string;
  extractionId: string;
  profileVersionId: string;
  planId: string;
  preparationId: string;
  jdHash: string;
  payloadHash: string;
  evidenceHash: string;
  masterProjectionHash: string;
  planHash: string;
  versionCreatedAt: string;
  planAcceptedAt: string;
  now: string;
  priorities: ExpectedPriority[];
  plan: unknown;
}

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, name), "utf8"),
  ) as unknown;
}

export function loadPmExpected(): PmExpected {
  return readJson("pm-expected.json") as PmExpected;
}

export function loadSparseExpected(): SparseExpected {
  return readJson("sparse-expected.json") as SparseExpected;
}

export function loadPmJd(): string {
  return canonicalText(
    readFileSync(join(FIXTURE_ROOT, "pm-jd.txt"), "utf8"),
  );
}

export function loadSparseJd(): string {
  return canonicalText(
    readFileSync(join(FIXTURE_ROOT, "sparse-jd.txt"), "utf8"),
  );
}

export function loadPmProfile(): StoredProfilePayload {
  return parseStoredProfilePayload(readJson("pm-profile.json"));
}

export function loadSparseProfile(): StoredProfilePayload {
  return parseStoredProfilePayload(readJson("sparse-profile.json"));
}

export function pmPlan(expected: PmExpected): PreparationPlanV1Type {
  return PreparationPlanV1.parse(expected.plan);
}

export function sparsePlan(expected: SparseExpected): PreparationPlanV1Type {
  return PreparationPlanV1.parse(expected.plan);
}

export function snapshotFactsFor(
  payload: StoredProfilePayload,
  profileVersionId: string,
): Step2SnapshotFact[] {
  return payload.achievements.map((achievement) => ({
    factId: achievement.factId,
    statement: achievement.text,
    verification: achievement.verification,
    profileVersionId,
    employmentId: achievement.employmentId ?? null,
    metrics: [...achievement.metrics],
    technologies: [...achievement.technologies],
  }));
}

export function planTextsFor(plan: PreparationPlanV1Type): Array<{
  textId: string;
  text: string;
}> {
  const texts: Array<{ textId: string; text: string }> = [];
  for (const suggestion of plan.suggestions) {
    texts.push({ textId: suggestion.suggestionId, text: suggestion.text });
  }
  for (const angle of plan.positioning.angles) {
    texts.push({ textId: angle.angleId, text: angle.summaryText });
  }
  if (plan.positioning.keepMasterSummary !== "") {
    texts.push({
      textId: "keep-master",
      text: plan.positioning.keepMasterSummary,
    });
  }
  return texts;
}
