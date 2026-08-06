BEGIN;

CREATE TABLE IF NOT EXISTS transaction_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES transaction_import_batch(id),
  source_row_number integer NOT NULL,
  issue_type text NOT NULL CHECK (issue_type IN ('UNKNOWN_CARD','UNKNOWN_VEHICLE')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
  card_number text NOT NULL,
  vehicle_registration text,
  transaction_date timestamptz NOT NULL,
  station text,
  product text,
  quantity_liters numeric(14,3) NOT NULL,
  amount_incl_tax numeric(14,3) NOT NULL,
  fuel_card_id uuid REFERENCES fuel_card(id),
  decided_by uuid REFERENCES app_user(id),
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id,source_row_number)
);
CREATE INDEX IF NOT EXISTS idx_transaction_review_pending ON transaction_review(status,created_at DESC);

COMMIT;
