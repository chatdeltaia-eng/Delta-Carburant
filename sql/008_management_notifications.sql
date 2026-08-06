BEGIN;

ALTER TABLE notification ADD COLUMN IF NOT EXISTS target_view text;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS entity_id uuid;

CREATE INDEX IF NOT EXISTS idx_notification_user_unread
  ON notification(user_id, created_at DESC) WHERE read_at IS NULL;

-- Les suppressions sont auditables et réversibles par restauration de sauvegarde.
ALTER TABLE fuel_transaction ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE fuel_transaction ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES app_user(id);
CREATE INDEX IF NOT EXISTS idx_transaction_not_deleted
  ON fuel_transaction(transaction_date DESC) WHERE deleted_at IS NULL;

COMMIT;
