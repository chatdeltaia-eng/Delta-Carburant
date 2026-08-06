BEGIN;

-- Cycle de vie complet : une carte archivée ne détruit jamais son historique.
ALTER TABLE fuel_card
  ADD COLUMN IF NOT EXISTS card_reference text,
  ADD COLUMN IF NOT EXISTS replacement_card_id uuid REFERENCES fuel_card(id),
  ADD COLUMN IF NOT EXISTS opposition_reason text,
  ADD COLUMN IF NOT EXISTS opposed_at timestamptz,
  ADD COLUMN IF NOT EXISTS opposed_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES app_user(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_card_reference
  ON fuel_card(card_reference) WHERE card_reference IS NOT NULL;

ALTER TABLE fuel_transaction
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrected_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS correction_reason text;

CREATE TABLE IF NOT EXISTS fuel_transaction_revision (
  id bigserial PRIMARY KEY,
  fuel_transaction_id uuid NOT NULL REFERENCES fuel_transaction(id),
  changed_by uuid REFERENCES app_user(id),
  old_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW v_card_lifecycle AS
WITH RECURSIVE chain AS (
  SELECT fc.id AS root_card_id, fc.id AS card_id, 0 AS generation
  FROM fuel_card fc WHERE fc.old_card_id IS NULL
  UNION ALL
  SELECT chain.root_card_id, child.id, chain.generation + 1
  FROM chain JOIN fuel_card child ON child.old_card_id = chain.card_id
)
SELECT chain.root_card_id, chain.card_id, chain.generation,
       fc.masked_card_number, fc.card_reference, fc.status, fc.created_at,
       fc.old_card_id, fc.replacement_card_id,
       b.display_name AS beneficiary, d.name AS department,
       v.registration_display AS registration, v.brand, v.model,
       fc.monthly_limit,
       coalesce(sum(ft.quantity_liters) FILTER (WHERE ft.deleted_at IS NULL), 0) AS total_liters,
       coalesce(sum(ft.amount_incl_tax) FILTER (WHERE ft.deleted_at IS NULL), 0) AS total_amount
FROM chain
JOIN fuel_card fc ON fc.id = chain.card_id
LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id=ca.beneficiary_id
LEFT JOIN department d ON d.id=b.department_id
LEFT JOIN vehicle v ON v.id=ca.vehicle_id
LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id
GROUP BY chain.root_card_id, chain.card_id, chain.generation, fc.id,
         b.display_name, d.name, v.registration_display, v.brand, v.model;

CREATE OR REPLACE VIEW v_direction_card_reporting AS
SELECT lc.root_card_id,
       max(lc.masked_card_number) FILTER (WHERE lc.generation=0) AS old_card,
       max(lc.masked_card_number) FILTER (WHERE lc.generation>0) AS new_card,
       max(lc.beneficiary) AS beneficiary,
       max(lc.department::text) AS department,
       sum(lc.total_liters) AS lifecycle_liters,
       sum(lc.total_amount) AS lifecycle_amount,
       max(lc.generation) AS migrations
FROM v_card_lifecycle lc GROUP BY lc.root_card_id;

COMMIT;
