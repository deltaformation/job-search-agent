-- 0010: let the success path emit its own completion.
--
-- 0009's `s2_event_fence` requires the preparation row to be RUNNING
-- for every stage, but the handler flips the row to SUCCEEDED before
-- emitting PUBLISHING_PLAN (seq 5) — so every successful run ended as
-- a fence LEASE_LOST instead of publishing its fifth stage. The
-- fixed fence keeps the RUNNING requirement for stages 1-4 and
-- allows seq 5 on a SUCCEEDED row; every other condition (live
-- RUNNING item, current attempt, matching lease token, live lease,
-- sequence, monotonic time, single source) still applies, so an
-- expired or superseded attempt still cannot emit or publish.
DROP TRIGGER s2_event_fence;
CREATE TRIGGER s2_event_fence BEFORE INSERT ON step2_preparation_events
BEGIN
 SELECT RAISE(ABORT,'LEASE_LOST') WHERE NOT EXISTS(
  SELECT 1 FROM work_items w JOIN work_attempts a ON a.id=w.current_attempt_id
  JOIN step2_preparations p ON p.work_item_id=w.id
  WHERE p.id=NEW.preparation_id AND w.id=NEW.work_item_id AND w.kind='PREPARE'
   AND w.state='RUNNING' AND a.id=NEW.attempt_id AND a.result='RUNNING'
   AND w.lease_token=NEW.lease_token
   AND (p.state='RUNNING' OR (p.state='SUCCEEDED' AND NEW.seq=5 AND NEW.stage='PUBLISHING_PLAN'))
   AND julianday(w.lease_expires_at)>julianday(NEW.recorded_at)
   AND julianday(NEW.recorded_at)>=julianday(a.started_at));
 SELECT RAISE(ABORT,'PREP_PROGRESS_SEQUENCE') WHERE NEW.seq!=1+COALESCE(
  (SELECT MAX(seq) FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id),0);
 SELECT RAISE(ABORT,'PREP_PROGRESS_STAGE') WHERE NEW.seq!=CASE NEW.stage
  WHEN 'LOADING_INPUTS' THEN 1 WHEN 'WAITING_FOR_PROVIDER' THEN 2
  WHEN 'VALIDATING_PROPOSAL' THEN 3 WHEN 'STORING_PLAN' THEN 4
  WHEN 'PUBLISHING_PLAN' THEN 5 END;
 SELECT RAISE(ABORT,'PREP_PROGRESS_TIME') WHERE julianday(NEW.recorded_at)<COALESCE(
  (SELECT MAX(julianday(recorded_at)) FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id),julianday(NEW.recorded_at));
 SELECT RAISE(ABORT,'PREP_PROGRESS_SOURCE') WHERE EXISTS(
  SELECT 1 FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id AND source!=NEW.source);
END;
