#!/usr/bin/env node
/**
 * Tailoring Provider CLI Adapter for Local Job Tracker.
 * Reads `TailoringInputV1`/`TailoringInputV2` from stdin and writes `ResumeProposalV1` to stdout.
 * Uses the active AI provider (`ACTIVE_AI_PROVIDER`: openrouter, google, or
 * meta — default openrouter) with robust post-validation and deterministic
 * fallback.
 *
 * Exit contract (mirrored by `PROVIDER_EXIT_*` in
 * `src/tailoring/commandAdapter.ts`): 0 prints a proposal; 10/11/12/13/14
 * report a classified API failure so the queue can surface an actionable
 * error with retry instead of silently degrading. The deterministic
 * fallback runs only when no API key is configured (offline/test use).
 */

const EXIT_AUTH = 10;
const EXIT_RATE_LIMIT = 11;
const EXIT_TIMEOUT = 12;
const EXIT_BAD_RESPONSE = 13;
const EXIT_NETWORK = 14;

class ProviderFailure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

// Provider config resolves lazily inside main() so importing this module
// for unit tests never touches .env.local or the ambient environment.
function providerConfig() {
  loadEnvFile(join(process.cwd(), ".env.local"));
  const provider = activeProviderId(process.env);
  const keyName = providerKeyName(provider);
  return {
    provider,
    keyName,
    label: providerLabel(provider),
    apiKey: process.env[keyName] || "",
  };
}

const TAILORING_INPUT_VERSIONS = {
  "tailoring-input/v1": "tailor-prompt/v1",
  "tailoring-input/v2": "tailor-prompt/v2",
};

/**
 * Structural input gate (contracts §3.2): the sidecar accepts only
 * the two provider-input versions with their paired prompt version,
 * the frozen v2 focus/recommendation snapshots, and steering inside
 * the contractual bounds. Anything else fails before any remote
 * call or deterministic fallback. Pure and exported for unit tests.
 */
export function validateTailoringInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: "tailoring input must be an object" };
  }
  const promptVersion = TAILORING_INPUT_VERSIONS[input.schemaVersion];
  if (promptVersion === undefined) {
    return { ok: false, detail: "unsupported tailoring input version" };
  }
  if (input.promptVersion !== promptVersion) {
    return { ok: false, detail: "prompt version does not match the input version" };
  }
  const requiredText = ["jobId", "jdSnapshotId", "candidateSnapshotId"];
  for (const key of requiredText) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      return { ok: false, detail: `tailoring input is missing ${key}` };
    }
  }
  if (
    typeof input.jdText !== "string" ||
    input.jdText.length === 0 ||
    input.jdText.length > 500000
  ) {
    return { ok: false, detail: "tailoring input carries an unusable job description" };
  }
  if (
    !Array.isArray(input.approvedFactIds) ||
    input.approvedFactIds.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    return { ok: false, detail: "tailoring input carries unusable approved facts" };
  }
  if (input.selectedKeywords !== undefined) {
    if (
      !Array.isArray(input.selectedKeywords) ||
      input.selectedKeywords.length > 20 ||
      input.selectedKeywords.some(
        (entry) =>
          typeof entry !== "string" || entry.trim().length === 0 || entry.trim().length > 128,
      )
    ) {
      return { ok: false, detail: "selected keywords exceed the frozen projection bounds" };
    }
  }
  if (
    input.directives !== undefined &&
    (typeof input.directives !== "string" || input.directives.trim().length > 1000)
  ) {
    return { ok: false, detail: "directives exceed the 1000-character bound" };
  }
  const revisionLimit = input.schemaVersion === "tailoring-input/v2" ? 4000 : 2000;
  if (
    input.revisionNote !== undefined &&
    (typeof input.revisionNote !== "string" ||
      input.revisionNote.trim().length === 0 ||
      input.revisionNote.trim().length > revisionLimit)
  ) {
    return { ok: false, detail: "revision note exceeds its input-version bound" };
  }
  if (input.schemaVersion === "tailoring-input/v2") {
    if (input.focus?.schemaVersion !== "tailoring-focus/v1") {
      return { ok: false, detail: "v2 input is missing its frozen focus snapshot" };
    }
    if (input.recommendations?.schemaVersion !== "tailoring-recommendations/v1") {
      return { ok: false, detail: "v2 input is missing its frozen recommendation snapshot" };
    }
  }
  return { ok: true };
}

