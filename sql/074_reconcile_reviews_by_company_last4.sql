BEGIN;

-- Les imports historiques ont conservé le numéro complet du moyen de paiement
-- dans transaction_review alors que le référentiel des cartes expose désormais
-- les quatre derniers chiffres. Rattacher d'abord chaque contrôle à l'unique
-- carte de la même société. Un même suffixe présent dans deux sociétés ne peut
-- donc jamais déplacer une transaction d'une société vers une autre.
WITH unique_matches AS (
  SELECT tr.id AS review_id,(array_agg(fc.id ORDER BY fc.created_at))[1] AS card_id,
    (array_agg(fc.company_id ORDER BY fc.created_at))[1] AS company_id
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.deleted_at IS NULL
   AND fc.company_id=tr.company_id
   AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),4) IN (
     right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4),
     right(regexp_replace(coalesce(fc.official_card_number,''),'[^0-9]','','g'),4),
     right(regexp_replace(coalesce(fc.total_payment_number,''),'[^0-9]','','g'),4)
   )
  WHERE tr.status='PENDING'
    AND length(regexp_replace(tr.card_number,'[^0-9]','','g'))>=4
  GROUP BY tr.id
  HAVING count(DISTINCT fc.id)=1
)
UPDATE transaction_review tr
SET fuel_card_id=m.card_id,company_id=m.company_id
FROM unique_matches m WHERE tr.id=m.review_id;

-- Lorsqu'une carte et son véhicule sont tous les deux identifiés dans la même
-- société, convertir le contrôle historique en transaction normale.
WITH candidates AS (
  SELECT DISTINCT ON (tr.id) tr.*,fc.id AS card_id,fc.company_id AS matched_company_id,
    v.id AS vehicle_id,v.registration_display,
    coalesce(nullif(trim(tr.beneficiary_name),''),nullif(trim(fc.holder_name),''),
      nullif(trim(d.full_name),''),nullif(trim(v.driver_name),''),
      'Titulaire '||v.registration_display) AS resolved_beneficiary_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.id=tr.fuel_card_id AND fc.deleted_at IS NULL
    AND fc.company_id=tr.company_id
  JOIN vehicle v ON v.company_id=fc.company_id AND v.active AND v.deleted_at IS NULL
   AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
     regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
     regexp_replace(regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1')
   )
  LEFT JOIN driver d ON d.id=v.driver_id AND d.active AND d.deleted_at IS NULL
  WHERE tr.status='PENDING'
  ORDER BY tr.id,v.created_at
), departments AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT matched_company_id,'Transactions importées' FROM candidates
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name
  RETURNING department.id,department.company_id
), beneficiaries AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT c.matched_company_id,d.id,c.resolved_beneficiary_name
  FROM candidates c JOIN departments d ON d.company_id=c.matched_company_id
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true
  RETURNING beneficiary.id,beneficiary.company_id,beneficiary.display_name
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,
    transaction_date,station,product,quantity_liters,amount_incl_tax,source,import_batch_id,
    source_row_number,previous_mileage,reported_mileage,authorization_code)
  SELECT coalesce('TOTAL:'||nullif(trim(c.authorization_code),''),'review:'||c.id::text),
    c.card_id,b.id,c.vehicle_id,c.transaction_date,c.station,c.product,c.quantity_liters,
    c.amount_incl_tax,'TOTAL_EXCEL',c.import_batch_id,c.source_row_number,
    c.previous_mileage,c.reported_mileage,c.authorization_code
  FROM candidates c JOIN beneficiaries b ON b.company_id=c.matched_company_id
    AND b.display_name=c.resolved_beneficiary_name
  ON CONFLICT(external_transaction_id,source) DO UPDATE SET
    fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id,
    vehicle_id=excluded.vehicle_id,deleted_at=NULL,deleted_by=NULL
  RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),
  decision_reason='Rapprochement automatique par société et 4 derniers chiffres'
WHERE tr.status='PENDING' AND EXISTS (
  SELECT 1 FROM fuel_transaction ft WHERE ft.deleted_at IS NULL
    AND ft.import_batch_id=tr.import_batch_id AND ft.source_row_number=tr.source_row_number
);

-- Ne plus présenter comme « carte inconnue » un contrôle dont la carte est
-- maintenant retrouvée. S'il reste affiché, son libellé indiquera la vraie
-- donnée manquante (le véhicule), et non un faux problème de numéro de carte.
UPDATE transaction_review tr SET issue_type='UNKNOWN_VEHICLE'
WHERE tr.status='PENDING' AND tr.issue_type='UNKNOWN_CARD'
  AND tr.fuel_card_id IS NOT NULL;

COMMIT;
