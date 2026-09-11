import { z } from "zod";

/** Shared scalar fields used across domain command/envelope schemas. */

/** Stable TEXT primary keys (UUIDs minted by services, never by agents). */
export const EntityId = z.uuid();
export type EntityId = z.infer<typeof EntityId>;

/** UTC ISO-8601 timestamps as stored in SQLite (`...Z` required). */
export const IsoUtcDateTime = z.iso.datetime();
export type IsoUtcDateTime = z.infer<typeof IsoUtcDateTime>;

/** Lowercase hex SHA-256 digests. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Human-authored notes that must say something (corrections, revisions). */
export const RequiredNote = z.string().trim().min(1);
export type RequiredNote = z.infer<typeof RequiredNote>;

/** Optimistic-concurrency token carried on mutable rows (`row_version`). */
export const RowVersion = z.int().min(1);
export type RowVersion = z.infer<typeof RowVersion>;
