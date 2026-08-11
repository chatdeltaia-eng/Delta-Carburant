BEGIN;

ALTER TABLE card_request
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_user(id);

CREATE INDEX IF NOT EXISTS idx_card_request_active_created
  ON card_request(created_at DESC) WHERE archived_at IS NULL;

COMMIT;
