// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CandidateSnapshotV1 } from "../../../src/domain/candidate";
import { adaptSnapshotProfile, LOCAL_CANDIDATE_ID } from "../../../src/tailoring/adapt";

function snapshot(overrides: Partial<CandidateSnapshotV1> = {}): CandidateSnapshotV1 {
  return {
    schemaVersion: "candidate-snapshot/v1",
    profileVersionId: "pv-1",
    version: 1,
    payloadHash: "a".repeat(64),
    payload: {
      schemaVersion: "candidate-profile/v1",
      identity: { fullName: "Ada Example" },
      targetTitles: ["Engineer"],
      targetLocations: [],
      summary: "Seasoned engineer.",
      employment: [
        {
          id: "emp-1",
          company: "Acme",
          role: "Engineer",
          startDate: "2020-01-15",
          isCurrent: true,
        },
      ],
      achievements: [],
      skills: [{ name: "TypeScript", verified: true }],
      education: [{ degree: "B.Sc.", institution: "Test U" }],
      credentials: [],
    },
    facts: [
      {
        factId: "f1",
        kind: "experience",
        statement: "Built things.",
        evidence: {
          schemaVersion: "fact-evidence/v1",
          employmentId: "emp-1",
          category: "experience",
          technologies: ["TypeScript"],
          metrics: ["2x"],
        },
        source: null,
        verification: "APPROVED",
      },
    ],
    ...overrides,
  };
}

describe("snapshot adapter", () => {
  it("maps storage rows to the port's read model", () => {
    const profile = adaptSnapshotProfile(snapshot());
    expect(profile.id).toBe(LOCAL_CANDIDATE_ID);
    expect(profile.full_name).toBe("Ada Example");
    expect(profile.headline).toBeNull();
    expect(profile.summary).toBe("Seasoned engineer.");
    expect(profile.target_titles).toEqual(["Engineer"]);
    expect(profile.work_experience).toEqual([
      {
        id: "emp-1",
        company: "Acme",
        role: "Engineer",
        location: null,
        start_date: "2020-01-15",
        end_date: null,
        is_current: true,
        description: null,
      },
    ]);
    expect(profile.verified_facts).toEqual([
      {
        fact_id: "f1",
        work_experience_id: "emp-1",
        category: "experience",
        text: "Built things.",
        technologies: ["TypeScript"],
        metrics: ["2x"],
        verification_status: "approved",
        source: null,
      },
    ]);
    expect(profile.skills).toEqual([
      { name: "TypeScript", category: null, proficiency: null, years_experience: null, verified: true },
    ]);
    expect(profile.education).toEqual([
      {
        degree: "B.Sc.",
        field_of_study: "",
        institution: "Test U",
        start_date: null,
        end_date: null,
      },
    ]);
  });

  it("tolerates missing evidence and optional identity fields", () => {
    const profile = adaptSnapshotProfile(
      snapshot({
        facts: [
          {
            factId: "f2",
            kind: "award",
            statement: "Won an award.",
            evidence: null,
            source: "employer",
            verification: "APPROVED",
          },
        ],
      }),
    );
    expect(profile.verified_facts).toEqual([
      {
        fact_id: "f2",
        work_experience_id: null,
        category: "award",
        text: "Won an award.",
        technologies: [],
        metrics: [],
        verification_status: "approved",
        source: "employer",
      },
    ]);
    expect(profile.email).toBeNull();
    expect(profile.phone).toBeNull();
    expect(profile.location).toBeNull();
  });
});
