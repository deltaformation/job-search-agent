-- Migration: 0004_compensation_highlights.sql
-- R4-G: the AI salary fallback backfills compensation highlights (equity,
-- retirement matching, stipends) alongside salary min/max. Additive only;
-- existing rows keep NULL (no highlights reported) and existing queries
-- are unaffected.
ALTER TABLE `jobs` ADD `compensation_highlights_json` text;
