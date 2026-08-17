BEGIN;

ALTER TABLE fuel_card
  ADD COLUMN IF NOT EXISTS total_mobility_status text,
  ADD COLUMN IF NOT EXISTS total_mobility_checked_at timestamptz;

ALTER TABLE card_request
  ADD COLUMN IF NOT EXISTS forced_return_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS forced_return_at timestamptz;

CREATE TABLE IF NOT EXISTS total_mobility_card_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number text NOT NULL,
  remote_status text NOT NULL,
  holder_name text,
  registration text,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_total_card_snapshot_number_date
  ON total_mobility_card_snapshot(card_number,extracted_at DESC);

CREATE TABLE IF NOT EXISTS total_mobility_card_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  action_type text NOT NULL CHECK(action_type IN ('DEACTIVATE','ACTIVATE','BLOCK','UNBLOCK')),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','FAILED','CANCELLED')),
  reason text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES app_user(id),
  remote_status text,
  error_message text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_total_card_action
  ON total_mobility_card_action(fuel_card_id,action_type) WHERE status='PENDING';

INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
VALUES('migration-061','ENABLE_TOTAL_CARD_RECONCILIATION','system','TOTAL_MOBILITY_CARDS',
  '{"source":"Gérer les cartes Total Mobility","safeRequiresRemoteInactive":true}'::jsonb);

COMMIT;
