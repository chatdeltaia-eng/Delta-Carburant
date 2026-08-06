BEGIN;

-- La demande validée est liée à la carte créée. L'affectation active devient
-- l'unique source de vérité commune aux vues Cartes, Bénéficiaires et Véhicules.
DROP VIEW IF EXISTS v_fuel_card_list;

CREATE VIEW v_fuel_card_list AS
SELECT fc.id,
       c.code AS company_code,
       fc.masked_card_number,
       fc.monthly_limit,
       fc.threshold_alert_enabled,
       fc.status,
       fc.legacy_state,
       b.display_name AS beneficiary,
       d.name AS department,
       v.registration_display AS registration,
       v.brand,
       v.model,
       concat_ws(' ', v.brand, v.model) AS vehicle_model,
       CASE ca.workflow_status
         WHEN 'APPROVED_ZIN' THEN 'CONFIRMED'
         WHEN 'REJECTED_ZIN' THEN 'REJECTED'
         ELSE 'PENDING'
       END AS finance_status,
       fc.blocked_reason,
       fc.created_at,
       fc.updated_at
FROM fuel_card fc
JOIN company c ON c.id = fc.company_id
LEFT JOIN card_assignment ca
  ON ca.fuel_card_id = fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id = ca.beneficiary_id
LEFT JOIN department d ON d.id = b.department_id
LEFT JOIN vehicle v ON v.id = ca.vehicle_id
WHERE fc.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_beneficiary_card_tracking AS
SELECT b.id, b.display_name, d.name AS department, b.active,
       fc.id AS fuel_card_id, fc.masked_card_number, fc.status AS card_status,
       v.id AS vehicle_id, v.registration_display, concat_ws(' ',v.brand,v.model) AS vehicle_model,
       ca.starts_at AS assigned_at, ca.workflow_status
FROM beneficiary b
LEFT JOIN department d ON d.id=b.department_id
LEFT JOIN card_assignment ca ON ca.beneficiary_id=b.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN fuel_card fc ON fc.id=ca.fuel_card_id AND fc.deleted_at IS NULL
LEFT JOIN vehicle v ON v.id=ca.vehicle_id AND v.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_vehicle_card_tracking AS
SELECT v.id, v.registration_display, v.brand, v.model, v.active,
       b.id AS beneficiary_id, b.display_name AS beneficiary,
       fc.id AS fuel_card_id, fc.masked_card_number, fc.status AS card_status,
       ca.starts_at AS assigned_at, ca.workflow_status
FROM vehicle v
LEFT JOIN card_assignment ca ON ca.vehicle_id=v.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN fuel_card fc ON fc.id=ca.fuel_card_id AND fc.deleted_at IS NULL
LEFT JOIN beneficiary b ON b.id=ca.beneficiary_id
WHERE v.deleted_at IS NULL;

COMMIT;
