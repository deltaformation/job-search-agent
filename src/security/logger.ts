import { redactSecrets } from "./redact";

/**
 * Minimal structured logger. Each call emits one JSON line carrying a UTC
 * timestamp, level, component, message, and redacted fields. Sinks are
 * injectable for tests; production sinks are stdout (`debug`/`info`) and
 * stderr (`warn`/`error`).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogSinks {
  out(line: string): void;
  err(line: string): void;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSinks;
  now?: () => string;
}

const defaultSinks: LogSinks = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export function createLogger(component: string, options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const sinks = options.sinks ?? defaultSinks;
  const now = options.now ?? (() => new Date().toISOString());

  const emit = (
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): void => {
    if (LEVEL_ORDER[level] < minimum) {
      return;
    }
    const line = JSON.stringify({
      ts: now(),
      level,
      component,
      msg: message,
      ...(fields === undefined ? {} : { fields: redactSecrets(fields) }),
    });
    if (level === "warn" || level === "error") {
      sinks.err(line);
    } else {
      sinks.out(line);
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/**
 * Barrier for piped output: an empty write resolves only after earlier
 * writes flush, so awaiting this before process exit keeps the final log
 * lines from being dropped when the event loop drains. Never rejects.
 */
export function flushStdio(): Promise<void> {
  const drain = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolveDrain) => {
      try {
        stream.write("", () => resolveDrain());
      } catch {
        resolveDrain();
      }
    });
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(
    () => undefined,
  );
}
