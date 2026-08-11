BEGIN;

ALTER TABLE transaction_import_batch
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS revert_reason text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE transaction_import_batch DROP CONSTRAINT IF EXISTS transaction_import_batch_status_check;
ALTER TABLE transaction_import_batch ADD CONSTRAINT transaction_import_batch_status_check
  CHECK (status IN ('COMPLETED','PARTIAL','REVERTED'));

CREATE INDEX IF NOT EXISTS idx_import_batch_date ON transaction_import_batch(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batch_status ON transaction_import_batch(status,imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_product_date ON fuel_transaction(product,transaction_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anomaly_active ON anomaly(status,severity,created_at DESC)
  WHERE status IN ('OPEN','IN_REVIEW');

COMMIT;
