import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import {
  writeJobSalaryBackfill,
  type SalaryBackfillOutcome,
} from "../db/tailoring";
import { runCommandJson } from "./commandAdapter";

/**
 * R4-G Step-2 salary fallback: when a job has extracted text but no
 * salary, the tailor handler asks the salary-facts sidecar (AI with a
 * dual-model chain, else empty facts) and backfills `jobs.salary_*` plus
 * compensation highlights — before the fenced tailoring run begins.
 *
 * The sidecar speaks its own versioned schema (`salary-facts/v1`), so
 * the strict tailoring proposal contract stays frozen: salary facts are
 * job facts, not resume content. The backfill is best-effort and never
 * fails a tailoring run. Subprocess work stays in the command adapter;
 * the write stays in the db layer; this module only validates and maps.
 */

export const SALARY_FACTS_VERSION = "salary-facts/v1";

export const SalaryFactsV1 = z
  .object({
    schemaVersion: z.literal(SALARY_FACTS_VERSION),
    salaryMinMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    salaryMaxMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    currency: z.enum(["USD", "CAD", "AUD", "GBP", "EUR"]).nullable(),
    salaryText: z.string().min(1).max(500).nullable(),
    isHourlyOrDaily: z.boolean(),
    compensationHighlights: z.array(z.string().min(1).max(120)).max(8),
    model: z.string().max(256).nullable(),
  })
  .strict()
  .refine(
    (facts) =>
      facts.salaryMinMinor === null ||
      facts.salaryMaxMinor === null ||
      facts.salaryMinMinor <= facts.salaryMaxMinor,
    "salary range is inverted",
  )
  .refine(
    (facts) =>
      !facts.isHourlyOrDaily || (facts.salaryMinMinor === null && facts.salaryMaxMinor === null),
    "hourly rates must not carry annual minors",
  );
export type SalaryFactsV1 = z.infer<typeof SalaryFactsV1>;

export interface SalaryFallbackRequest {
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  jdText: string;
}

export interface SalaryFallbackConfig {
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Invoke the sidecar and parse its facts. Never throws and never
 * rejects: every failure mode (spawn, timeout, exit status, unparseable
 * or schema-invalid stdout) resolves null after one diagnostic line, so
 * callers can treat salary as enhancement-only without branching.
 */
export async function runSalaryFallback(input: {
  config: SalaryFallbackConfig;
  request: SalaryFallbackRequest;
  onDiagnostic?: (message: string) => void;
}): Promise<SalaryFactsV1 | null> {
  const { config, request, onDiagnostic } = input;
  const stdout = await runCommandJson({
    argv: config.argv,
    stdin: JSON.stringify({
      jobTitle: request.jobTitle,
      company: request.company,
      location: request.location,
      jdText: request.jdText,
    }),
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    onDiagnostic,
  });
  if (stdout === null) {
    return null;
  }
  try {
    return SalaryFactsV1.parse(JSON.parse(stdout) as unknown);
  } catch (error: unknown) {
    (onDiagnostic ?? ((): void => {}))(
      `salary fallback output rejected: ${(error as Error).message}`,
    );
    return null;
  }
}

export type BackfillSalaryOutcome = SalaryBackfillOutcome;

/**
 * Conditional salary backfill (see `writeJobSalaryBackfill`): writes
 * only when the run's extraction is still active and no salary text
 * landed meanwhile.
 */
export function backfillJobSalary(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; facts: SalaryFactsV1 },
): BackfillSalaryOutcome {
  return writeJobSalaryBackfill(handle, {
    jobId: input.jobId,
    extractionId: input.extractionId,
    facts: {
      salaryText: input.facts.salaryText,
      currency: input.facts.currency,
      salaryMinMinor: input.facts.salaryMinMinor,
      salaryMaxMinor: input.facts.salaryMaxMinor,
      compensationHighlights: input.facts.compensationHighlights,
    },
  });
}
