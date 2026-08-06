BEGIN;

ALTER TABLE fuel_transaction
  ADD COLUMN IF NOT EXISTS previous_mileage numeric(14,1),
  ADD COLUMN IF NOT EXISTS reported_mileage numeric(14,1),
  ADD COLUMN IF NOT EXISTS authorization_code text;

ALTER TABLE transaction_review
  ADD COLUMN IF NOT EXISTS previous_mileage numeric(14,1),
  ADD COLUMN IF NOT EXISTS reported_mileage numeric(14,1),
  ADD COLUMN IF NOT EXISTS authorization_code text;

CREATE INDEX IF NOT EXISTS idx_fuel_transaction_authorization_code
  ON fuel_transaction(authorization_code)
  WHERE authorization_code IS NOT NULL;

COMMIT;
