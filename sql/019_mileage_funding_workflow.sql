BEGIN;

ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS week_start date;
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS previous_mileage numeric(14,1);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS expected_mileage numeric(14,1);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS detected_distance numeric(14,1);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS anomaly boolean NOT NULL DEFAULT false;
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS decision_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_mileage_vehicle ON mileage_reading(vehicle_id,week_start) WHERE week_start IS NOT NULL;

ALTER TABLE card_request ADD COLUMN IF NOT EXISTS source_card_id uuid REFERENCES fuel_card(id);

ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS workflow_status text NOT NULL DEFAULT 'APPROVED'
  CHECK(workflow_status IN ('PENDING','APPROVED','REJECTED'));
ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES app_user(id);
ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS decision_reason text;

COMMIT;
