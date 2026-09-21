/**
 * Step 2 preparation provider sidecar (WO-1.3-S2-B, S2-A §9).
 *
 * Reads one `preparation-input/v2` envelope on stdin, calls the
 * configured provider through the existing `ai-provider.mjs`
 * dispatch, and writes one `preparation-proposal/v2` envelope on
 * stdout. Same exit contract as the tailor sidecar (10–14; 1 for
 * local usage failures), same stderr diagnostics discipline (paths
 * and codes, never prompt or response bytes).
 *
 * Safety notes:
 * - No deterministic fallback exists here: without a configured
 *   key the sidecar exits 10 (the handler also refuses to call it,
 *   and services refuse to queue).
 * - The model proposes quote TEXT; this sidecar verifies each
 *   quote as an exact substring of the full canonical JD and
 *   computes UTF-8 byte offsets itself. Model byte arithmetic is
 *   never trusted. Quotes that do not occur verbatim are dropped
 *   (the worker would drop them anyway).
 * - The model links angles/suggestions to priorities by verbatim
 *   quote text (`priorityQuotes`); this sidecar resolves those
 *   quotes to priority ids itself. Model-provided ids, hashes,
 *   provenance, scores, and paths are never trusted — the
 *   emitted envelope is constructed literally, extras ignored.
 * - The full canonical JD is sent untruncated: quote offsets index
 *   it from byte 0, so any truncation would invalidate every span.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  activeProviderId,
  providerChain,
  providerChat,
  providerKeyName,
  providerLabel,
} from "./ai-provider.mjs";

export const EXIT_AUTH = 10;
export const EXIT_RATE_LIMIT = 11;
export const EXIT_TIMEOUT = 12;
// 13/14 must match the adapter contract (`PROVIDER_EXIT_*` in
// src/tailoring/commandAdapter.ts) and tailor-provider.mjs:
// BAD_RESPONSE is 13, NETWORK is 14. They were swapped here,
// mislabeling unusable model output as a network failure.
export const EXIT_BAD_RESPONSE = 13;
export const EXIT_NETWORK = 14;

export class ProviderFailure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Normative `prepare-prompt/v1` system text (S2-A §9). Retired by
 * WO-1.3-S2-CP-B: the adapter sends `prepare-prompt/v2` only.
 * Kept byte-identical for historical reference; never edited.
 */
export const PREPARE_PROMPT_V1 = `You are a resume preparation analyst. Quote job requirements exactly and propose resume angles and bullets grounded ONLY in the supplied approved facts.

RULES:
1. Every priority quote must be a verbatim substring of the JOB DESCRIPTION text below, using its exact wording and capitalization. Do NOT modify or paraphrase. Prefer keyword-dense multiword phrases (hard skills, technologies, tools, domains) over generic sentences.
2. For each priority supply: the quote text, how many times it occurs (count), a category, importance (required, preferred, or unspecified — ranked by importance to the role, independent of candidate support), advisory support (matched, partial, gap, or unsupported — graded honestly; deterministic code recomputes it), and the fact ids it rests on (empty when gap/unsupported).
3. Rank priorities by importance to the role (required first). Fewer than three priorities is acceptable when the description is sparse; never pad with boilerplate.
4. Propose at most two positioning angles: each has a short title, a 1-2 sentence summary, and the fact ids it rests on. Angles must be textually distinct from each other and from the master summary.
5. Propose role-specific bullet suggestions: each names the role id it belongs to, the bullet text, and the fact ids it rests on. Never invent metrics, technologies, employers, dates, or responsibilities; never move experience across employers.
6. Prefer reusing fact and master-bullet wording verbatim; keep cited fact ids exact. Deterministic validation decides support, not this proposal.
7. Output strict JSON only, matching this structure (no scores, paths, or approval assertions):
{
  "priorities": [
    {
      "quote": "<exact JD substring>",
      "count": 1,
      "category": "skill",
      "importance": "required",
      "matchStatus": "matched",
      "factIds": ["<fact id>"]
    }
  ],
  "angles": [
    { "title": "<short title>", "summaryText": "<1-2 sentences>", "factIds": ["<fact id>"] }
  ],
  "suggestions": [
    { "roleId": "<role id>", "text": "<bullet text>", "factIds": ["<fact id>"] }
  ],
  "rationale": "<1-2 sentence overview>"
}`;

/**
 * Normative `prepare-prompt/v2` system text (WO-1.3-S2-CP-B,
 * correction contracts §9). Any byte change is a prompt change:
 * bump the version, never edit in place. Angles and suggestions
 * link the priorities they address by VERBATIM quote text; the
 * sidecar resolves those quotes to priority ids and drops
 * unresolvable links. Pinned by
 * `tests/unit/acceptance-v1.3/s2cpb-preparation.test.ts`.
 */
