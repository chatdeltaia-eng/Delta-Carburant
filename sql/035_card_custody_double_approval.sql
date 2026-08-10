BEGIN;

ALTER TYPE request_type ADD VALUE IF NOT EXISTS 'ASSIGNMENT_CHANGE';

ALTER TABLE card_request
  ADD COLUMN IF NOT EXISTS requested_card_status card_status,
  ADD COLUMN IF NOT EXISTS zin_approved_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS zin_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS dg_approved_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS dg_approved_at timestamptz;

COMMIT;
