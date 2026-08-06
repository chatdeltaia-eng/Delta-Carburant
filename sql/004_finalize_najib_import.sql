\set ON_ERROR_STOP on

SELECT set_config('app.card_encryption_key', :'card_encryption_key', true);
SELECT set_config('app.card_hmac_key', :'card_hmac_key', true);
SELECT set_config('app.pin_encryption_key', :'pin_encryption_key', true);

CREATE TEMP TABLE import_context AS
WITH inserted AS (
  INSERT INTO import_batch(source_name, source_sha256, total_rows)
  VALUES (:'source_name', :'source_sha256', (SELECT count(*) FROM najib_stage))
  RETURNING id
)
SELECT id AS batch_id FROM inserted;

INSERT INTO import_row(
  import_batch_id, source_row_number, company_raw, card_number_raw,
  pin_raw_ciphertext, vehicle_raw, brand_raw, registration_raw,
  monthly_limit_raw, state_raw, beneficiary_raw, department_raw,
  threshold_alert_raw
)
SELECT x.batch_id, s.source_row_number, upper(trim(s.company_raw)),
       trim(s.card_number_raw),
       CASE WHEN nullif(trim(s.pin_raw), '') IS NULL THEN NULL
            ELSE pgp_sym_encrypt(trim(s.pin_raw), current_setting('app.pin_encryption_key'),
                                 'cipher-algo=aes256') END,
       nullif(trim(s.vehicle_raw), ''), nullif(trim(s.brand_raw), ''),
       nullif(trim(s.registration_raw), ''), trim(s.monthly_limit_raw),
       upper(trim(s.state_raw)), trim(s.beneficiary_raw),
       trim(s.department_raw), upper(trim(s.threshold_alert_raw))
FROM najib_stage s CROSS JOIN import_context x;

INSERT INTO company(code, name)
SELECT DISTINCT upper(trim(company_raw)), upper(trim(company_raw))
FROM najib_stage
ON CONFLICT (code) DO UPDATE SET active = true;

INSERT INTO department(company_id, name)
SELECT DISTINCT c.id, trim(s.department_raw)
FROM najib_stage s JOIN company c ON c.code = upper(trim(s.company_raw))
WHERE nullif(trim(s.department_raw), '') IS NOT NULL
ON CONFLICT (company_id, name) DO NOTHING;

INSERT INTO beneficiary(company_id, department_id, display_name)
SELECT DISTINCT ON (c.id, trim(s.beneficiary_raw))
       c.id, d.id, trim(s.beneficiary_raw)
FROM najib_stage s
JOIN company c ON c.code = upper(trim(s.company_raw))
LEFT JOIN department d
  ON d.company_id = c.id AND d.name = trim(s.department_raw)
WHERE nullif(trim(s.beneficiary_raw), '') IS NOT NULL
ORDER BY c.id, trim(s.beneficiary_raw), s.source_row_number DESC
ON CONFLICT (company_id, display_name) DO UPDATE
SET department_id = EXCLUDED.department_id, active = true;

INSERT INTO vehicle(
  company_id, registration_normalized, registration_display, brand, model,
  requires_review
)
SELECT DISTINCT ON (c.id, regexp_replace(upper(trim(s.registration_raw)), '[^A-Z0-9]', '', 'g'))
       c.id,
       regexp_replace(upper(trim(s.registration_raw)), '[^A-Z0-9]', '', 'g'),
       trim(s.registration_raw), nullif(upper(trim(s.brand_raw)), ''),
       nullif(trim(s.vehicle_raw), ''),
       trim(s.registration_raw) ~ '^[0-9]+$'
       OR upper(trim(s.registration_raw)) SIMILAR TO '%(HORSPARC|ANCIEN|CHARIOT)%'
FROM najib_stage s
JOIN company c ON c.code = upper(trim(s.company_raw))
WHERE nullif(trim(s.registration_raw), '') IS NOT NULL
ORDER BY c.id,
         regexp_replace(upper(trim(s.registration_raw)), '[^A-Z0-9]', '', 'g'),
         s.source_row_number DESC
ON CONFLICT (company_id, registration_normalized) DO UPDATE
SET registration_display = EXCLUDED.registration_display,
    brand = COALESCE(EXCLUDED.brand, vehicle.brand),
    model = COALESCE(EXCLUDED.model, vehicle.model),
    requires_review = EXCLUDED.requires_review;

INSERT INTO fuel_card(
  company_id, card_number_ciphertext, card_number_hmac, masked_card_number,
  pin_ciphertext, monthly_limit, threshold_alert_enabled, status, legacy_state
)
SELECT c.id,
       pgp_sym_encrypt(trim(s.card_number_raw), current_setting('app.card_encryption_key'),
                       'cipher-algo=aes256'),
       hmac(trim(s.card_number_raw), current_setting('app.card_hmac_key'), 'sha256'),
       '•••• ' || right(trim(s.card_number_raw), LEAST(4, length(trim(s.card_number_raw)))),
       CASE WHEN nullif(trim(s.pin_raw), '') IS NULL THEN NULL
            ELSE pgp_sym_encrypt(trim(s.pin_raw), current_setting('app.pin_encryption_key'),
                                 'cipher-algo=aes256') END,
       trim(s.monthly_limit_raw)::numeric(14,3),
       upper(trim(s.threshold_alert_raw)) = 'OUI',
       CASE upper(trim(s.state_raw))
         WHEN 'F' THEN 'ACTIVE'::card_status
         WHEN 'NF' THEN 'SUSPENDED'::card_status
         WHEN 'COFFRE' THEN 'SAFE'::card_status
         ELSE 'DRAFT'::card_status
       END,
       upper(trim(s.state_raw))
