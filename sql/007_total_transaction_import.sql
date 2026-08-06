BEGIN;

-- Les transactions proviennent exclusivement des exports Excel Total.
CREATE TABLE IF NOT EXISTS transaction_import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL UNIQUE,
  imported_by uuid REFERENCES app_user(id),
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  rejected_rows integer NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fuel_transaction
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES transaction_import_batch(id),
  ADD COLUMN IF NOT EXISTS source_row_number integer;

UPDATE fuel_transaction SET source = 'TOTAL_EXCEL' WHERE source = 'MANUAL';
ALTER TABLE fuel_transaction ALTER COLUMN source SET DEFAULT 'TOTAL_EXCEL';
ALTER TABLE fuel_transaction DROP CONSTRAINT IF EXISTS fuel_transaction_source_check;
ALTER TABLE fuel_transaction ADD CONSTRAINT fuel_transaction_source_check
  CHECK (source = 'TOTAL_EXCEL');

CREATE UNIQUE INDEX IF NOT EXISTS uq_total_transaction_source_row
  ON fuel_transaction(import_batch_id, source_row_number)
  WHERE import_batch_id IS NOT NULL;

COMMIT;
