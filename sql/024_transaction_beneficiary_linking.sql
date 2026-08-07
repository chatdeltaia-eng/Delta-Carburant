BEGIN;

ALTER TABLE transaction_review
  DROP CONSTRAINT IF EXISTS transaction_review_issue_type_check;
ALTER TABLE transaction_review
  ADD CONSTRAINT transaction_review_issue_type_check
  CHECK (issue_type IN ('UNKNOWN_CARD','UNKNOWN_VEHICLE','MISSING_BENEFICIARY'));
ALTER TABLE transaction_review
  ADD COLUMN IF NOT EXISTS beneficiary_name text;

COMMIT;
