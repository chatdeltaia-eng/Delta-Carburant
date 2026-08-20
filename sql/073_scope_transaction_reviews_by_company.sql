BEGIN;

ALTER TABLE transaction_review ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES company(id);

UPDATE transaction_review tr SET company_id=fc.company_id
FROM fuel_card fc WHERE tr.fuel_card_id=fc.id AND tr.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_review_company_pending
  ON transaction_review(company_id,transaction_date) WHERE status='PENDING';

COMMIT;
