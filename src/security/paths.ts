import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { isSafeRelativePath } from "../domain/artifacts";

/**
 * Data-root path policy. Every file the product reads or writes must resolve
 * beneath an explicit allowlisted root: absolute paths, traversal, null
 * bytes, and symlink escapes are rejected before any filesystem access.
 */

/** Pure containment check on already-normalized absolute paths. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

/**
 * Resolve a caller-supplied relative path beneath `root`. Throws when the
 * shape is unsafe or the normalized result escapes the root.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("path must be relative, refusing absolute path");
  }
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  const resolved = resolve(root, relativePath);
  if (!isPathWithinRoot(resolve(root), resolved)) {
    throw new Error(`path escapes the data root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

/**
 * Walk every segment from the real root to `resolved` and reject symlinks.
 * The root itself is canonicalized first so system symlinks above it
 * (for example `/tmp` on macOS) do not cause false positives.
 */
export function assertNoSymlinkEscape(root: string, resolved: string): void {
  // Derive segments from the logical root (string level), then walk them
  // from the canonical root: symlinks above the root (for example `/tmp`
  // on macOS) must not cause false positives.
  const rel = relative(resolve(root), resolved);
  if (rel === "") {
    return;
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the canonical data root");
  }
  let cursor = realpathSync(root);
  for (const segment of rel.split(sep).filter((part) => part !== "")) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      // Missing tail segments cannot be symlinks; every existing ancestor
      // was already checked above this point in the walk.
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symlinked path segment: ${segment}`);
    }
  }
}

/**
 * Resolve an artifact/evidence relative path beneath `root`, rejecting
 * traversal and symlink escapes. This is the only sanctioned way to turn a
 * stored `relative_path` database value into a filesystem path.
 */
export function resolveArtifactPath(root: string, relativePath: string): string {
  const resolved = resolveWithinRoot(root, relativePath);
  assertNoSymlinkEscape(root, resolved);
  return resolved;
}
