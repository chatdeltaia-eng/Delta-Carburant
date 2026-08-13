BEGIN;

ALTER TABLE card_return_receipt
  ADD COLUMN IF NOT EXISTS restored_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_limit numeric(14,3);

CREATE INDEX IF NOT EXISTS idx_card_return_receipt_restored ON card_return_receipt(restored_at DESC) WHERE restored_at IS NOT NULL;

COMMIT;
