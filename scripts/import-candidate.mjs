#!/usr/bin/env node
/**
 * `npm run candidate:import -- <file> [--profile <id|name>] [--activate] [--json]`
 * — import a reviewed `candidate-import/v1|v2` master-resume JSON file as a
 * new immutable profile version. The human authors the file at an ignored
 * local path (conventionally `data/candidate/master-resume.json`); this
 * command only validates and stores exactly what the file declares, never
 * inventing or rewording facts. `--profile` targets a profile by id or
 * name (default profile otherwise); `--activate` also selects the new
 * version as active. Exit 0 on success, 1 on failure, 2 on usage errors.
 */
import { readFileSync } from "node:fs";
import { flushStdio } from "./flush.mjs";
import { runSetup } from "./setup-data.mjs";

const MAX_FILE_BYTES = 1_000_000;

function usage() {
  return [
    "usage: npm run candidate:import -- <file> [--profile <id|name>] [--activate] [--json]",
    "",
    "  <file>       reviewed candidate-import/v1|v2 JSON (e.g. data/candidate/master-resume.json)",
    "  --profile    target profile id or name (default profile otherwise)",
    "  --activate   select the imported version as the active profile version",
    "  --json       print the machine-readable result instead of human lines",
  ].join("\n");
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

try {
  const argv = process.argv.slice(2);
  const positional = [];
  let profileIdOrName;
  let activate = false;
  let asJson = false;
  let unknown;
  let missingProfileValue = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        missingProfileValue = true;
      } else {
        profileIdOrName = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--activate") {
      activate = true;
      continue;
    }
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg.startsWith("--")) {
      unknown = arg;
      continue;
    }
    positional.push(arg);
  }
  const file = positional[0];
  if (unknown !== undefined) {
    process.stderr.write(`${usage()}\nunknown flag: ${unknown}\n`);
    process.exitCode = 2;
  } else if (missingProfileValue || file === undefined || positional.length > 1) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      fail(`cannot read import file: ${file}`);
      raw = null;
    }
    if (raw !== null) {
      if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) {
        fail(`import file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
      } else {
        let document;
        try {
          document = JSON.parse(raw);
        } catch {
          fail(`import file is not valid JSON: ${file}`);
          document = undefined;
        }
        if (document !== undefined) {
          const config = await runSetup(process.env);
          const db = await import("../src/db/index.ts");
          const settings = await import("../src/server/settings.ts");
          const handle = db.openDatabase({ path: config.databasePath });
          try {
            const result = settings.importMasterDocument(handle, {
              document,
              sourceBytes: Buffer.from(raw, "utf8"),
              profileId: profileIdOrName,
              origin: "cli",
              sourcesDir: config.sourcesDir,
              activate,
            });
            if (!result.ok) {
              if (result.error === "master-resume-invalid") {
                fail(`import file failed schema validation:\n${result.detail ?? "no detail"}`);
              } else {
                fail(`import rejected: ${result.error} (${result.detail ?? "no detail"})`);
              }
            } else if (process.exitCode === undefined || process.exitCode === 0) {
              if (asJson) {
                process.stdout.write(`${JSON.stringify(result)}\n`);
              } else {
                process.stdout.write(
                  `imported profile version ${result.version} (${result.versionId})${
                    result.alreadyCurrent ? " (already current)" : ""
                  }\n` +
                    `facts: ${result.insertedFacts.length} inserted, ${result.reusedFacts.length} reused\n` +
                    (result.remappedFacts.length === 0
                      ? ""
                      : `remapped ${result.remappedFacts.length} fact(s) to cross-profile copies\n`),
                );
                if (result.activated) {
                  process.stdout.write(`activated version ${result.version}\n`);
                }
              }
            }
          } finally {
            handle.close();
          }
        }
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "ZodError") {
    fail(`import file failed schema validation:\n${message}`);
  } else {
    fail(`import failed: ${message}`);
  }
} finally {
  await flushStdio();
}
