BEGIN;

-- Migration de réparation idempotente pour les environnements Render ayant
-- reçu l'interface avant toutes les migrations du module de restitution.
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

ALTER TABLE card_return_receipt
  ADD COLUMN IF NOT EXISTS monthly_limit numeric(14,3),
  ADD COLUMN IF NOT EXISTS consumed_amount numeric(14,3),
  ADD COLUMN IF NOT EXISTS consumed_liters numeric(14,3),
  ADD COLUMN IF NOT EXISTS transaction_count integer,
  ADD COLUMN IF NOT EXISTS restored_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_limit numeric(14,3);

CREATE INDEX IF NOT EXISTS idx_card_return_receipt_date ON card_return_receipt(returned_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_return_receipt_month ON card_return_receipt(consumption_month,fuel_card_id);
CREATE INDEX IF NOT EXISTS idx_card_return_receipt_restored ON card_return_receipt(restored_at DESC) WHERE restored_at IS NOT NULL;

COMMIT;
