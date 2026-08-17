BEGIN;

ALTER TABLE driver
  ADD COLUMN IF NOT EXISTS total_mobility_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_mobility_raw jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_driver_total_mobility_checked
  ON driver(total_mobility_checked_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN driver.total_mobility_checked_at IS
  'Dernière synchronisation réussie de ce chauffeur depuis Total Mobility.';
COMMENT ON COLUMN driver.total_mobility_raw IS
  'Instantané source Total Mobility conservé pour audit et évolution du mapping.';

COMMIT;
