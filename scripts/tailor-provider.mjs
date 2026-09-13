#!/usr/bin/env node
/**
 * Tailoring Provider CLI Adapter for Local Job Tracker.
 * Reads `TailoringInputV1` from stdin and writes `ResumeProposalV1` to stdout.
 * Uses the active AI provider (`ACTIVE_AI_PROVIDER`: openrouter, google, or
 * meta — default openrouter) with robust post-validation and deterministic
 * fallback.
 *
 * Exit contract (mirrored by `PROVIDER_EXIT_*` in
 * `src/tailoring/commandAdapter.ts`): 0 prints a proposal; 10/11/12/13
 * report a classified API failure so the queue can surface an actionable
 * error with retry instead of silently degrading. The deterministic
 * fallback runs only when no API key is configured (offline/test use).
 */

const EXIT_AUTH = 10;
const EXIT_RATE_LIMIT = 11;
const EXIT_TIMEOUT = 12;
const EXIT_BAD_RESPONSE = 13;

class ProviderFailure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeProviderId,
  providerChain,
  providerChat,
  providerKeyName,
  providerLabel,
} from "./ai-provider.mjs";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// Load .env.local if present
loadEnvFile(join(process.cwd(), ".env.local"));

const PROVIDER = activeProviderId(process.env);
const PROVIDER_KEY_NAME = providerKeyName(PROVIDER);
const PROVIDER_LABEL = providerLabel(PROVIDER);
const PROVIDER_API_KEY = process.env[PROVIDER_KEY_NAME] || "";

const VALID_CATEGORIES = [
  "experience",
  "skill",
  "responsibility",
  "domain",
  "location",
  "compensation",
  "screening",
  "other",
];

const VALID_IMPORTANCE = ["required", "preferred", "unspecified"];
const VALID_MATCH_STATUS = ["matched", "partial", "gap", "unsupported"];

function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function findExactSubstring(jdText, candidateQuote) {
  if (!candidateQuote || typeof candidateQuote !== "string") return null;
  const trimmed = candidateQuote.trim();
  if (jdText.includes(trimmed)) {
    return trimmed;
  }
  // Try removing wrapping quotes or markdown punctuation
  const clean = trimmed.replace(/^["'•\-\*\s]+|["'•\-\*\s]+$/g, "");
  if (clean.length > 5 && jdText.includes(clean)) {
    return clean;
  }
  // Try finding by normalized whitespace
  const normWords = clean.split(/\s+/).filter(Boolean);
  if (normWords.length >= 3) {
    const firstTwo = normWords.slice(0, 2).join(" ");
    let idx = jdText.indexOf(firstTwo);
    while (idx !== -1) {
      // Find where the sentence or clause ends in jdText
      const slice = jdText.slice(idx, idx + clean.length + 50);
      const endMatch = slice.match(/[\n\.\;\r]/);
      const matchLen = endMatch ? endMatch.index : slice.length;
      const candidate = slice.slice(0, matchLen).trim();
      if (candidate.length > 5 && jdText.includes(candidate)) {
        return candidate;
      }
      idx = jdText.indexOf(firstTwo, idx + 1);
    }
  }
  return null;
}

function extractDeterministicFallback(input) {
  const { jdText, profile, approvedFactIds, jdSnapshotId, candidateSnapshotId } = input;
  const verifiedFacts = (profile?.verified_facts || []).filter(
    (f) => f.verification_status === "approved" && approvedFactIds.includes(f.fact_id),
  );
  const approvedMap = new Map(verifiedFacts.map((f) => [f.fact_id, f]));

  // Break JD text into lines and bullet points
  const lines = jdText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 15 && l.length <= 300);

  const requirements = [];
  let reqIndex = 1;

  for (const line of lines) {
    if (requirements.length >= 10) break;
    // Check if line looks like a requirement or responsibility
    const isBullet = /^[-*•\d]/.test(line);
    const hasReqKeyword = /(?:experience|responsible|manage|lead|product|build|scale|strategy|discovery|agile|skills|years|bachelor|degree)/i.test(
      line,
    );
    if (!isBullet && !hasReqKeyword) continue;

    const quote = line.replace(/^[-*•\d.)\s]+/, "").trim();
    if (!quote || quote.length < 10 || !jdText.includes(quote)) continue;

    // Match against candidate facts
    const quoteLower = quote.toLowerCase();
    const matchedFactIds = [];

    for (const [factId, fact] of approvedMap.entries()) {
      const factText = fact.text.toLowerCase();
      const techMatch = (fact.technologies || []).some(
        (t) => quoteLower.includes(t.toLowerCase()) && t.length > 2,
      );
      const words = quoteLower.split(/\W+/).filter((w) => w.length > 4);
      const overlap = words.filter((w) => factText.includes(w)).length;

      if (techMatch || overlap >= 2) {
        matchedFactIds.push(factId);
      }
    }

    const importance = /(?:preferred|plus|bonus|nice to have)/i.test(quote)
      ? "preferred"
      : "required";
    const category = /(?:degree|bachelor|master|education)/i.test(quote)
      ? "screening"
      : /(?:domain|banking|bfsi|retail|saas|fintech)/i.test(quote)
        ? "domain"
        : /(?:lead|manage|mentor|hire|team|agile)/i.test(quote)
          ? "responsibility"
          : "skill";

    if (matchedFactIds.length > 0) {
      const chosenIds = matchedFactIds.slice(0, 5);
      requirements.push({
        requirement_id: `req_${String(reqIndex++).padStart(3, "0")}`,
        jd_quote: quote,
        category,
        importance,
        match_status: "partial",
        evidence_fact_ids: chosenIds,
        evidence_quotes: chosenIds.map((id) => approvedMap.get(id).text),
        review_status: "proposed",
      });
    } else {
      requirements.push({
        requirement_id: `req_${String(reqIndex++).padStart(3, "0")}`,
        jd_quote: quote,
        category,
        importance,
        match_status: "gap",
        evidence_fact_ids: [],
        evidence_quotes: [],
        review_status: "proposed",
      });
    }
  }

  // Ensure at least 3 requirements exist
  if (requirements.length < 3) {
    const rawSentences = jdText.match(/[^.!?]+[.!?]+/g) || [jdText];
    for (const s of rawSentences) {
      if (requirements.length >= 5) break;
      const clean = s.trim();
      if (clean.length > 20 && jdText.includes(clean)) {
        requirements.push({
          requirement_id: `req_${String(reqIndex++).padStart(3, "0")}`,
          jd_quote: clean,
          category: "experience",
          importance: "required",
          match_status: "gap",
          evidence_fact_ids: [],
          evidence_quotes: [],
          review_status: "proposed",
        });
      }
    }
  }

  return {
    schemaVersion: "resume-proposal/v1",
    jdSnapshotId,
    candidateSnapshotId,
    requirements,
    rationale: `Deterministic tailoring analysis matched ${
      requirements.filter((r) => r.match_status === "matched").length
    } of ${requirements.length} extracted requirements against verified candidate profile facts.`,
    questions: [],
  };
}

