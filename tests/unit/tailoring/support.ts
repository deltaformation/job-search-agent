// @vitest-environment node
import { eq } from "drizzle-orm";
import {
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  utcNow,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import type { WorkHandlerContext } from "../../../src/queue/dispatch";
import { htmlBodyFragments } from "../../../src/resumes/checks";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import { CandidateProfileInput } from "../../../src/tailoring/schemas";
import { RESUME_PROPOSAL_SCHEMA_VERSION } from "../../../src/tailoring/contract";

/**
 * Shared R4-E fixtures: a rich candidate profile, JD text, and proposal
 * builder used by orchestration and handler tests. The proposal quotes
 * the JD exactly and cites approved facts, so the happy path validates.
 */

export const E2E_FACTS = {
  f_api: "Led the public API migration to TypeScript serving ten million daily requests.",
  f_auth: "Shipped single sign-on with SAML for forty enterprise tenants.",
  f_scale: "Reduced API latency by forty percent with caching and connection pooling.",
  f_team: "Mentored four engineers and established incident review practices.",
} as const;

export function e2eProfile(): CandidateProfileInput {
  return CandidateProfileInput.parse({
    id: "local",
    full_name: "Orchestration Candidate",
    headline: "Backend Engineer",
    email: "orchestration@example.com",
    phone: "+1-555-0100",
    location: "Toronto, ON",
    target_titles: ["Backend Engineer"],
    work_experience: [
      {
        id: "emp-1",
        company: "Acme",
        role: "Engineer",
        location: "Toronto, ON",
        start_date: "2020-01-15",
        end_date: "2022-06-30",
        is_current: false,
      },
      {
        id: "emp-2",
        company: "Beta",
        role: "Senior Engineer",
        location: "Remote",
        start_date: "2022-07-01",
        end_date: null,
        is_current: true,
      },
    ],
    verified_facts: [
      {
        fact_id: "f_api",
        work_experience_id: "emp-2",
        category: "experience",
        text: E2E_FACTS.f_api,
        technologies: ["TypeScript"],
        metrics: ["10M daily requests"],
        verification_status: "approved",
      },
      {
        fact_id: "f_auth",
        work_experience_id: "emp-2",
        category: "experience",
        text: E2E_FACTS.f_auth,
        technologies: ["SAML"],
        metrics: ["40 tenants"],
        verification_status: "approved",
      },
      {
        fact_id: "f_scale",
        work_experience_id: "emp-1",
        category: "experience",
        text: E2E_FACTS.f_scale,
        technologies: ["Redis"],
        metrics: ["40% lower latency"],
        verification_status: "approved",
      },
      {
        fact_id: "f_team",
        work_experience_id: "emp-1",
        category: "experience",
        text: E2E_FACTS.f_team,
        technologies: [],
        metrics: ["4 engineers"],
        verification_status: "approved",
      },
    ],
    skills: [
      { name: "TypeScript", category: "technical", proficiency: "expert", verified: true },
      { name: "SAML", category: "technical", proficiency: "proficient", verified: true },
      { name: "COBOL", category: "technical", proficiency: "beginner", verified: true },
      { name: "Rust", category: "technical", proficiency: "beginner", verified: false },
    ],
    education: [
      {
        degree: "B.Sc.",
        field_of_study: "Computer Science",
        institution: "Test University",
        start_date: "2014-09-01",
        end_date: "2018-05-31",
      },
    ],
  });
}

export const E2E_JD_TEXT =
  "We need TypeScript API experience and SAML single sign-on work. " +
  "Redis caching is a plus. COBOL migration experience is a plus, " +
  "Kubernetes deployment skills required.";

export function e2eProposal(jdSnapshotId: string, candidateSnapshotId: string): Record<string, unknown> {
  return {
    schemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
    jdSnapshotId,
    candidateSnapshotId,
    requirements: [
      {
        requirement_id: "req_api",
        jd_quote: "TypeScript API experience",
        category: "skill",
        importance: "required",
        match_status: "matched",
        evidence_fact_ids: ["f_api"],
        evidence_quotes: [E2E_FACTS.f_api],
        review_status: "confirmed",
      },
      {
        requirement_id: "req_auth",
        jd_quote: "SAML single sign-on work",
        category: "skill",
        importance: "required",
        match_status: "matched",
        evidence_fact_ids: ["f_auth"],
        evidence_quotes: [E2E_FACTS.f_auth],
        review_status: "confirmed",
      },
      {
        requirement_id: "req_cache",
        jd_quote: "Redis caching",
        category: "skill",
        importance: "preferred",
        match_status: "matched",
        evidence_fact_ids: ["f_scale"],
        evidence_quotes: [E2E_FACTS.f_scale],
        review_status: "confirmed",
      },
      {
        requirement_id: "req_cobol",
        jd_quote: "COBOL migration experience is a plus",
        category: "skill",
        importance: "preferred",
        match_status: "unsupported",
        evidence_fact_ids: [],
        evidence_quotes: [],
        review_status: "proposed",
      },
      {
        requirement_id: "req_k8s",
        jd_quote: "Kubernetes deployment skills required",
        category: "skill",
        importance: "required",
        match_status: "gap",
        evidence_fact_ids: [],
        evidence_quotes: [],
        review_status: "proposed",
      },
    ],
    rationale: "Three supported requirements mapped to approved facts; two gaps reported.",
    questions: [],
  };
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildMinimalPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    // Short text runs like a real renderer emits (giant single-line
    // runs under-extract in some parsers). Wrapping is invisible to
    // comparisons because checks strip all whitespace.
    const runs = text
      .split("\n")
      .flatMap((line) => {
        const wrapped: string[] = [];
        let rest = line;
        while (rest.length > 90) {
          let cut = rest.lastIndexOf(" ", 90);
          if (cut < 0) {
            cut = 90;
          }
          wrapped.push(rest.slice(0, cut));
          rest = rest.slice(cut + (rest[cut] === " " ? 1 : 0));
        }
        wrapped.push(rest);
        return wrapped;
      })
      .map((line) => `(${escapePdfText(line)}) Tj 0 -14 Td`)
      .join("\n");
    const stream = `BT /F1 10 Tf 72 720 Td\n${runs}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, "latin1");
}

/**
 * Stand-in PDF renderer for tests: extracts the HTML body fragments and
 * packs them into a one-page PDF, mirroring what a real render carries.
 * Tests assert the fragment precondition so this stub cannot go vacuous.
 */
export function stubRenderPdf(html: string): { bytes: Buffer } {
  const fragments = htmlBodyFragments(html);
  const text = fragments.join(" ");
  if (text.trim().length < 300) {
    throw new Error(`stub PDF precondition violated: only ${text.trim().length} fragment chars`);
  }
  return { bytes: buildMinimalPdf([fragments.join("\n")]) };
}

/**
 * Shared R4-E/R4-F database fixtures: profile import, job/extraction
 * seeding, and handler contexts. Moved here (exact bytes) so the
 * revision tests reuse the handler-test setup without duplication.
 */

export function importTestProfile(t: TestDatabase): string {
  const imported = importCandidate(t.handle, {
    document: {
      schemaVersion: "candidate-import/v1",
      identity: {
        fullName: "Orchestration Candidate",
        headline: "Backend Engineer",
        email: "orchestration@example.com",
        phone: "+1-555-0100",
        location: "Toronto, ON",
      },
      targetTitles: ["Backend Engineer"],
      employment: [
        {
          id: "emp-1",
          company: "Acme",
          role: "Engineer",
          location: "Toronto, ON",
          startDate: "2020-01-15",
          endDate: "2022-06-30",
          isCurrent: false,
        },
        {
          id: "emp-2",
          company: "Beta",
          role: "Senior Engineer",
          location: "Remote",
          startDate: "2022-07-01",
          isCurrent: true,
        },
      ],
      achievements: [
        {
          factId: "f_api",
          employmentId: "emp-2",
          category: "experience",
          text: "Led the public API migration to TypeScript serving ten million daily requests.",
          technologies: ["TypeScript"],
          metrics: ["10M daily requests"],
          verification: "APPROVED",
        },
        {
          factId: "f_auth",
          employmentId: "emp-2",
          category: "experience",
          text: "Shipped single sign-on with SAML for forty enterprise tenants.",
          technologies: ["SAML"],
          metrics: ["40 tenants"],
          verification: "APPROVED",
        },
        {
          factId: "f_scale",
          employmentId: "emp-1",
          category: "experience",
          text: "Reduced API latency by forty percent with caching and connection pooling.",
          technologies: ["Redis"],
          metrics: ["40% lower latency"],
          verification: "APPROVED",
        },
        {
          factId: "f_team",
          employmentId: "emp-1",
          category: "experience",
          text: "Mentored four engineers and established incident review practices.",
          technologies: [],
          metrics: ["4 engineers"],
          verification: "APPROVED",
        },
      ],
      skills: [
        { name: "TypeScript", verified: true },
        { name: "SAML", verified: true },
        { name: "COBOL", verified: true },
        { name: "Rust", verified: false },
      ],
      education: [
        {
          degree: "B.Sc.",
          fieldOfStudy: "Computer Science",
          institution: "Test University",
          startDate: "2014-09-01",
          endDate: "2018-05-31",
        },
      ],
    },
    actor: "human",
  });
  if (!imported.ok) {
    throw new Error(`profile import failed: ${imported.error}`);
  }
  const activated = activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" });
  if (!activated.ok) {
    throw new Error("profile activation failed");
  }
  return imported.versionId;
}

export function seedJob(t: TestDatabase, descriptionText: string): { jobId: string; extractionId: string } {
  const jobId = newId();
  t.handle.db
    .insert(jobs)
    .values({ id: jobId, title: "Backend Engineer", company: "Acme", status: "NEW", tailoringState: "READY" })
    .run();
  const attemptId = newId();
  t.handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: utcNow(),
      finishedAt: utcNow(),
      outcome: "SUCCEEDED",
    })
    .run();
  const extractionId = newId();
  t.handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "test",
      extractedJson: "{}",
    })
    .run();
  t.handle.db
    .update(jobs)
    .set({ descriptionText, activeExtractionId: extractionId })
    .where(eq(jobs.id, jobId))
    .run();
  return { jobId, extractionId };
}

export function addExtraction(t: TestDatabase, jobId: string): string {
  const attemptId = newId();
  t.handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: utcNow(),
      finishedAt: utcNow(),
      outcome: "SUCCEEDED",
    })
    .run();
  const extractionId = newId();
  t.handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 2,
      schemaVersion: "job-extraction-v1",
      adapter: "test",
      extractedJson: "{}",
    })
    .run();
  t.handle.db
    .update(jobs)
    .set({ activeExtractionId: extractionId })
    .where(eq(jobs.id, jobId))
    .run();
  return extractionId;
}

export function handlerContext(
  t: TestDatabase,
  workItemId: string,
  heartbeat: () => boolean = () => true,
): WorkHandlerContext {
  const item = t.handle.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  if (item === undefined) {
    throw new Error("work item missing");
  }
  return { handle: t.handle, item: { ...item, leaseToken: "test-lease" }, workerId: "test-worker", heartbeat };
}
