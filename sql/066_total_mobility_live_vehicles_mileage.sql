BEGIN;

ALTER TABLE vehicle
  ADD COLUMN IF NOT EXISTS total_mobility_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_mobility_mileage numeric(14,1),
  ADD COLUMN IF NOT EXISTS total_mobility_status text,
  ADD COLUMN IF NOT EXISTS total_mobility_raw jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_vehicle_total_mobility_checked
  ON vehicle(total_mobility_checked_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_total_mileage_vehicle_value
  ON mileage_reading(vehicle_id,mileage)
  WHERE source='TOTAL_MOBILITY';

COMMENT ON COLUMN vehicle.total_mobility_mileage IS
  'Dernier kilométrage déclaré par Total Mobility.';
COMMENT ON COLUMN vehicle.total_mobility_checked_at IS
  'Dernière synchronisation réussie du véhicule depuis Total Mobility.';

COMMIT;
