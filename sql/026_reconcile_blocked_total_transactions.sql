BEGIN;

-- Aligne les cartes existantes sur la société du véhicule reconnu. Les cartes
-- ont parfois été initialisées sous DELTA avant l'import du parc DCD/DC.
WITH matched AS (
  SELECT DISTINCT ON (fc.id) fc.id AS card_id,v.company_id
  FROM fuel_card fc
  JOIN vehicle v ON v.active AND v.deleted_at IS NULL
   AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
     regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'),
     regexp_replace(regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1')
   )
  WHERE fc.deleted_at IS NULL AND fc.official_registration IS NOT NULL
    AND fc.official_registration NOT ILIKE 'HORS%'
)
UPDATE fuel_card fc SET company_id=m.company_id,updated_at=now()
FROM matched m WHERE fc.id=m.card_id AND fc.company_id<>m.company_id;

-- Retraite sans intervention les transactions encore en attente lorsque le
-- numéro Total et la plaque identifient maintenant une carte et un véhicule.
WITH candidates AS (
  SELECT DISTINCT ON (tr.id) tr.*,fc.id AS card_id,v.id AS vehicle_id,v.company_id,
    coalesce(nullif(trim(tr.beneficiary_name),''),nullif(trim(fc.holder_name),''),
      nullif(trim(v.driver_name),''),'Titulaire '||v.registration_display) AS beneficiary_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.deleted_at IS NULL AND (
    regexp_replace(fc.masked_card_number,'[^0-9]','','g')=regexp_replace(tr.card_number,'[^0-9]','','g') OR
    fc.official_card_number=regexp_replace(tr.card_number,'[^0-9]','','g') OR
    fc.total_payment_number=regexp_replace(tr.card_number,'[^0-9]','','g'))
  JOIN vehicle v ON v.active AND v.deleted_at IS NULL AND v.company_id=fc.company_id
   AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
     regexp_replace(upper(tr.vehicle_registration),'[^A-Z0-9]','','g'),
     regexp_replace(regexp_replace(upper(tr.vehicle_registration),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1'))
  WHERE tr.status='PENDING'
), departments AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT company_id,'Transactions importées' FROM candidates
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id,company_id
), beneficiaries AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT c.company_id,d.id,c.beneficiary_name FROM candidates c JOIN departments d USING(company_id)
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id,company_id,display_name
), assignments_updated AS (
  UPDATE card_assignment ca SET beneficiary_id=b.id,vehicle_id=c.vehicle_id,
    workflow_status='APPROVED_ZIN',reviewed_at=now()
  FROM candidates c JOIN beneficiaries b ON b.company_id=c.company_id AND b.display_name=c.beneficiary_name
  WHERE ca.fuel_card_id=c.card_id AND ca.ends_at IS NULL AND ca.is_primary
  RETURNING ca.fuel_card_id
), assignments_inserted AS (
  INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status)
  SELECT DISTINCT c.card_id,b.id,c.vehicle_id,'APPROVED_ZIN'
  FROM candidates c JOIN beneficiaries b ON b.company_id=c.company_id AND b.display_name=c.beneficiary_name
  WHERE NOT EXISTS(SELECT 1 FROM card_assignment ca
    WHERE ca.fuel_card_id=c.card_id AND ca.ends_at IS NULL AND ca.is_primary)
  RETURNING fuel_card_id
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,
    station,product,quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,
    previous_mileage,reported_mileage,authorization_code)
  SELECT CASE WHEN c.authorization_code IS NOT NULL AND trim(c.authorization_code)<>'' THEN 'TOTAL:'||trim(c.authorization_code)
    ELSE 'review:'||c.id END,c.card_id,b.id,c.vehicle_id,c.transaction_date,c.station,c.product,
    c.quantity_liters,c.amount_incl_tax,'TOTAL_EXCEL',c.import_batch_id,c.source_row_number,
    c.previous_mileage,c.reported_mileage,c.authorization_code
  FROM candidates c JOIN beneficiaries b ON b.company_id=c.company_id AND b.display_name=c.beneficiary_name
  ON CONFLICT(external_transaction_id,source) DO NOTHING RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),
  decision_reason='Rapprochement automatique carte, titulaire et véhicule'
WHERE tr.status='PENDING' AND EXISTS (
  SELECT 1 FROM fuel_transaction ft WHERE ft.deleted_at IS NULL
    AND ft.import_batch_id=tr.import_batch_id AND ft.source_row_number=tr.source_row_number);

COMMIT;
