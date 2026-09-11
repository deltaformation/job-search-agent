import {
  resolveDataRoot,
  type DataRootPaths,
} from "./data-root";
import { isLoopbackHostname } from "./origin";

/**
 * Runtime configuration shared by the supervisor, worker, and route
 * handlers. Everything derives from explicit environment input with safe
 * local defaults; invalid values fail fast with actionable messages.
 * The web process stays loopback-only: non-loopback `HOST` is refused.
 */

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";

export interface RuntimeConfig extends DataRootPaths {
  host: string;
  port: number;
}

export function parsePort(
  value: string | undefined,
  fallback: number = DEFAULT_PORT,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`PORT must be an integer, got ${JSON.stringify(value)}`);
  }
  const port = Number(value.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be between 1 and 65535, got ${port}`);
  }
  return port;
}

export function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  if (!isLoopbackHostname(host)) {
    throw new Error(
      `HOST must stay loopback-only (127.0.0.1 or localhost), got ${JSON.stringify(value)}`,
    );
  }
  return host.toLowerCase();
}

export function resolveRuntimeConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): RuntimeConfig {
  return {
    ...resolveDataRoot(env, cwd),
    host: parseHost(env.HOST),
    port: parsePort(env.PORT),
  };
}
