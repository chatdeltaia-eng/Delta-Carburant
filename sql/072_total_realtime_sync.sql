BEGIN;

-- Total ne propose pas de webhook pour ce compte. Une interrogation chaque
-- minute est le délai fiable le plus court et garde l'application alignée sur
-- les transactions visibles dans Mobility Business.
ALTER TABLE total_mobility_connection
  DROP CONSTRAINT IF EXISTS total_mobility_connection_sync_interval_minutes_check;
ALTER TABLE total_mobility_connection
  ALTER COLUMN sync_interval_minutes SET DEFAULT 1;
ALTER TABLE total_mobility_connection
  ADD CONSTRAINT total_mobility_connection_sync_interval_minutes_check
  CHECK(sync_interval_minutes BETWEEN 1 AND 1440);

UPDATE total_mobility_connection
SET sync_interval_minutes=1,enabled=true,updated_at=now();

INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
VALUES('migration-072','ENABLE_REALTIME_TOTAL_SYNC','integration','TOTAL_MOBILITY',
       '{"intervalMinutes":1,"enabled":true}'::jsonb);

COMMIT;
