import { z } from "zod";

/**
 * Candidate profile read-model for the truthfulness port. Keys keep the
 * oracle's `snake_case` vocabulary so R4-B fixtures feed the port without
 * translation; R4-E adapts R4-A storage rows to this shape at one boundary.
 *
 * Tolerance mirrors the oracle: absent keys fall back to the same defaults
 * (empty collections, empty strings, `verified: false`). Present-but-wrongly
 * -typed values throw `ZodError` instead of reproducing oracle crashes or
 * truthy coercions — the profile is our own snapshot data, so malformed
 * content is corruption, not agent input (agent inputs get oracle-identical
 * rule messages from the hand-rolled checks in `validator.ts`).
 */

const ProfileFact = z
  .object({
    fact_id: z.string(),
    work_experience_id: z.string().nullable().optional(),
    category: z.string().optional().default(""),
    text: z.string().optional().default(""),
    technologies: z.array(z.string()).optional().default([]),
    metrics: z.array(z.string()).optional().default([]),
    verification_status: z.string().optional().default(""),
    source: z.string().nullable().optional(),
  });

const ProfileEmployment = z
  .object({
    id: z.unknown().optional(),
    company: z.string(),
    role: z.string(),
    location: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    is_current: z.boolean().optional(),
    description: z.string().nullable().optional(),
  });

const ProfileSkill = z
  .object({
    name: z.string().optional().default(""),
    category: z.string().nullable().optional(),
    proficiency: z.string().nullable().optional(),
    years_experience: z.number().nullable().optional(),
    verified: z.boolean().optional().default(false),
  });

const ProfileEducation = z
  .object({
    degree: z.string().optional().default(""),
    field_of_study: z.string().optional().default(""),
    institution: z.string().optional().default(""),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
  });

export const CandidateProfileInput = z.object({
  id: z.string().optional(),
  full_name: z.string().optional().default(""),
  headline: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  target_titles: z.array(z.string()).optional().default([]),
  preferences: z.record(z.string(), z.unknown()).nullable().optional(),
  work_experience: z.array(ProfileEmployment).optional().default([]),
  verified_facts: z.array(ProfileFact).optional().default([]),
  skills: z.array(ProfileSkill).optional().default([]),
  education: z.array(ProfileEducation).optional().default([]),
});
export type CandidateProfileInput = z.infer<typeof CandidateProfileInput>;
export type ProfileFact = z.infer<typeof ProfileFact>;
export type ProfileEmployment = z.infer<typeof ProfileEmployment>;
export type ProfileSkill = z.infer<typeof ProfileSkill>;
export type ProfileEducation = z.infer<typeof ProfileEducation>;
