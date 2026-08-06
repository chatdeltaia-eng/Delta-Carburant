BEGIN;

CREATE TYPE card_status AS ENUM (
  'DRAFT', 'REQUESTED', 'ORDERED', 'RECEIVED', 'TO_ASSIGN', 'ASSIGNED',
  'ACTIVE', 'SUSPENDED', 'OPPOSED', 'LOST', 'STOLEN', 'DAMAGED',
  'EXPIRED', 'REPLACED', 'CANCELLED', 'RETURNED', 'SAFE'
);
CREATE TYPE import_status AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK');
CREATE TYPE issue_severity AS ENUM ('INFO', 'WARNING', 'HIGH', 'CRITICAL');

CREATE TABLE company (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code citext NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE department (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  name citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE beneficiary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  department_id uuid REFERENCES department(id),
  employee_number citext,
  display_name citext NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, display_name)
);

CREATE TABLE vehicle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  registration_normalized citext NOT NULL,
  registration_display text NOT NULL,
  brand text,
  model text,
  active boolean NOT NULL DEFAULT true,
  requires_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, registration_normalized)
);

CREATE TABLE fuel_card (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  card_number_ciphertext bytea NOT NULL,
  card_number_hmac bytea NOT NULL UNIQUE,
  masked_card_number text NOT NULL,
  pin_ciphertext bytea,
  monthly_limit numeric(14,3) NOT NULL CHECK (monthly_limit >= 0),
  threshold_alert_enabled boolean NOT NULL DEFAULT false,
  status card_status NOT NULL DEFAULT 'DRAFT',
  legacy_state text,
  old_card_id uuid REFERENCES fuel_card(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  beneficiary_id uuid NOT NULL REFERENCES beneficiary(id),
  vehicle_id uuid REFERENCES vehicle(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE UNIQUE INDEX uq_active_primary_card_assignment
  ON card_assignment(fuel_card_id)
  WHERE ends_at IS NULL AND is_primary;

CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_sha256 text NOT NULL UNIQUE,
  status import_status NOT NULL DEFAULT 'RUNNING',
  total_rows integer NOT NULL DEFAULT 0,
  accepted_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  rejected_rows integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE TABLE import_row (
  id bigserial PRIMARY KEY,
  import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE RESTRICT,
  source_row_number integer NOT NULL,
  company_raw text,
  card_number_raw text,
  pin_raw_ciphertext bytea,
  vehicle_raw text,
  brand_raw text,
  registration_raw text,
  monthly_limit_raw text,
  state_raw text,
  beneficiary_raw text,
  department_raw text,
  threshold_alert_raw text,
  processed_at timestamptz,
  UNIQUE (import_batch_id, source_row_number)
);

CREATE TABLE data_quality_issue (
  id bigserial PRIMARY KEY,
  import_row_id bigint REFERENCES import_row(id),
  entity_type text,
  entity_id uuid,
  issue_code text NOT NULL,
  severity issue_severity NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  import_batch_id uuid REFERENCES import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_TABLE_NAME = 'fuel_card' THEN NEW.version = OLD.version + 1; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER company_touch BEFORE UPDATE ON company
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER beneficiary_touch BEFORE UPDATE ON beneficiary
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER vehicle_touch BEFORE UPDATE ON vehicle
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER fuel_card_touch BEFORE UPDATE ON fuel_card
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE VIEW v_fuel_card_list AS
SELECT fc.id, c.code AS company_code, fc.masked_card_number, fc.monthly_limit,
       fc.threshold_alert_enabled, fc.status, fc.legacy_state,
       b.display_name AS beneficiary, v.registration_display AS registration,
       v.brand, v.model, fc.updated_at
FROM fuel_card fc
JOIN company c ON c.id = fc.company_id
LEFT JOIN card_assignment ca
  ON ca.fuel_card_id = fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id = ca.beneficiary_id
LEFT JOIN vehicle v ON v.id = ca.vehicle_id;

COMMIT;

