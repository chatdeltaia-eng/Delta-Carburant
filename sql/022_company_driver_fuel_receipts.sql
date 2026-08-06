BEGIN;

ALTER TABLE card_request ADD COLUMN IF NOT EXISTS receipt_number text;
ALTER TABLE card_request ADD COLUMN IF NOT EXISTS receipt_issued_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_request_receipt ON card_request(receipt_number) WHERE receipt_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS driver (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  full_name text NOT NULL,
  cin text,
  phone text,
  license_number text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(company_id,full_name)
);

ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES driver(id);

CREATE TABLE IF NOT EXISTS fuel_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES company(id),
  product text NOT NULL,
  old_price numeric(12,3),
  new_price numeric(12,3) NOT NULL CHECK(new_price > 0),
  variation_percent numeric(10,4) NOT NULL,
  effective_date date NOT NULL DEFAULT current_date,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE anomaly ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_monthly_limit_anomaly
  ON anomaly(fuel_card_id,anomaly_type) WHERE status='OPEN' AND anomaly_type='MONTHLY_LIMIT_EXCEEDED';

COMMIT;
