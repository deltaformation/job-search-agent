import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Bearer token for the cross-origin clip route. `POST /api/intake/clip`
 * accepts DOM captures from arbitrary job-board origins by design, so the
 * usual Origin gate cannot apply; instead the extension/bookmarklet proves
 * possession of this per-data-root secret. The token is generated lazily on
 * first read, stored `0600` inside the data root (never in the repo), and
 * displayed only to same-origin app pages — it never leaves localhost.
 */

export const CLIP_TOKEN_FILENAME = ".clip-token";
const TOKEN_BYTES = 32;

function tokenPath(dataRoot: string): string {
  return join(dataRoot, CLIP_TOKEN_FILENAME);
}

function readTokenFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Load the clip token, generating and persisting one (exclusive create, so
 * concurrent first reads converge on a single value) when absent. A corrupt
 * file throws with an actionable message instead of being silently replaced.
 */
export function getClipToken(dataRoot: string): string {
  const path = tokenPath(dataRoot);
  const existing = readTokenFile(path);
  if (existing !== null) {
    return existing;
  }
  const fresh = randomBytes(TOKEN_BYTES).toString("hex");
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      const raced = readTokenFile(path);
      if (raced !== null) {
        return raced;
      }
      throw new Error(
        "clip token file is corrupt; delete it to regenerate a token",
      );
    }
    throw error;
  }
  try {
    writeSync(fd, `${fresh}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  return fresh;
}

/** Constant-time bearer comparison; malformed headers never match. */
export function verifyClipToken(dataRoot: string, header: string | null): boolean {
  if (header === null) {
    return false;
  }
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header.trim());
  if (match === null) {
    return false;
  }
  const expected = Buffer.from(getClipToken(dataRoot), "utf8");
  const actual = Buffer.from(match[1], "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
