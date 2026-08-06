BEGIN;

CREATE TYPE card_category AS ENUM ('PERSONALIZED', 'OFF_PARK');

ALTER TABLE fuel_card
  ADD COLUMN card_category card_category NOT NULL DEFAULT 'PERSONALIZED',
  ADD COLUMN responsible_user_id uuid REFERENCES app_user(id);

CREATE TABLE transaction_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_transaction_id uuid NOT NULL REFERENCES fuel_transaction(id),
  beneficiary_id uuid NOT NULL REFERENCES beneficiary(id),
  vehicle_id uuid NOT NULL REFERENCES vehicle(id),
  allocated_amount numeric(14,3) NOT NULL CHECK (allocated_amount > 0),
  allocated_liters numeric(14,3) CHECK (allocated_liters IS NULL OR allocated_liters > 0),
  note text,
  allocated_by uuid NOT NULL REFERENCES app_user(id),
  allocated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transaction_allocation_transaction
  ON transaction_allocation(fuel_transaction_id, allocated_at);
CREATE INDEX idx_off_park_responsible
  ON fuel_card(responsible_user_id, status) WHERE card_category='OFF_PARK';

DROP VIEW IF EXISTS v_fuel_card_list;

CREATE VIEW v_fuel_card_list AS
SELECT fc.id, c.code AS company_code, fc.masked_card_number, fc.monthly_limit,
       fc.threshold_alert_enabled, fc.status, fc.legacy_state,
       b.display_name AS beneficiary, d.name AS department,
       v.registration_display AS registration, v.brand, v.model,
       concat_ws(' ',v.brand,v.model) AS vehicle_model,
       CASE ca.workflow_status WHEN 'APPROVED_ZIN' THEN 'CONFIRMED'
         WHEN 'REJECTED_ZIN' THEN 'REJECTED' ELSE 'PENDING' END AS finance_status,
       fc.blocked_reason, fc.created_at, fc.updated_at,
       fc.card_category, fc.responsible_user_id
FROM fuel_card fc JOIN company c ON c.id=fc.company_id
LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id=ca.beneficiary_id
LEFT JOIN department d ON d.id=b.department_id
LEFT JOIN vehicle v ON v.id=ca.vehicle_id
WHERE fc.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_off_park_transaction_tracking AS
SELECT ft.id, ft.transaction_date, ft.fuel_card_id, fc.masked_card_number,
       fc.monthly_limit, ft.amount_incl_tax, ft.quantity_liters, ft.station, ft.product,
       fc.responsible_user_id,
       coalesce(sum(ta.allocated_amount),0) AS allocated_amount,
       ft.amount_incl_tax-coalesce(sum(ta.allocated_amount),0) AS remaining_amount,
       count(ta.id)::int AS allocation_count
FROM fuel_transaction ft
JOIN fuel_card fc ON fc.id=ft.fuel_card_id AND fc.card_category='OFF_PARK'
LEFT JOIN transaction_allocation ta ON ta.fuel_transaction_id=ft.id
WHERE ft.deleted_at IS NULL
GROUP BY ft.id,fc.id;

COMMIT;
