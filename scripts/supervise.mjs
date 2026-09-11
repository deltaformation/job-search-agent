/**
 * Minimal two-process supervisor for the local web + worker runtime.
 *
 * CLI: `node scripts/supervise.mjs [--name NAME] CMD... [--name NAME CMD...]`
 * Only `--name` is special; every other token passes through to the child
 * argv untouched (argv arrays only — commands are never joined into shell
 * strings).
 *
 * Policy: the first child exit (or SIGINT/SIGTERM to the supervisor) begins
 * shutdown — remaining children get SIGTERM, then SIGKILL after the grace
 * period. Exit code is 0 only when every child exited 0 (or was terminated
 * by our own shutdown signal); a child crash or spawn failure exits 1;
 * usage errors exit 2. There is no auto-restart: failures surface loudly.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flushStdio } from "./flush.mjs";

export function parseChildSpecs(argv) {
  const specs = [];
  let name = null;
  let command = [];
  const flush = () => {
    if (command.length > 0) {
      specs.push({ name: name ?? `child-${specs.length + 1}`, argv: command });
    } else if (name !== null) {
      throw new Error(`supervise: --name ${name} has no command`);
    }
    name = null;
    command = [];
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") {
      flush();
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("usage: supervise [--name NAME] CMD... [--name NAME CMD...]");
      }
      name = value;
      i += 1;
    } else {
      command.push(argv[i]);
    }
  }
  flush();
  if (specs.length === 0) {
    throw new Error("usage: supervise [--name NAME] CMD... [--name NAME CMD...]");
  }
  return specs;
}

function pipePrefixed(stream, prefix, write) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      write(`${prefix}${line}`);
    }
  });
  stream.on("close", () => {
    if (buffer !== "") {
      write(`${prefix}${buffer}`);
      buffer = "";
    }
  });
}

/**
 * Run child processes until the first exit or signal, then shut the rest
 * down. Resolves with `{ code }`; never throws for child failures.
 */
export async function supervise(specs, opts = {}) {
  const graceMs = opts.graceMs ?? 10000;
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = opts.err ?? ((line) => process.stderr.write(`${line}\n`));

  return new Promise((resolveDone) => {
    const children = new Map();
    let shuttingDown = false;
    let firstFailure = null;
    let graceTimer = null;
    let settled = false;

    const cleanupSignals = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };

    const finish = () => {
      if (settled) {
        return;
      }
      for (const child of children.values()) {
        if (child.exited === null) {
          return;
        }
      }
      settled = true;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      cleanupSignals();
      const code = firstFailure !== null ? 1 : 0;
      if (firstFailure !== null) {
        err(`supervisor: ${firstFailure}; all processes stopped`);
      } else {
        out("supervisor: all processes stopped cleanly");
      }
      flushStdio().then(() => resolveDone({ code }));
    };

    const beginShutdown = (reason) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      out(`supervisor: shutting down (${reason})`);
      for (const child of children.values()) {
        if (child.exited === null) {
          try {
            child.proc.kill("SIGTERM");
          } catch {
            // Already gone; the exit handler records it.
          }
        }
      }
      graceTimer = setTimeout(() => {
        for (const [name, child] of children) {
          if (child.exited === null) {
            err(`supervisor: ${name} ignored SIGTERM, sending SIGKILL`);
            try {
              child.proc.kill("SIGKILL");
            } catch {
              // Gone between the check and the kill.
            }
          }
        }
      }, graceMs);
      if (typeof graceTimer.unref === "function") {
        graceTimer.unref();
      }
      finish();
    };

    function onSignal(signal) {
      if (!shuttingDown) {
        beginShutdown(`received ${signal}`);
        return;
      }
      for (const child of children.values()) {
        if (child.exited === null) {
          try {
            child.proc.kill("SIGKILL");
          } catch {
            // Gone.
          }
        }
      }
    }

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    for (const spec of specs) {
      const [command, ...args] = spec.argv;
      const proc = spawn(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const record = { proc, exited: null };
      children.set(spec.name, record);
      pipePrefixed(proc.stdout, `[${spec.name}] `, out);
      pipePrefixed(proc.stderr, `[${spec.name}] `, err);
      proc.on("error", (error) => {
        if (record.exited !== null) {
          return;
        }
        record.exited = { code: 1, signal: null };
        if (!shuttingDown && firstFailure === null) {
          firstFailure = `${spec.name} failed to start: ${error.message}`;
        }
        beginShutdown(`${spec.name} failed to start`);
        finish();
      });
      proc.on("exit", (code, signal) => {
        if (record.exited !== null) {
          return;
        }
        record.exited = { code, signal };
        const clean =
          code === 0 ||
          (shuttingDown && (signal === "SIGTERM" || signal === "SIGINT"));
        if (!clean && !shuttingDown && firstFailure === null) {
          firstFailure =
            signal === null
              ? `${spec.name} exited with code ${code}`
              : `${spec.name} killed by ${signal}`;
        }
        if (!shuttingDown) {
          beginShutdown(firstFailure ?? `${spec.name} exited`);
        }
        finish();
      });
    }
  });
}

export async function main(argv, env = process.env) {
  const specs = parseChildSpecs(argv);
  const graceMs = Number(env.SUPERVISOR_GRACE_MS ?? "");
  const { code } = await supervise(
    specs,
    Number.isSafeInteger(graceMs) && graceMs > 0 ? { graceMs } : {},
  );
  return code;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    async (code) => {
      await flushStdio();
      process.exitCode = code;
    },
    async (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      await flushStdio();
      process.exitCode = 2;
    },
  );
}
