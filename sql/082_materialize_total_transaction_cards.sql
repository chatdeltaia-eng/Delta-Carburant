BEGIN;

-- Une carte presente dans le journal officiel Total ne doit pas rester absente
-- de l'application lorsque la societe et le vehicule sont deja identifies.
WITH candidates AS (
  SELECT DISTINCT ON (tr.company_id,right(regexp_replace(tr.card_number,'[^0-9]','','g'),4))
    tr.company_id,right(regexp_replace(tr.card_number,'[^0-9]','','g'),4) AS card_number,
    v.id AS vehicle_id,v.registration_display
  FROM transaction_review tr
  JOIN vehicle v ON v.company_id=tr.company_id AND v.active AND v.deleted_at IS NULL
    AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
      regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
      regexp_replace(regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1'))
  WHERE tr.status='PENDING' AND tr.issue_type='UNKNOWN_CARD' AND tr.company_id IS NOT NULL
    AND length(regexp_replace(tr.card_number,'[^0-9]','','g'))>=4
  ORDER BY tr.company_id,right(regexp_replace(tr.card_number,'[^0-9]','','g'),4),tr.transaction_date DESC
)
INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,
  card_category,official_card_number,total_payment_number,official_registration,reference_vehicle_id)
SELECT company_id,pgp_sym_encrypt(card_number,$1,'cipher-algo=aes256'),hmac(card_number,$2,'sha256'),
  card_number,0,'TO_ASSIGN','PERSONALIZED',card_number,card_number,registration_display,vehicle_id
FROM candidates
ON CONFLICT(company_id,card_number_hmac) DO UPDATE SET deleted_at=NULL,
  official_registration=excluded.official_registration,reference_vehicle_id=excluded.reference_vehicle_id,updated_at=now();

WITH matches AS (
  SELECT DISTINCT ON (tr.id) tr.id AS review_id,fc.id AS card_id,fc.company_id,v.id AS vehicle_id,
    coalesce(nullif(trim(tr.beneficiary_name),''),nullif(trim(fc.holder_name),''),nullif(trim(v.driver_name),''),
      'Conducteur '||v.registration_display) AS beneficiary_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.company_id=tr.company_id AND fc.deleted_at IS NULL
    AND right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4)=right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)
  JOIN vehicle v ON v.company_id=fc.company_id AND v.active AND v.deleted_at IS NULL
    AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
      regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
      regexp_replace(regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1'))
  WHERE tr.status='PENDING' AND tr.issue_type='UNKNOWN_CARD'
  ORDER BY tr.id,v.updated_at DESC NULLS LAST
), departments AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT fc.company_id,'Transactions importees' FROM matches m JOIN fuel_card fc ON fc.id=m.card_id
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id,company_id
), beneficiaries AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT fc.company_id,d.id,m.beneficiary_name FROM matches m
  JOIN fuel_card fc ON fc.id=m.card_id JOIN departments d ON d.company_id=fc.company_id
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id,company_id,display_name
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,
    station,product,quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code)
  SELECT coalesce('TOTAL:'||nullif(trim(tr.authorization_code),''),'review:'||tr.id::text),m.card_id,b.id,m.vehicle_id,
    tr.transaction_date,tr.station,tr.product,tr.quantity_liters,tr.amount_incl_tax,'TOTAL_EXCEL',tr.import_batch_id,
    tr.source_row_number,tr.previous_mileage,tr.reported_mileage,tr.authorization_code
  FROM matches m JOIN transaction_review tr ON tr.id=m.review_id JOIN fuel_card fc ON fc.id=m.card_id
  JOIN beneficiaries b ON b.company_id=fc.company_id AND b.display_name=m.beneficiary_name
  ON CONFLICT(external_transaction_id,source) DO UPDATE SET fuel_card_id=excluded.fuel_card_id,
    beneficiary_id=excluded.beneficiary_id,vehicle_id=excluded.vehicle_id,deleted_at=NULL,deleted_by=NULL
  RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr SET status='ACCEPTED',fuel_card_id=m.card_id,decided_at=now(),
  decision_reason='Carte creee automatiquement depuis la transaction officielle Total'
FROM matches m WHERE tr.id=m.review_id AND EXISTS(SELECT 1 FROM inserted i
  WHERE i.import_batch_id=tr.import_batch_id AND i.source_row_number=tr.source_row_number);

COMMIT;
