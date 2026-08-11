BEGIN;

ALTER TABLE fuel_transaction
  ADD COLUMN IF NOT EXISTS expected_amount numeric(14,3),
  ADD COLUMN IF NOT EXISTS billing_difference numeric(14,3),
  ADD COLUMN IF NOT EXISTS billing_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_fuel_transaction_billing_status
  ON fuel_transaction(validation_status,transaction_date DESC)
  WHERE deleted_at IS NULL;

COMMIT;
