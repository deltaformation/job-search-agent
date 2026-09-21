-- Migration: 0006_profile_sources.sql
-- WO-1.2-B (R-ADR-016, R-ADR-020): profile/version-owned master sources
-- plus fact-reuse provenance. Additive only: one new immutable table and
-- one nullable column. No existing row is touched; the legacy global
-- master file is not referenced here.
--
-- Source bytes for pre-upgrade versions cannot be written by SQL, so this
-- file creates schema only. A versioned code backfill
-- (`backfillProfileSources`, run by setup after migrations) reconstructs
-- each active payload's bytes from the stored payload as authoritative
-- and preserves the legacy file as evidence; see WO-1.2-B.
-- `candidate_facts.provenance_json` carries `fact-provenance/v1` for
-- reused facts and stays NULL for all pre-upgrade rows.

CREATE TABLE `candidate_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL REFERENCES `candidate_profiles`(`id`),
	`profile_version_id` text NOT NULL REFERENCES `candidate_profile_versions`(`id`),
	`relative_path` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`origin` text NOT NULL,
	`origin_detail_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "candidate_sources_version_unique" UNIQUE(`profile_version_id`),
	CONSTRAINT "candidate_sources_origin" CHECK(`origin` IN ('upload','paste','form','copy','cli','reconstructed','legacy')),
	CONSTRAINT "candidate_sources_byte_size" CHECK(`byte_size` >= 0)
);
--> statement-breakpoint
CREATE INDEX `candidate_sources_profile_id` ON `candidate_sources` (`profile_id`);
--> statement-breakpoint
ALTER TABLE `candidate_facts` ADD COLUMN `provenance_json` text;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_sources_no_update` BEFORE UPDATE ON `candidate_sources`
BEGIN SELECT RAISE(ABORT, 'candidate_sources is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_sources_no_delete` BEFORE DELETE ON `candidate_sources`
BEGIN SELECT RAISE(ABORT, 'candidate_sources is immutable'); END;
