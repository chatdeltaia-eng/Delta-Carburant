BEGIN;

-- Dans les exports de transactions Total, l'identite de la carte est le
-- suffixe a quatre chiffres du « Numero du mode/moyen de paiement ».
-- Les anciennes reprises exigeaient une seule ligne fuel_card par suffixe.
-- Des doublons techniques du referentiel pouvaient donc laisser toutes les
-- consommations correspondantes en UNKNOWN_CARD. Choisir la fiche la mieux
-- renseignee de la meme societe, sans confondre deux clients Total.
WITH matched AS (
  SELECT tr.id AS review_id,tr.import_batch_id,tr.source_row_number,
    tr.transaction_date,tr.station,tr.product,tr.quantity_liters,
    tr.amount_incl_tax,tr.previous_mileage,tr.reported_mileage,
    tr.authorization_code,tr.vehicle_registration,
    fc.id AS fuel_card_id,fc.company_id,
    coalesce(nullif(trim(tr.beneficiary_name),''),nullif(trim(fc.holder_name),''),
      'Carte '||right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)) AS beneficiary_name
  FROM transaction_review tr
  CROSS JOIN LATERAL (
    SELECT candidate.*
    FROM fuel_card candidate
    WHERE candidate.company_id=tr.company_id AND candidate.deleted_at IS NULL
      AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),4) IN (
        right(regexp_replace(candidate.masked_card_number,'[^0-9]','','g'),4),
        right(regexp_replace(coalesce(candidate.official_card_number,''),'[^0-9]','','g'),4),
        right(regexp_replace(coalesce(candidate.total_payment_number,''),'[^0-9]','','g'),4)
      )
    ORDER BY
      (right(regexp_replace(coalesce(candidate.total_payment_number,''),'[^0-9]','','g'),4)=
        right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)) DESC,
      (nullif(trim(candidate.holder_name),'') IS NOT NULL) DESC,
      (candidate.reference_vehicle_id IS NOT NULL) DESC,
      (candidate.status='ACTIVE') DESC,
      candidate.updated_at DESC NULLS LAST,candidate.created_at,candidate.id
    LIMIT 1
  ) fc
  WHERE tr.status='PENDING' AND tr.company_id IS NOT NULL
    AND length(regexp_replace(tr.card_number,'[^0-9]','','g'))>=4
    AND tr.issue_type IN ('UNKNOWN_CARD','UNAVAILABLE_CARD','UNKNOWN_VEHICLE',
      'UNAVAILABLE_VEHICLE','MISSING_BENEFICIARY')
), departments AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT company_id,'Transactions importées' FROM matched
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name
  RETURNING id,company_id
), beneficiaries AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT m.company_id,d.id,m.beneficiary_name
  FROM matched m JOIN departments d ON d.company_id=m.company_id
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true
  RETURNING id,company_id,display_name
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,
    transaction_date,station,product,quantity_liters,amount_incl_tax,source,
    import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code)
  SELECT coalesce('TOTAL:'||nullif(trim(m.authorization_code),''),'review:'||m.review_id),
    m.fuel_card_id,b.id,NULL,m.transaction_date,m.station,m.product,m.quantity_liters,
    m.amount_incl_tax,'TOTAL_EXCEL',m.import_batch_id,m.source_row_number,
    m.previous_mileage,m.reported_mileage,m.authorization_code
  FROM matched m JOIN beneficiaries b ON b.company_id=m.company_id
    AND b.display_name=m.beneficiary_name
  ON CONFLICT(external_transaction_id,source) DO UPDATE SET
    fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id,
    deleted_at=NULL,deleted_by=NULL
  RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr
SET status='ACCEPTED',fuel_card_id=m.fuel_card_id,decided_at=now(),
  decision_reason='Consommation rattachee par les 4 derniers chiffres du moyen de paiement'
FROM matched m
WHERE tr.id=m.review_id AND EXISTS (
  SELECT 1 FROM inserted i
  WHERE i.import_batch_id=tr.import_batch_id AND i.source_row_number=tr.source_row_number
);

COMMIT;
