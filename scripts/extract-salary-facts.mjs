#!/usr/bin/env node
/**
 * Salary Facts Provider for Local Job Tracker (R4-G Step-2 fallback).
 * Reads `{ jobTitle, company, location, jdText }` from stdin and writes
 * `salary-facts/v1` to stdout: annual min/max, disambiguated currency,
 * the verbatim salary quote, and compensation highlights.
 *
 * Non-blocking by design: missing keys and exhausted models exit 0 with
 * empty facts (plus a stderr diagnostic), so the caller skips the
 * backfill and the tailoring run proceeds. Only usage errors exit 1.
 * Salary numbers require a verbatim JD quote — ungrounded numbers are
 * nulled instead of persisted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeProviderId,
  providerChain,
  providerChat,
  providerKeyName,
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

loadEnvFile(join(process.cwd(), ".env.local"));

const PROVIDER = activeProviderId(process.env);
const PROVIDER_KEY_NAME = providerKeyName(PROVIDER);
const PROVIDER_API_KEY = process.env[PROVIDER_KEY_NAME] || "";
const SALARY_FACTS_VERSION = "salary-facts/v1";
const KNOWN_CURRENCIES = new Set(["USD", "CAD", "AUD", "GBP", "EUR"]);

function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function emptyFacts() {
  return {
    schemaVersion: SALARY_FACTS_VERSION,
    salaryMinMinor: null,
    salaryMaxMinor: null,
    currency: null,
    salaryText: null,
    isHourlyOrDaily: false,
    compensationHighlights: [],
    model: null,
  };
}

function toMinor(dollars) {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0) {
    return null;
  }
  const minor = Math.round(dollars * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function cleanHighlights(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const kept = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const text = entry.trim().slice(0, 120);
    if (text !== "" && kept.length < 8) {
      kept.push(text);
    }
  }
  return kept;
}

async function callProvider(input) {
  const { jobTitle, company, location, jdText } = input;

  const systemMessage = `You are a precise job-posting compensation extractor.
Extract ONLY what the Job Description explicitly states. Never invent, annualize, or convert numbers.

RULES:
1. "salary_min" / "salary_max": annual base-salary dollars as numbers (e.g. 145900). No midpoint, no math: copy the stated range endpoints. Use null when the posting states no annual range.
2. "is_hourly_or_daily": true when the posting quotes an hourly, daily, or monthly rate (e.g. "$75 - $95 / hr"). Hourly/daily/monthly rates MUST NOT appear in salary_min/salary_max (leave both null).
3. "currency": the 3-letter code. When the posting uses a bare "$" with no code, inspect the location and benefit clues to disambiguate: Canadian cities/provinces, RRSP, TFSA, or "CA" markers mean "CAD"; otherwise "USD". One of ["USD", "CAD", "AUD", "GBP", "EUR"], or null when genuinely unknown.
4. "salary_quote": the EXACT VERBATIM substring from the JD carrying the pay statement (or null when no pay is stated). Do not paraphrase.
5. "compensation_highlights": short verbatim-ish phrases for extras BEYOND base salary (e.g. "Stock options / Equity", "RRSP matching", "Health & wellness stipend"). Empty array when none are stated.
6. Output ONLY JSON in this exact structure:
{
  "salary_min": 145900,
  "salary_max": 197400,
  "is_hourly_or_daily": false,
  "currency": "CAD",
  "salary_quote": "<exact substring or null>",
  "compensation_highlights": ["..."]
}`;

  const userMessage = `JOB TITLE: ${jobTitle || "Not specified"}
COMPANY: ${company || "Not specified"}
LOCATION: ${location || "Not specified"}

JOB DESCRIPTION:
"""
${jdText.slice(0, 15000)}
"""

Extract the compensation facts and output JSON:`;

  let completion;
  try {
    completion = await providerChat(PROVIDER, {
      apiKey: PROVIDER_API_KEY,
      models: providerChain(PROVIDER),
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      timeoutMs: 60000,
      diagnose: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    if (err !== null && typeof err === "object" && typeof err.kind === "string") {
      process.stderr.write(`Salary fallback exhausted: ${err.message}\n`);
      return emptyFacts();
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(completion.content);
  } catch {
    const match = completion.content.match(/\{[\s\S]*\}/);
    if (!match) {
      process.stderr.write("Salary fallback: unparseable model response\n");
      return emptyFacts();
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      process.stderr.write("Salary fallback: unparseable model response\n");
      return emptyFacts();
    }
  }

  const quote =
    typeof parsed?.salary_quote === "string" && parsed.salary_quote.trim() !== ""
      ? parsed.salary_quote.trim().slice(0, 500)
      : null;
  const quoteGrounded = quote !== null && jdText.includes(quote);
  if (quote !== null && !quoteGrounded) {
    process.stderr.write("Salary fallback: quote is not verbatim, nulling salary\n");
  }
  const hourly = parsed?.is_hourly_or_daily === true;
  let minMinor = quoteGrounded && !hourly ? toMinor(parsed?.salary_min) : null;
  let maxMinor = quoteGrounded && !hourly ? toMinor(parsed?.salary_max) : null;
  if (minMinor !== null && maxMinor !== null && minMinor > maxMinor) {
    [minMinor, maxMinor] = [maxMinor, minMinor];
  }
  const rawCurrency =
    typeof parsed?.currency === "string" ? parsed.currency.trim().toUpperCase() : null;
  const currency =
    quoteGrounded && rawCurrency !== null && KNOWN_CURRENCIES.has(rawCurrency)
      ? rawCurrency
      : null;

  return {
    schemaVersion: SALARY_FACTS_VERSION,
    salaryMinMinor: minMinor,
    salaryMaxMinor: maxMinor,
    currency,
    salaryText: quoteGrounded ? quote : null,
    isHourlyOrDaily: hourly,
    compensationHighlights: cleanHighlights(parsed?.compensation_highlights),
    model: completion.model,
  };
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
  if (typeof input?.jdText !== "string" || input.jdText.trim() === "") {
    process.stderr.write("Missing jdText on stdin\n");
    process.exit(1);
  }

  if (!PROVIDER_API_KEY) {
    process.stderr.write(`Salary fallback: ${PROVIDER_KEY_NAME} is not set, skipping\n`);
    process.stdout.write(JSON.stringify(emptyFacts()));
    return;
  }

  process.stdout.write(JSON.stringify(await callProvider(input)));
}

main().catch((err) => {
  process.stderr.write(`Salary provider execution error: ${err.message}\n`);
  process.exit(1);
});
