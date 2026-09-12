import type { CandidateSnapshotV1 } from "../domain/candidate";
import { CandidateProfileInput } from "./schemas";

/**
 * Storage-to-port adapter: the single boundary where R4-A snapshot rows
 * become the R4-C candidate read model. R4-A stores camelCase payloads;
 * the truthfulness port consumes the oracle's snake_case vocabulary.
 * Snapshots embed approved facts only, so every mapped fact carries
 * `verification_status: "approved"`; the deterministic validator still
 * re-checks membership at generation time.
 */

export const LOCAL_CANDIDATE_ID = "local";

export function adaptSnapshotProfile(snapshot: CandidateSnapshotV1): CandidateProfileInput {
  return CandidateProfileInput.parse({
    id: LOCAL_CANDIDATE_ID,
    full_name: snapshot.payload.identity.fullName,
    headline: snapshot.payload.identity.headline ?? null,
    summary: snapshot.payload.summary ?? null,
    email: snapshot.payload.identity.email ?? null,
    phone: snapshot.payload.identity.phone ?? null,
    location: snapshot.payload.identity.location ?? null,
    target_titles: snapshot.payload.targetTitles,
    work_experience: snapshot.payload.employment.map((entry) => ({
      id: entry.id,
      company: entry.company,
      role: entry.role,
      location: entry.location ?? null,
      start_date: entry.startDate,
      end_date: entry.endDate ?? null,
      is_current: entry.isCurrent,
      description: entry.description ?? null,
    })),
    verified_facts: snapshot.facts.map((fact) => ({
      fact_id: fact.factId,
      work_experience_id: fact.evidence?.employmentId ?? null,
      category: fact.evidence?.category ?? fact.kind,
      text: fact.statement,
      technologies: fact.evidence?.technologies ?? [],
      metrics: fact.evidence?.metrics ?? [],
      verification_status: "approved",
      source: fact.source ?? null,
    })),
    skills: snapshot.payload.skills.map((skill) => ({
      name: skill.name,
      category: skill.category ?? null,
      proficiency: skill.proficiency ?? null,
      years_experience: skill.yearsExperience ?? null,
      verified: skill.verified,
    })),
    education: snapshot.payload.education.map((entry) => ({
      degree: entry.degree,
      field_of_study: entry.fieldOfStudy ?? "",
      institution: entry.institution,
      start_date: entry.startDate ?? null,
      end_date: entry.endDate ?? null,
    })),
  });
}
