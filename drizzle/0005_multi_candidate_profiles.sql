-- Migration: 0005_multi_candidate_profiles.sql
-- R-ADR-012: relax the single-row `candidate_profiles` root (`id = 'local'`)
-- into multiple named career profiles with metadata, one default, and
-- per-profile version lineages. Versions, facts, snapshots, and their
-- triggers are untouched: payload/fact immutability and the snapshot
-- membership guards still hold exactly as before.
--
-- SQLite cannot drop the `candidate_profiles_single_row` CHECK or add NOT
-- NULL columns, so the table is rebuilt: new table, backfilled copy, drop,
-- rename. The runner disables FK enforcement around the file (SQLite's
-- documented procedure: the mid-file drop of the referenced parent is
-- forbidden otherwise) and runs `foreign_key_check` before commit, so the
-- final state — rebuilt parent holding every referenced id — is validated.
-- Dropping the table also drops its two triggers, which are
-- recreated below: deletes stay forbidden, while updates are now allowed
-- for metadata columns only (`display_name`, `work_preferences_json`,
-- `executive_narrative`, `is_default`, `updated_at`); `id`, `name`, and
-- `created_at` stay frozen. The CHECK below names its column unqualified
-- on purpose: a table-qualified reference would not survive the rename.
-- At most one default row is enforced by a partial unique index; the
-- repository establishes and maintains exactly one default.

DROP TRIGGER IF EXISTS `trg_candidate_profiles_no_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_candidate_profiles_no_delete`;
--> statement-breakpoint

CREATE TABLE `candidate_profiles_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`work_preferences_json` text,
	`executive_narrative` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "candidate_profiles_name_unique" UNIQUE(`name`),
	CONSTRAINT "candidate_profiles_is_default" CHECK(`is_default` IN (0, 1))
);
--> statement-breakpoint

INSERT INTO `candidate_profiles_new` (`id`, `name`, `display_name`, `is_default`, `work_preferences_json`, `executive_narrative`, `created_at`, `updated_at`)
	SELECT `id`, 'default', 'Primary Profile', 1, NULL, NULL, `created_at`, `created_at` FROM `candidate_profiles`;
--> statement-breakpoint

DROP TABLE `candidate_profiles`;
--> statement-breakpoint
ALTER TABLE `candidate_profiles_new` RENAME TO `candidate_profiles`;
--> statement-breakpoint

CREATE UNIQUE INDEX `candidate_profiles_one_default` ON `candidate_profiles` (`is_default`) WHERE `is_default` = 1;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_profiles_no_delete` BEFORE DELETE ON `candidate_profiles`
BEGIN SELECT RAISE(ABORT, 'candidate_profiles root cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_profiles_guard_update` BEFORE UPDATE ON `candidate_profiles`
WHEN OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN SELECT RAISE(ABORT, 'candidate_profiles identity is immutable; only metadata may change'); END;
