BEGIN;

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ZIN_FINANCE';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'NAJIB_ASSIGNER';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'DIRECTION_GENERAL';

ALTER TABLE card_assignment
  ADD COLUMN IF NOT EXISTS workflow_status text NOT NULL DEFAULT 'PENDING_ZIN'
    CHECK (workflow_status IN ('PENDING_ZIN','APPROVED_ZIN','REJECTED_ZIN')),
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS decision_reason text;

ALTER TABLE fuel_card
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS blocked_reason text;

ALTER TABLE vehicle
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES app_user(id);

DROP VIEW IF EXISTS v_fuel_card_list;

CREATE VIEW v_fuel_card_list AS
SELECT fc.id, c.code AS company_code, fc.masked_card_number, fc.monthly_limit,
       fc.threshold_alert_enabled, fc.status, fc.legacy_state,
       b.display_name AS beneficiary, v.registration_display AS registration,
       v.brand, v.model, ca.workflow_status AS finance_status, fc.blocked_reason,
       fc.updated_at
FROM fuel_card fc
JOIN company c ON c.id = fc.company_id
LEFT JOIN card_assignment ca
  ON ca.fuel_card_id = fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id = ca.beneficiary_id
LEFT JOIN vehicle v ON v.id = ca.vehicle_id
WHERE fc.deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assignment_workflow
  ON card_assignment(workflow_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_request_requester
  ON card_request(requested_by, created_at DESC);

COMMIT;
