/**
 * ESM resolution hook that maps extensionless relative imports to their
 * `.ts` source files, so plain Node 24 can run repository TypeScript
 * (worker, migrate/setup scripts) through native type stripping without a
 * bundler or loader dependency.
 *
 * Only extensionless relative specifiers that fail normal resolution are
 * retried with `.ts`; bare package imports and explicit extensions pass
 * through untouched.
 *
 * Must stay synchronous: `module.registerHooks` runs hooks on the main
 * thread and does not await async hook results.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolve(specifier, context, next) {
  try {
    return next(specifier, context);
  } catch (error) {
    // Retry extensionless relative imports as sibling `.ts` files, including
    // the case where a same-named directory shadows the file (bundlers also
    // prefer the file).
    if (
      (error?.code === "ERR_MODULE_NOT_FOUND" ||
        error?.code === "ERR_UNSUPPORTED_DIR_IMPORT") &&
      typeof specifier === "string" &&
      specifier.startsWith(".") &&
      !/\.[A-Za-z0-9]+$/.test(specifier) &&
      typeof context?.parentURL === "string"
    ) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = new URL(
        `${specifier}.ts`,
        pathToFileURL(parentPath),
      );
      if (existsSync(candidate)) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    throw error;
  }
}