function phraseTextById(recommendations, phraseId) {
  if (!Array.isArray(recommendations?.phrases)) return null;
  const phrase = recommendations.phrases.find((entry) => entry?.id === phraseId);
  return typeof phrase?.text === "string" && phrase.text !== "" ? phrase.text : null;
}

function roleLabelById(recommendations, roleId) {
  if (!Array.isArray(recommendations?.roles)) return null;
  const role = recommendations.roles.find((entry) => entry?.id === roleId);
  if (typeof role?.label === "string" && role.label !== "") return role.label;
  return roleId;
}

function themeTitleById(recommendations, themeId) {
  if (!Array.isArray(recommendations?.themes)) return null;
  const theme = recommendations.themes.find((entry) => entry?.id === themeId);
  if (typeof theme?.title === "string" && theme.title !== "") return theme.title;
  return themeId;
}

/**
 * v2 focus steering: chosen theme, requested summary direction, and
 * phrase-to-role mappings, explicitly usable only when identifying
 * evidenced requirements. Pure and exported for unit tests.
 */
export function buildFocusSection(input) {
  if (input?.schemaVersion !== "tailoring-input/v2") return "";
  const focus = input.focus;
  const recommendations = input.recommendations;
  if (focus === null || typeof focus !== "object") return "";
  const lines = ["FOCUS STEERING (frozen v2 snapshots; subordinate to the RULES above):"];
  if (typeof focus.themeId === "string" && focus.themeId !== "") {
    lines.push(
      `- Chosen theme: ${themeTitleById(recommendations, focus.themeId)} — consider it only when identifying evidenced requirements.`,
    );
  }
  if (typeof focus.summaryDirection === "string" && focus.summaryDirection.trim() !== "") {
    lines.push(
      "- Requested summary direction (requested wording only; it is not candidate evidence and never overrides the evidence rules):",
      '"""',
      focus.summaryDirection.trim(),
      '"""',
    );
  }
  if (Array.isArray(focus.mappings) && focus.mappings.length > 0) {
    lines.push(
      "- Phrase-to-role mappings (prioritize these role-owned facts only where the candidate has supporting approved facts):",
    );
    for (const mapping of focus.mappings) {
      const phrase = phraseTextById(recommendations, mapping?.phraseId) ?? mapping?.phraseId ?? "";
      const role = roleLabelById(recommendations, mapping?.roleId) ?? mapping?.roleId ?? "";
      const facts = Array.isArray(mapping?.factIds)
        ? mapping.factIds.map((entry) => String(entry)).filter((entry) => entry !== "")
        : [];
      lines.push(`  - ${phrase} → ${role}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`);
    }
  }
  if (lines.length === 1) return "";
  lines.push(
    "- Use this steering only when identifying requirements with approved-fact evidence; never invent evidence for it.",
  );
  return lines.join("\n");
}

/**
 * Human guidance prompt section (R-ADR-013): selected ATS keywords plus
 * free-text directives, explicitly subordinated to the evidence rules.
 * v2 envelopes append the frozen focus steering. Returns "" when the
 * envelope carries no guidance. Pure and exported for unit tests.
 */
