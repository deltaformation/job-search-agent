import { z } from "zod";

/**
 * Typed resume presentation config (converted from `config/resume.yaml`).
 *
 * Presentation limits only: no resume facts, no template paths, no
 * provider input. The job description can never select a template; the
 * worker resolves these constants. Budgets mirror the oracle defaults:
 * 5/3/14 experience bullets, 3 detailed roles, 2-page budget.
 */

export const ResumeConfig = z
  .object({
    defaultTemplate: z.string(),
    templateVersion: z.string(),
    renderSchemaVersion: z.string(),
    rankingPolicyVersion: z.string(),
    pageBudget: z.number().int().min(1),
    maxExperienceBullets: z.number().int().min(1),
    maxPriorRoleBullets: z.number().int().min(1),
    maxTotalBullets: z.number().int().min(1),
    maxDetailedRoles: z.number().int().min(1),
    maxEarlierCareerEntries: z.number().int().min(1),
    variantsEnabled: z.boolean(),
  })
  .strict();
export type ResumeConfig = z.infer<typeof ResumeConfig>;

export const RESUME_CONFIG: ResumeConfig = {
  defaultTemplate: "mouad_standard_v1",
  templateVersion: "v1",
  renderSchemaVersion: "v1",
  rankingPolicyVersion: "coverage-first/v1",
  pageBudget: 2,
  maxExperienceBullets: 5,
  maxPriorRoleBullets: 3,
  maxTotalBullets: 14,
  maxDetailedRoles: 3,
  maxEarlierCareerEntries: 6,
  variantsEnabled: false,
};

ResumeConfig.parse(RESUME_CONFIG);