async function callProvider(input) {
  const { jobTitle, company, jdText, profile, approvedFactIds, jdSnapshotId, candidateSnapshotId } = input;
  const verifiedFacts = (profile?.verified_facts || []).filter(
    (f) => f.verification_status === "approved" && approvedFactIds.includes(f.fact_id),
  );
  const approvedMap = new Map(verifiedFacts.map((f) => [f.fact_id, f]));

  const candidateFactsPrompt = verifiedFacts
    .map(
      (f) =>
        `- Fact ID: ${f.fact_id} | Category: ${f.category} | Text: "${f.text}" | Technologies: [${(f.technologies || []).join(", ")}]`,
    )
    .join("\n");

  const systemMessage = `You are an expert resume tailoring and ATS alignment analyst.
Your task is to analyze the Job Description (JD) and match its requirements against the candidate's approved facts.

RULES:
1. Extract 6 to 12 key requirements from the JD. First identify the JD's TOP 5 most important keywords (hard skills, technologies, tools, certifications, domains — never generic soft skills like "team player"), then prefer requirement quotes that contain them, using the JD's exact wording and capitalization, so the tailored resume aligns with ATS keyword matching.
2. For each requirement:
   - "requirement_id": "req_001", "req_002", etc.
   - "jd_quote": MUST be an EXACT VERBATIM substring copied directly from the JD text. Do NOT modify or paraphrase. Prefer keyword-dense substrings (the ones carrying the JD's most important terms) over generic sentences.
   - "category": one of ["experience", "skill", "responsibility", "domain", "location", "compensation", "screening", "other"]
   - "importance": one of ["required", "preferred", "unspecified"]
   - "match_status": "matched" (direct candidate evidence), "partial" (some candidate evidence), "gap" (missing/unmet requirement), or "unsupported"
   - "evidence_fact_ids": list EVERY candidate fact ID that supports this requirement across the candidate's FULL career history (e.g. ["fact_ibm_001", "fact_aot_003"]). Do NOT stop at the first match: comprehensive evidence mapping directly improves keyword coverage and bullet prioritization. If match_status is "gap" or "unsupported", MUST be [].
3. "rationale": a 1-2 sentence overview of candidate fit.
4. Output ONLY JSON in this exact structure:
{
  "requirements": [
    {
      "requirement_id": "req_001",
      "jd_quote": "<exact substring>",
      "category": "experience",
      "importance": "required",
      "match_status": "matched",
      "evidence_fact_ids": ["fact_xxx"]
    }
  ],
  "rationale": "<summary>"
}`;

  const userMessage = `JOB TITLE: ${jobTitle || "Not specified"}
COMPANY: ${company || "Not specified"}

JOB DESCRIPTION:
\"\"\"
${jdText.slice(0, 15000)}
\"\"\"

CANDIDATE APPROVED FACTS:
\"\"\"
${candidateFactsPrompt}
\"\"\"

Analyze the JD, extract exact keyword-dense quotes, map each requirement to EVERY supporting fact across the full career history, and output JSON:`;

  const models = providerChain(PROVIDER);

  let content;
  try {
    const completion = await providerChat(PROVIDER, {
      apiKey: PROVIDER_API_KEY,
      models,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      timeoutMs: 60000,
      diagnose: (line) => process.stderr.write(`${line}\n`),
    });
    content = completion.content;
  } catch (err) {
    // Every client throws { kind, status, message }; branch on the shape
    // so all providers share one exit-code contract.
    if (err !== null && typeof err === "object" && typeof err.kind === "string") {
      if (err.kind === "status" && (err.status === 401 || err.status === 402 || err.status === 403)) {
        throw new ProviderFailure(EXIT_AUTH, `${PROVIDER_LABEL} API error ${err.status}`);
      }
      if (err.kind === "status" && err.status === 429) {
        throw new ProviderFailure(EXIT_RATE_LIMIT, `${PROVIDER_LABEL} API error 429`);
      }
      if (err.kind === "bad-response") {
        throw new ProviderFailure(EXIT_BAD_RESPONSE, `Empty content from ${PROVIDER_LABEL} API`);
      }
      if (err.kind === "timeout" || err.kind === "network") {
        throw new ProviderFailure(EXIT_TIMEOUT, err.message);
      }
      if (err.kind === "status" && (err.status === 408 || err.status >= 500)) {
        throw new ProviderFailure(EXIT_TIMEOUT, `${PROVIDER_LABEL} API error ${err.status}`);
      }
      throw new ProviderFailure(EXIT_BAD_RESPONSE, err.message);
    }
    throw err;
  }

  {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Clean possible markdown code fence
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        process.stderr.write("Failed to parse JSON from LLM response\n");
        throw new ProviderFailure(EXIT_BAD_RESPONSE, "Failed to parse JSON from LLM response");
      }
    }

    if (!Array.isArray(parsed?.requirements) || parsed.requirements.length === 0) {
      process.stderr.write("LLM response did not contain requirements array\n");
      throw new ProviderFailure(EXIT_BAD_RESPONSE, "LLM response did not contain requirements");
    }

    // Post-process and strictly validate
    const validatedRequirements = [];
    let reqIdx = 1;

    for (const rawReq of parsed.requirements) {
      let quote = findExactSubstring(jdText, rawReq.jd_quote);
      if (!quote) {
        // Search for any matching line in jdText
        continue;
      }

      const reqId = `req_${String(reqIdx++).padStart(3, "0")}`;
      const category = VALID_CATEGORIES.includes(rawReq.category)
        ? rawReq.category
        : "experience";
      const importance = VALID_IMPORTANCE.includes(rawReq.importance)
        ? rawReq.importance
        : "required";

      let matchStatus = VALID_MATCH_STATUS.includes(rawReq.match_status)
        ? rawReq.match_status
        : "gap";

      let factIds = (Array.isArray(rawReq.evidence_fact_ids)
        ? rawReq.evidence_fact_ids
        : []
      ).filter((fid) => approvedMap.has(fid));

      if (factIds.length > 0) {
        matchStatus = "partial";
      } else {
        matchStatus = "gap";
        factIds = [];
      }

      const evidenceQuotes = factIds.map((fid) => approvedMap.get(fid).text);

      validatedRequirements.push({
        requirement_id: reqId,
        jd_quote: quote,
        category,
        importance,
        match_status: matchStatus,
        evidence_fact_ids: factIds,
        evidence_quotes: evidenceQuotes,
        review_status: "proposed",
      });
    }

    if (validatedRequirements.length < 3) {
      process.stderr.write("Fewer than 3 validated requirements from LLM\n");
      throw new ProviderFailure(EXIT_BAD_RESPONSE, "Fewer than 3 validated requirements from LLM");
    }

    return {
      schemaVersion: "resume-proposal/v1",
      jdSnapshotId,
      candidateSnapshotId,
      requirements: validatedRequirements,
      rationale: (parsed.rationale || "AI tailored alignment analysis based on candidate verified facts.").slice(0, 1000),
      questions: [],
    };
  }
}

async function main() {
  const rawInput = await readAllStdin();
  if (!rawInput.trim()) {
    process.stderr.write("Empty stdin received\n");
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    process.stderr.write(`Invalid JSON on stdin: ${err.message}\n`);
    process.exit(1);
  }

  if (!PROVIDER_API_KEY) {
    process.stderr.write(
      `${PROVIDER_KEY_NAME} is not set: using deterministic extraction fallback (no AI call)\n`,
    );
    process.stdout.write(JSON.stringify(extractDeterministicFallback(input)));
    return;
  }

  try {
    process.stdout.write(JSON.stringify(await callProvider(input)));
  } catch (err) {
    if (err instanceof ProviderFailure) {
      process.exit(err.exitCode);
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`Provider execution error: ${err.message}\n`);
  process.exit(1);
});