export const PREPARE_PROMPT_V2 = `You are a resume preparation analyst. Quote job requirements exactly and propose resume angles and bullets grounded ONLY in the supplied approved facts.

RULES:
1. Every priority quote must be a verbatim substring of the JOB DESCRIPTION text below, using its exact wording and capitalization. Do NOT modify or paraphrase. Prefer keyword-dense multiword phrases (hard skills, technologies, tools, domains) over generic sentences.
2. For each priority supply: the quote text, how many times it occurs (count), a category, importance (required, preferred, or unspecified — ranked by importance to the role, independent of candidate support), advisory support (matched, partial, gap, or unsupported — graded honestly; deterministic code recomputes it), and the fact ids it rests on (empty when gap/unsupported).
3. Rank priorities by importance to the role (required first). Fewer than three priorities is acceptable when the description is sparse; never pad with boilerplate.
4. Every angle and every suggestion MUST name the exact JD priorities it addresses by their VERBATIM quote text (at least one each): copy the quote strings from rule 1 exactly. Never invent quotes, ids, or hashes.
5. Propose at most two positioning angles: each has a short title, a 1-2 sentence summary, the fact ids it rests on, and its priority quotes. Angles must be textually distinct from each other and from the master summary.
6. Propose role-specific bullet suggestions: each names the role id it belongs to, the bullet text, the fact ids it rests on, and its priority quotes. Never invent metrics, technologies, employers, dates, or responsibilities; never move experience across employers; propose the owning employer's role for employment-grounded text.
7. Prefer reusing fact and master-bullet wording verbatim; keep cited fact ids exact. Deterministic validation decides support, not this proposal.
8. Output strict JSON only, matching this structure (no provenance, verification, acceptance, eligibility, scores, paths, or approval assertions):
{
  "priorities": [
    {
      "quote": "<exact JD substring>",
      "count": 1,
      "category": "skill",
      "importance": "required",
      "matchStatus": "matched",
      "factIds": ["<fact id>"]
    }
  ],
  "angles": [
    { "title": "<short title>", "summaryText": "<1-2 sentences>", "factIds": ["<fact id>"], "priorityQuotes": ["<exact JD substring>"] }
  ],
  "suggestions": [
    { "roleId": "<role id>", "text": "<bullet text>", "factIds": ["<fact id>"], "priorityQuotes": ["<exact JD substring>"] }
  ],
  "rationale": "<1-2 sentence overview>"
}`;

const VALID_IMPORTANCE = ["required", "preferred", "unspecified"];
const VALID_MATCH_STATUS = ["matched", "partial", "gap", "unsupported"];

export function validatePreparationInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: "input must be a JSON object" };
  }
  if (input.schemaVersion !== "preparation-input/v2") {
    return { ok: false, detail: `schemaVersion must be preparation-input/v2, got ${JSON.stringify(input.schemaVersion ?? null)}` };
  }
  if (input.promptVersion !== "prepare-prompt/v2") {
    return { ok: false, detail: `promptVersion must be prepare-prompt/v2, got ${JSON.stringify(input.promptVersion ?? null)}` };
  }
  if (typeof input.extractionId !== "string" || input.extractionId === "") {
    return { ok: false, detail: "extractionId must be a non-empty string" };
  }
  if (typeof input.jdText !== "string" || input.jdText === "") {
    return { ok: false, detail: "jdText must be a non-empty string" };
  }
  if (typeof input.jdSnapshotId !== "string" || input.jdSnapshotId === "") {
    return { ok: false, detail: "jdSnapshotId must be a non-empty string" };
  }
  if (typeof input.candidateSnapshotId !== "string" || input.candidateSnapshotId === "") {
    return { ok: false, detail: "candidateSnapshotId must be a non-empty string" };
  }
  return { ok: true };
}

function providerConfig() {
  const provider = activeProviderId(process.env);
  const label = providerLabel(provider);
  const keyName = providerKeyName(provider);
  return { provider, label, keyName, apiKey: process.env[keyName] ?? "" };
}

/**
 * Verify `quote` as an exact substring of the canonical JD and
 * return its UTF-8 byte range (first occurrence), or null when it
 * does not occur verbatim. Offsets are computed here, never taken
 * from model output.
 */
export function computeQuoteOffsets(canonicalJdText, quote) {
  if (typeof quote !== "string" || quote === "") {
    return null;
  }
  const bytes = Buffer.from(canonicalJdText, "utf8");
  const startByte = bytes.indexOf(quote);
  if (startByte === -1) {
    return null;
  }
  return { text: quote, startByte, endByte: startByte + Buffer.byteLength(quote, "utf8") };
}

