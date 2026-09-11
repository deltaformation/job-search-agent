/**
 * Pure TypeScript truthfulness core (R4-C): requirement/claim validation,
 * coverage-first ranking, keyword planning, constrained summaries, and the
 * stale-input gate. Ports of the legacy Python oracle pinned by the R4-B
 * parity fixtures. No agent calls, no filesystem, no database.
 */
export * from "./hash";
export * from "./keywords";
export * from "./primitives";
export * from "./ranking";
export * from "./schemas";
export * from "./staleness";
export * from "./summary";
export * from "./text";
export * from "./validator";
