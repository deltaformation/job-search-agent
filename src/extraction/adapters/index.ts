import type { ExtractionAdapter } from "../types";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";

/**
 * Site-adapter registry keyed by the legacy-compatible ATS label from
 * `detectAtsType`. Greenhouse and Lever ship first (fixture-backed);
 * every other board falls through to JSON-LD and the generic fallback.
 */
export const SITE_ADAPTERS: Readonly<Record<string, ExtractionAdapter>> = {
  Greenhouse: greenhouseAdapter,
  Lever: leverAdapter,
};

export function getSiteAdapter(atsType: string | null): ExtractionAdapter | null {
  if (atsType === null) {
    return null;
  }
  return SITE_ADAPTERS[atsType] ?? null;
}
