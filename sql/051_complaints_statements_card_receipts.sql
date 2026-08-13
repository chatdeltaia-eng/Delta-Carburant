BEGIN;

CREATE TABLE IF NOT EXISTS complaint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_number text NOT NULL UNIQUE,
  subject text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH','URGENT')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  created_by uuid NOT NULL REFERENCES app_user(id),
  target_role user_role NOT NULL,
  assigned_to uuid REFERENCES app_user(id),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaint_tracking ON complaint(status,target_role,created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaint(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES app_user(id),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_complaint_message ON complaint_message(complaint_id,created_at);

CREATE TABLE IF NOT EXISTS card_distribution_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  beneficiary_id uuid REFERENCES beneficiary(id),
  vehicle_id uuid REFERENCES vehicle(id),
  distributed_to uuid REFERENCES app_user(id),
  requested_by uuid REFERENCES app_user(id),
  zin_approved_by uuid REFERENCES app_user(id),
  zin_approved_at timestamptz,
  dg_approved_by uuid REFERENCES app_user(id),
  dg_approved_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORIZED','REVOKED')),
  issued_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(fuel_card_id)
);
CREATE INDEX IF NOT EXISTS idx_card_receipt_status ON card_distribution_receipt(status,created_at DESC);

INSERT INTO card_distribution_receipt(receipt_number,fuel_card_id,beneficiary_id,vehicle_id,distributed_to,requested_by)
SELECT 'RCD-'||to_char(current_date,'YYYY')||'-'||upper(substr(replace(fc.id::text,'-',''),1,10)),
  fc.id,ca.beneficiary_id,ca.vehicle_id,fc.responsible_user_id,coalesce(ca.requested_by,fc.responsible_user_id)
FROM fuel_card fc
LEFT JOIN LATERAL (
  SELECT beneficiary_id,vehicle_id,requested_by FROM card_assignment
  WHERE fuel_card_id=fc.id AND ends_at IS NULL ORDER BY starts_at DESC LIMIT 1
) ca ON true
WHERE fc.deleted_at IS NULL AND fc.status IN ('ACTIVE','DISTRIBUTED','ASSIGNED')
ON CONFLICT(fuel_card_id) DO NOTHING;

COMMIT;
