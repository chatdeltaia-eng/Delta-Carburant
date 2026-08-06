BEGIN;

CREATE TYPE user_role AS ENUM (
  'SUPER_ADMIN', 'FUEL_ADMIN', 'FUEL_OPERATOR', 'FLEET_MANAGER',
  'BENEFICIARY', 'AUDITOR', 'DIRECTION'
);
CREATE TYPE request_status AS ENUM (
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'INFORMATION_REQUIRED',
  'SENT_TO_PROVIDER', 'ORDERED', 'RECEIVED', 'ASSIGNED', 'CLOSED',
  'REJECTED', 'CANCELLED'
);
CREATE TYPE request_type AS ENUM (
  'NEW_CARD', 'REPLACEMENT', 'RENEWAL', 'OPPOSITION', 'ASSIGNMENT_CHANGE',
  'LIMIT_CHANGE', 'SUSPENSION', 'REACTIVATION', 'CANCELLATION'
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES company(id),
  beneficiary_id uuid REFERENCES beneficiary(id),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mileage_reading (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicle(id),
  beneficiary_id uuid REFERENCES beneficiary(id),
  reading_date timestamptz NOT NULL DEFAULT now(),
  mileage numeric(14,1) NOT NULL CHECK (mileage >= 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VALIDATED','REJECTED')),
  rejection_reason text,
  source text NOT NULL DEFAULT 'MANUAL',
  created_by uuid REFERENCES app_user(id),
  validated_by uuid REFERENCES app_user(id),
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fuel_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_transaction_id text,
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  vehicle_id uuid REFERENCES vehicle(id),
  beneficiary_id uuid REFERENCES beneficiary(id),
  transaction_date timestamptz NOT NULL,
  station text,
  city text,
  product text,
  quantity_liters numeric(14,3) NOT NULL CHECK (quantity_liters > 0),
  unit_price numeric(14,3),
  amount_excl_tax numeric(14,3),
  tax_amount numeric(14,3),
  amount_incl_tax numeric(14,3) NOT NULL CHECK (amount_incl_tax >= 0),
  mileage numeric(14,1),
  distance_traveled numeric(14,1),
  consumption_per_100km numeric(14,3),
  cost_per_km numeric(14,3),
  source text NOT NULL DEFAULT 'MANUAL',
  validation_status text NOT NULL DEFAULT 'PENDING',
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_transaction_id, source)
);

CREATE TABLE card_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number text NOT NULL UNIQUE,
  request_type request_type NOT NULL,
  status request_status NOT NULL DEFAULT 'DRAFT',
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  beneficiary_id uuid REFERENCES beneficiary(id),
  vehicle_id uuid REFERENCES vehicle(id),
  fuel_card_id uuid REFERENCES fuel_card(id),
  reason text NOT NULL,
  requested_limit numeric(14,3),
  approved_by uuid REFERENCES app_user(id),
  decision_date timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anomaly (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_transaction_id uuid REFERENCES fuel_transaction(id),
  fuel_card_id uuid REFERENCES fuel_card(id),
  vehicle_id uuid REFERENCES vehicle(id),
  anomaly_type text NOT NULL,
  severity issue_severity NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  description text NOT NULL,
  assigned_to uuid REFERENCES app_user(id),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  severity issue_severity NOT NULL DEFAULT 'INFO',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transaction_date ON fuel_transaction(transaction_date DESC);
CREATE INDEX idx_transaction_card ON fuel_transaction(fuel_card_id, transaction_date DESC);
CREATE INDEX idx_mileage_vehicle ON mileage_reading(vehicle_id, reading_date DESC);
CREATE INDEX idx_request_status ON card_request(status, created_at DESC);
CREATE INDEX idx_anomaly_status ON anomaly(status, severity, created_at DESC);

CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER card_request_touch BEFORE UPDATE ON card_request
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

