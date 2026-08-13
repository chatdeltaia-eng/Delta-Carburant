BEGIN;

CREATE TABLE IF NOT EXISTS card_return_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  card_request_id uuid NOT NULL UNIQUE REFERENCES card_request(id),
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  returned_by uuid NOT NULL REFERENCES app_user(id),
  received_by uuid NOT NULL REFERENCES app_user(id),
  returned_at timestamptz NOT NULL DEFAULT now(),
  consumption_rate numeric(8,3) NOT NULL,
  consumption_month date NOT NULL DEFAULT date_trunc('month',current_date)::date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_card_return_receipt_date ON card_return_receipt(returned_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_return_receipt_month ON card_return_receipt(consumption_month,fuel_card_id);

ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS period_liters numeric(14,3);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS reference_liters_per_100km numeric(14,3);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS calculated_liters_per_100km numeric(14,3);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS estimated_distance numeric(14,1);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS estimated_mileage numeric(14,1);
ALTER TABLE mileage_reading ADD COLUMN IF NOT EXISTS reconciliation_message text;

COMMIT;
