BEGIN;

ALTER TABLE fuel_transaction
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_user(id);

CREATE INDEX IF NOT EXISTS idx_fuel_transaction_current
  ON fuel_transaction(transaction_date DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fuel_transaction_archive
  ON fuel_transaction(archived_at DESC,transaction_date DESC)
  WHERE archived_at IS NOT NULL;

-- Répare les restaurations de test antérieures : la carte est de nouveau
-- utilisable par Najib, sans toucher à son plafond ni à ses transactions.
UPDATE fuel_card fc SET status='ACTIVE'
FROM card_return_receipt rr
WHERE rr.fuel_card_id=fc.id AND rr.restored_at IS NOT NULL
  AND fc.status IN('DISTRIBUTED','ASSIGNED');

COMMIT;