/**
 * Byte-exact `phraseIdFor` equivalent for priority-link
 * resolution: SHA-256 over the canonical JSON of the flat id
 * inputs (keys sorted, compact separators, NFC text — the same
 * bytes `src/domain/canonical.ts` produces for this shape).
 * Pinned byte-equal against the TypeScript implementation by
 * `tests/unit/acceptance-v1.3/s2cpb-preparation.test.ts`.
 */
export function priorityIdFor({ extractionId, jdHash, startByte, endByte, text }) {
  const canonical = `{"endByte":${endByte},"extractionId":${JSON.stringify(textNormalize(extractionId))},"jdHash":${JSON.stringify(jdHash)},"startByte":${startByte},"text":${JSON.stringify(textNormalize(text))}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function textNormalize(value) {
  return typeof value.normalize === "function" ? value.normalize("NFC") : value;
}

/**
 * Resolve verbatim link quotes to the ids of the verified
 * priorities. A link resolves only when its text+offsets match a
 * verified priority triple exactly; unresolvable and duplicate
 * links are dropped (the worker records them, and items left
 * with zero links fail publication wholesale).
 */
function resolvePriorityLinks(priorityQuotes, verified, jdText, jdHash, extractionId) {
  if (!Array.isArray(priorityQuotes)) {
    return [];
  }
  const ids = [];
  for (const raw of priorityQuotes.slice(0, 20)) {
    if (typeof raw !== "string" || raw === "") {
      continue;
    }
    const offsets = computeQuoteOffsets(jdText, raw);
    if (offsets === null) {
      continue;
    }
    const match = verified.find(
      (entry) =>
        entry.text === offsets.text &&
        entry.startByte === offsets.startByte &&
        entry.endByte === offsets.endByte,
    );
    if (match === undefined) {
      continue;
    }
    const id = priorityIdFor({
      extractionId,
      jdHash,
      startByte: match.startByte,
      endByte: match.endByte,
      text: match.text,
    });
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function buildPreparePrompt(input) {
  const facts = Array.isArray(input.profile?.achievements) ? input.profile.achievements : [];
  const approvedIds = new Set(Array.isArray(input.approvedFactIds) ? input.approvedFactIds : []);
  const approved = facts.filter((f) => approvedIds.has(f?.factId));
  const factLines = approved.map(
    (f) =>
      `- Fact ID: ${f.factId} | Role: ${f.employmentId ?? "(transferable)"} | Text: "${f.text}" | Technologies: [${(f.technologies || []).join(", ")}] | Metrics: [${(f.metrics || []).join(", ")}]`,
  );
  const bullets = Array.isArray(input.masterBullets) ? input.masterBullets : [];
  const bulletLines = bullets.map((b) => `- Role: ${b.roleId || "(unlinked)"} | Fact: ${b.factId} | Text: "${b.text}"`);
  const budgets = input.budgets ?? {};
  return [
    `JOB TITLE: ${input.jobTitle || "Not specified"}`,
    `COMPANY: ${input.company || "Not specified"}`,
    "",
    "JOB DESCRIPTION:",
    '"""',
    input.jdText,
    '"""',
    "",
    "CANDIDATE APPROVED FACTS:",
    '"""',
    factLines.join("\n"),
    '"""',
    "",
    "MASTER BULLETS BY ROLE:",
    '"""',
    bulletLines.join("\n"),
    '"""',
    "",
    `TARGETS: up to ${budgets.priorities ?? 5} priorities, ${budgets.angles ?? 2} angles, ${budgets.suggestions ?? 5} suggestions.`,
    "",
    "Quote the description exactly, ground every proposal in the approved facts above, and output JSON:",
  ].join("\n");
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cleanString(value, max) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

function cleanFactIds(value, approvedIds, max) {
  if (!Array.isArray(value)) {
    return null;
  }
  const kept = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && approvedIds.has(entry) && !kept.includes(entry)) {
      kept.push(entry);
    }
    if (kept.length >= max) {
      break;
    }
  }
  return kept;
}

export function validateProposal(parsed, input) {
  const root = asRecord(parsed);
  if (root === null) {
    return { ok: false, detail: "proposal must be a JSON object" };
  }
  const approvedIds = new Set(Array.isArray(input.approvedFactIds) ? input.approvedFactIds : []);
  const roleIds = new Set(
    (Array.isArray(input.profile?.employment) ? input.profile.employment : [])
      .map((entry) => entry?.id)
      .filter((id) => typeof id === "string" && id !== ""),
  );
  const priorities = [];
  if (!Array.isArray(root.priorities)) {
    return { ok: false, detail: "priorities must be an array" };
  }
  for (const entry of root.priorities.slice(0, 20)) {
    const item = asRecord(entry);
    if (item === null) {
      continue;
    }
    const quote = typeof item.quote === "string" ? item.quote : null;
    const offsets = quote === null ? null : computeQuoteOffsets(input.jdText, quote);
    if (offsets === null) {
      continue;
    }
    const count = item.count;
    const category = cleanString(item.category, 80) ?? "other";
    const importance = VALID_IMPORTANCE.includes(item.importance) ? item.importance : "unspecified";
    const matchStatus = VALID_MATCH_STATUS.includes(item.matchStatus) ? item.matchStatus : "unsupported";
    const factIds = cleanFactIds(item.factIds, approvedIds, 100) ?? [];
    priorities.push({
      quote: offsets,
      count: Number.isInteger(count) && count > 0 ? count : 1,
      category,
      importance,
      matchStatus,
      factIds: matchStatus === "gap" || matchStatus === "unsupported" ? [] : factIds,
    });
  }
  // Link-resolution inputs for BOTH angles and suggestions: they
  // must exist even when the model omits `angles` (they were
  // block-scoped to the angles branch, crashing suggestion-only
  // responses with a ReferenceError).
  const jdHash = createHash("sha256").update(input.jdText, "utf8").digest("hex");
  const verifiedQuotes = priorities.map((entry) => entry.quote);
  const angles = [];
  if (root.angles !== undefined) {
    if (!Array.isArray(root.angles)) {
      return { ok: false, detail: "angles must be an array" };
    }
    for (const entry of root.angles.slice(0, 2)) {
      const item = asRecord(entry);
      if (item === null) {
        continue;
      }
      const title = cleanString(item.title, 80);
      const summaryText = cleanString(item.summaryText, 4000);
      const factIds = cleanFactIds(item.factIds, approvedIds, 100) ?? [];
      const priorityIds = resolvePriorityLinks(
        item.priorityQuotes,
        verifiedQuotes,
        input.jdText,
        jdHash,
        input.extractionId,
      );
      if (title === null || summaryText === null || factIds.length === 0 || priorityIds.length === 0) {
        continue;
      }
      angles.push({ title, summaryText, factIds, priorityIds });
    }
  }
  const suggestions = [];
  if (root.suggestions !== undefined) {
    if (!Array.isArray(root.suggestions)) {
      return { ok: false, detail: "suggestions must be an array" };
    }
    for (const entry of root.suggestions.slice(0, 10)) {
      const item = asRecord(entry);
      if (item === null) {
        continue;
      }
      const roleId = typeof item.roleId === "string" && roleIds.has(item.roleId) ? item.roleId : null;
      const text = cleanString(item.text, 2000);
      const factIds = cleanFactIds(item.factIds, approvedIds, 20) ?? [];
      const priorityIds = resolvePriorityLinks(
        item.priorityQuotes,
        verifiedQuotes,
        input.jdText,
        jdHash,
        input.extractionId,
      );
      if (roleId === null || text === null || factIds.length === 0 || priorityIds.length === 0) {
        continue;
      }
      suggestions.push({ roleId, text, factIds, priorityIds });
    }
  }
  const rationale = cleanString(root.rationale, 2000) ?? "";
  return {
    ok: true,
    proposal: {
      schemaVersion: "preparation-proposal/v2",
      jdSnapshotId: input.jdSnapshotId,
      candidateSnapshotId: input.candidateSnapshotId,
      priorities,
      angles,
      suggestions,
      rationale,
    },
  };
}

async function callProvider(input, config) {
  const models = providerChain(config.provider);
  let content;
  try {
    const completion = await providerChat(config.provider, {
      apiKey: config.apiKey,
      models,
      messages: [
        { role: "system", content: PREPARE_PROMPT_V2 },
        { role: "user", content: buildPreparePrompt(input) },
      ],
      timeoutMs: 60000,
      diagnose: (line) => process.stderr.write(`${line}\n`),
    });
    content = completion.content;
  } catch (err) {
    // Every client throws { kind, status, message }; branch on the
    // shape so all providers share one exit-code contract.
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

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = typeof content === "string" ? content.match(/\{[\s\S]*\}/) : null;
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      process.stderr.write("Failed to parse JSON from LLM response\n");
      throw new ProviderFailure(EXIT_BAD_RESPONSE, "Failed to parse JSON from LLM response");
    }
  }
  const validated = validateProposal(parsed, input);
  if (!validated.ok) {
    process.stderr.write(`Proposal validation failed: ${validated.detail}\n`);
    throw new ProviderFailure(EXIT_BAD_RESPONSE, validated.detail);
  }
  return validated.proposal;
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
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

  const validated = validatePreparationInput(input);
  if (!validated.ok) {
    process.stderr.write(`Unsupported preparation input: ${validated.detail}\n`);
    process.exit(1);
  }

  const config = providerConfig();
  if (!config.apiKey) {
    // No deterministic fallback: a fabricated plan is worse than
    // none. The handler never calls without a key; this exit is
    // defense in depth for direct invocation.
    process.stderr.write(`${config.keyName} is not set: preparation requires a provider key\n`);
    process.exit(EXIT_AUTH);
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
