import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import MasterPreview from "../../../../components/settings/MasterPreview";

/**
 * WO-1.2-C: the full preview renders every stored section — identity
 * with links, summary, grouped experience, skills, languages,
 * education, credentials — with verification as text and an explicit
 * omission note.
 */

const payload = {
  identity: {
    fullName: "Alex Rivera",
    headline: "Senior PM",
    email: "alex@example.com",
    links: {
      linkedin: "https://linkedin.example/alex",
      github: "https://github.example/alex",
    },
  },
  targetTitles: ["Senior PM"],
  targetLocations: ["Remote"],
  summary: "Eight years of example product work.",
  employment: [
    {
      id: "emp-1",
      company: "Acme",
      role: "Senior PM",
      startDate: "2021-03-01",
      isCurrent: true,
    },
  ],
  achievements: [
    {
      factId: "fact-1",
      employmentId: "emp-1",
      category: "launch",
      text: "Launched the hub.",
      technologies: ["TypeScript"],
      metrics: ["40 teams"],
      verification: "APPROVED",
    },
    {
      factId: "fact-2",
      category: "delivery",
      text: "Unassigned win.",
      technologies: [],
      metrics: [],
      verification: "PENDING",
    },
  ],
  skills: [{ name: "SQL", category: "technical", proficiency: "expert", verified: true }],
  languages: [{ name: "French", proficiency: "beginner", verified: false }],
  education: [
    { degree: "B.Sc.", fieldOfStudy: "CS", institution: "Example University" },
  ],
  credentials: [{ name: "Example Cert", issuer: "Example Institute", credentialId: "EX-1" }],
};

it("renders every section with links, languages, and credentials", () => {
  render(<MasterPreview payload={payload} />);
  expect(screen.getByRole("heading", { name: "Alex Rivera" })).toBeVisible();
  expect(screen.getByText(/linkedin\.example\/alex/)).toBeVisible();
  expect(screen.getByText(/github\.example\/alex/)).toBeVisible();
  for (const section of ["Summary", "Experience", "Skills", "Languages", "Education", "Credentials"]) {
    expect(screen.getByRole("region", { name: section })).toBeVisible();
  }
  expect(screen.getByText(/Launched the hub/)).toBeVisible();
  expect(screen.getByText(/fact-1 · Approved/)).toBeVisible();
  expect(screen.getByText(/fact-2 · Pending review/)).toBeVisible();
  expect(screen.getByText(/40 teams/)).toBeVisible();
  expect(screen.getByText(/SQL/)).toBeVisible();
  expect(screen.getByText(/French/)).toBeVisible();
  expect(screen.getByText(/B\.Sc\./)).toBeVisible();
  expect(screen.getByText(/Example Cert/)).toBeVisible();
  expect(screen.getByText(/Projection note:/)).toBeVisible();
});

it("omits empty sections without inventing content", () => {
  render(
    <MasterPreview
      payload={{
        ...payload,
        summary: undefined,
        skills: [],
        languages: [],
        education: [],
        credentials: [],
      }}
    />,
  );
  expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Skills" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Languages" })).toBeNull();
  expect(screen.getByRole("region", { name: "Experience" })).toBeVisible();
});