FROM najib_stage s
JOIN company c ON c.code = upper(trim(s.company_raw))
ON CONFLICT (card_number_hmac) DO UPDATE SET
  company_id = EXCLUDED.company_id,
  pin_ciphertext = COALESCE(EXCLUDED.pin_ciphertext, fuel_card.pin_ciphertext),
  monthly_limit = EXCLUDED.monthly_limit,
  threshold_alert_enabled = EXCLUDED.threshold_alert_enabled,
  status = EXCLUDED.status,
  legacy_state = EXCLUDED.legacy_state;

CREATE TEMP TABLE resolved_assignment AS
SELECT fc.id AS fuel_card_id, b.id AS beneficiary_id, v.id AS vehicle_id,
       s.source_row_number
FROM najib_stage s
JOIN company c ON c.code = upper(trim(s.company_raw))
JOIN fuel_card fc
  ON fc.card_number_hmac = hmac(trim(s.card_number_raw), current_setting('app.card_hmac_key'), 'sha256')
JOIN beneficiary b
  ON b.company_id = c.id AND b.display_name = trim(s.beneficiary_raw)
LEFT JOIN vehicle v
  ON v.company_id = c.id
 AND v.registration_normalized = regexp_replace(upper(trim(s.registration_raw)), '[^A-Z0-9]', '', 'g');

UPDATE card_assignment ca SET ends_at = now()
FROM resolved_assignment r
WHERE ca.fuel_card_id = r.fuel_card_id AND ca.ends_at IS NULL AND ca.is_primary
  AND (ca.beneficiary_id IS DISTINCT FROM r.beneficiary_id
       OR ca.vehicle_id IS DISTINCT FROM r.vehicle_id);

INSERT INTO card_assignment(fuel_card_id, beneficiary_id, vehicle_id)
SELECT r.fuel_card_id, r.beneficiary_id, r.vehicle_id
FROM resolved_assignment r
WHERE NOT EXISTS (
  SELECT 1 FROM card_assignment ca
  WHERE ca.fuel_card_id = r.fuel_card_id AND ca.ends_at IS NULL AND ca.is_primary
);

INSERT INTO data_quality_issue(import_row_id, issue_code, severity, details)
SELECT ir.id, 'MISSING_PIN', 'WARNING', jsonb_build_object('column', 'CODE PIN')
FROM import_row ir CROSS JOIN import_context x
WHERE ir.import_batch_id = x.batch_id AND ir.pin_raw_ciphertext IS NULL;

INSERT INTO data_quality_issue(import_row_id, issue_code, severity, details)
SELECT ir.id, 'MISSING_VEHICLE', 'WARNING', jsonb_build_object('column', 'IMMATRICULATION')
FROM import_row ir CROSS JOIN import_context x
WHERE ir.import_batch_id = x.batch_id AND nullif(trim(ir.registration_raw), '') IS NULL;

INSERT INTO data_quality_issue(import_row_id, issue_code, severity, details)
SELECT ir.id, 'REGISTRATION_REQUIRES_REVIEW', 'HIGH',
       jsonb_build_object('registration', ir.registration_raw)
FROM import_row ir CROSS JOIN import_context x
WHERE ir.import_batch_id = x.batch_id
  AND (trim(ir.registration_raw) ~ '^[0-9]+$'
       OR upper(trim(ir.registration_raw)) SIMILAR TO '%(HORSPARC|ANCIEN|CHARIOT)%');

INSERT INTO audit_log(actor, action, entity_type, entity_id, new_values, import_batch_id)
SELECT 'excel-import', 'IMPORT_OR_UPDATE', 'FuelCard', fc.id::text,
       jsonb_build_object('maskedCardNumber', fc.masked_card_number,
                          'companyId', fc.company_id,
                          'status', fc.status,
                          'monthlyLimit', fc.monthly_limit),
       x.batch_id
FROM fuel_card fc
JOIN najib_stage s
  ON fc.card_number_hmac = hmac(trim(s.card_number_raw), current_setting('app.card_hmac_key'), 'sha256')
CROSS JOIN import_context x;

UPDATE import_row SET processed_at = now()
WHERE import_batch_id = (SELECT batch_id FROM import_context);

UPDATE import_batch b SET
  status = 'COMPLETED',
  accepted_rows = b.total_rows,
  warning_rows = (SELECT count(DISTINCT ir.source_row_number)
                  FROM import_row ir JOIN data_quality_issue dqi ON dqi.import_row_id = ir.id
                  WHERE ir.import_batch_id = b.id),
  completed_at = now()
WHERE b.id = (SELECT batch_id FROM import_context);

COMMIT;

SELECT id, source_name, status, total_rows, accepted_rows, warning_rows,
       rejected_rows, completed_at
FROM import_batch WHERE id = (SELECT batch_id FROM import_context);