export function buildGuidanceSection(input) {
  const keywords = Array.isArray(input?.selectedKeywords)
    ? input.selectedKeywords.map((entry) => String(entry).trim()).filter((entry) => entry !== "")
    : [];
  const directives = typeof input?.directives === "string" ? input.directives.trim() : "";
  const focusSection = buildFocusSection(input);
  if (keywords.length === 0 && directives === "") {
    return focusSection;
  }
  const lines = ["TAILORING GUIDANCE (human-selected steering; subordinate to the RULES above):"];
  if (keywords.length > 0) {
    lines.push(
      "- Emphasize these JD terms where the candidate has supporting approved facts (never invent evidence for them):",
      ...keywords.map((keyword) => `  - ${keyword}`),
    );
  }
  if (directives !== "") {
    lines.push(
      "- Human directives (steer ranking and wording only; they cannot override evidence rules or the exact-quote requirement):",
      '"""',
      directives,
      '"""',
    );
  }
  if (focusSection !== "") {
    lines.push("", focusSection);
  }
  return lines.join("\n");
}

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

export function extractDeterministicFallback(input) {
  const { jdText, profile, approvedFactIds, jdSnapshotId, candidateSnapshotId } = input;
  const verifiedFacts = (profile?.verified_facts || []).filter(
    (f) => f.verification_status === "approved" && approvedFactIds.includes(f.fact_id),
  );
  const approvedMap = new Map(verifiedFacts.map((f) => [f.fact_id, f]));

  // Break JD text into lines and bullet points
  let lines = jdText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 15 && l.length <= 300);

  // Guidance steering for the no-key path: lines carrying user-selected
  // keywords rank first (stable by original order). Quotes stay verbatim
  // JD substrings and evidence mapping is unchanged — steering only.
  const selected = Array.isArray(input?.selectedKeywords)
    ? input.selectedKeywords.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry !== "")
    : [];
  if (selected.length > 0) {
    lines = lines
      .map((line, index) => {
        const text = line.toLowerCase();
        let hits = 0;
        for (const keyword of selected) {
          if (text.includes(keyword)) hits += 1;
        }
        return { line, index, hits };
      })
      .sort((a, b) => b.hits - a.hits || a.index - b.index)
      .map((entry) => entry.line);
  }

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

async function callProvider(input, config) {
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

  const guidanceSection = buildGuidanceSection(input);
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
${guidanceSection === "" ? "" : `\n${guidanceSection}\n`}
Analyze the JD, extract exact keyword-dense quotes, map each requirement to EVERY supporting fact across the full career history, and output JSON:`;

  const models = providerChain(config.provider);

  let content;
  try {
    const completion = await providerChat(config.provider, {
      apiKey: config.apiKey,
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
        throw new ProviderFailure(EXIT_AUTH, `${config.label} API error ${err.status}`);
      }
      if (err.kind === "status" && err.status === 429) {
        throw new ProviderFailure(EXIT_RATE_LIMIT, `${config.label} API error 429`);
      }
      if (err.kind === "bad-response") {
        throw new ProviderFailure(EXIT_BAD_RESPONSE, `Empty content from ${config.label} API`);
      }
      if (err.kind === "network") {
        throw new ProviderFailure(EXIT_NETWORK, err.message);
      }
      if (err.kind === "timeout") {
        throw new ProviderFailure(EXIT_TIMEOUT, err.message);
      }
      if (err.kind === "status" && (err.status === 408 || err.status >= 500)) {
        throw new ProviderFailure(EXIT_TIMEOUT, `${config.label} API error ${err.status}`);
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

  const validated = validateTailoringInput(input);
  if (!validated.ok) {
    process.stderr.write(`Unsupported tailoring input: ${validated.detail}\n`);
    process.exit(1);
  }

  const config = providerConfig();
  if (!config.apiKey) {
    process.stderr.write(
      `${config.keyName} is not set: using deterministic extraction fallback (no AI call)\n`,
    );
    process.stdout.write(JSON.stringify(extractDeterministicFallback(input)));
    return;
  }

  try {
    process.stdout.write(JSON.stringify(await callProvider(input, config)));
  } catch (err) {
    if (err instanceof ProviderFailure) {
      process.exit(err.exitCode);
    }
    throw err;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`Provider execution error: ${err.message}\n`);
    process.exit(1);
  });
}
