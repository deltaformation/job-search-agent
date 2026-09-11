-- Migration: 0002_candidate_snapshot_dedupe.sql
-- R4-A: snapshot creation is get-or-create (web and worker race on the same
-- inputs), so identical candidate snapshots must collapse to one row. The
-- (profile_version_id, sha256) unique index makes the insert-or-reselect
-- protocol safe the way jd_snapshots_job_hash already does for JD text.
-- Additive only; existing rows are untouched.

CREATE UNIQUE INDEX `candidate_snapshots_version_hash`
  ON `candidate_snapshots` (`profile_version_id`,`sha256`);
--> statement-breakpoint
