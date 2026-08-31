BEGIN;

ALTER TABLE fuel_card
  ADD COLUMN IF NOT EXISTS total_payment_method_type text;

CREATE OR REPLACE VIEW v_fuel_card_list AS
SELECT fc.id, c.code AS company_code, fc.masked_card_number, fc.monthly_limit,
       fc.threshold_alert_enabled, fc.status, fc.legacy_state,
       coalesce(b.display_name,fc.holder_name) AS beneficiary, d.name AS department,
       coalesce(v.registration_display,fc.official_registration) AS registration, v.brand, v.model,
       concat_ws(' ',v.brand,v.model) AS vehicle_model,
       CASE ca.workflow_status WHEN 'APPROVED_ZIN' THEN 'CONFIRMED'
         WHEN 'REJECTED_ZIN' THEN 'REJECTED' ELSE 'PENDING' END AS finance_status,
       fc.blocked_reason, fc.created_at, fc.updated_at,
       fc.card_category, fc.responsible_user_id, fc.company_id,
       fc.official_card_number, fc.total_payment_number, fc.holder_name,
       fc.official_registration, fc.expires_on,fc.total_payment_method_type
FROM fuel_card fc JOIN company c ON c.id=fc.company_id
LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
LEFT JOIN beneficiary b ON b.id=ca.beneficiary_id
LEFT JOIN department d ON d.id=b.department_id
LEFT JOIN vehicle v ON v.id=ca.vehicle_id
WHERE fc.deleted_at IS NULL;

COMMIT;
