BEGIN;

-- Rattacher toutes les anciennes lignes « carte indisponible » à l'unique
-- carte portant le même suffixe dans la même société. Le statut de la carte
-- n'intervient pas dans son identité.
WITH unique_matches AS (
  SELECT tr.id AS review_id,(array_agg(fc.id ORDER BY fc.created_at))[1] AS card_id
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.company_id=tr.company_id AND fc.deleted_at IS NULL
   AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),4) IN (
     right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4),
     right(regexp_replace(coalesce(fc.official_card_number,''),'[^0-9]','','g'),4),
     right(regexp_replace(coalesce(fc.total_payment_number,''),'[^0-9]','','g'),4)
   )
  WHERE tr.status='PENDING' AND tr.issue_type IN ('UNKNOWN_CARD','UNAVAILABLE_CARD')
  GROUP BY tr.id HAVING count(DISTINCT fc.id)=1
)
UPDATE transaction_review tr SET fuel_card_id=m.card_id
FROM unique_matches m WHERE tr.id=m.review_id;

-- Transformer immédiatement les contrôles dont le véhicule est connu, ainsi
-- que les consommations HORS PARC qui n'ont volontairement aucun véhicule.
WITH candidates AS (
  SELECT tr.*,fc.id AS card_id,fc.company_id AS matched_company_id,fc.holder_name,fc.card_category,
    matched_vehicle.id AS vehicle_id,matched_vehicle.registration_display,
    coalesce(nullif(trim(tr.beneficiary_name),''),nullif(trim(fc.holder_name),''),
      nullif(trim(matched_vehicle.driver_name),''),'Titulaire carte '||right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4)) AS resolved_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.id=tr.fuel_card_id AND fc.company_id=tr.company_id AND fc.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT v.id,v.registration_display,coalesce(d.full_name,v.driver_name) AS driver_name
    FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.active AND d.deleted_at IS NULL
    WHERE v.company_id=fc.company_id AND v.active AND v.deleted_at IS NULL
      AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
        regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
        regexp_replace(regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1')
      )
    ORDER BY v.created_at LIMIT 1
  ) matched_vehicle ON true
  WHERE tr.status='PENDING' AND tr.issue_type IN ('UNKNOWN_CARD','UNAVAILABLE_CARD')
    AND (matched_vehicle.id IS NOT NULL OR fc.card_category='OFF_PARK'
      OR regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g')='HORSPARC')
), departments AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT matched_company_id,'Transactions importées' FROM candidates
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name
  RETURNING department.id,department.company_id
), beneficiaries AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT c.matched_company_id,d.id,c.resolved_name FROM candidates c
  JOIN departments d ON d.company_id=c.matched_company_id
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
  FROM candidates c JOIN beneficiaries b ON b.company_id=c.matched_company_id AND b.display_name=c.resolved_name
  ON CONFLICT(external_transaction_id,source) DO UPDATE SET
    fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id,
    vehicle_id=excluded.vehicle_id,deleted_at=NULL,deleted_by=NULL
  RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),
  decision_reason='Carte connue : rapprochement automatique par société et 4 derniers chiffres'
WHERE tr.status='PENDING' AND EXISTS (
  SELECT 1 FROM inserted i WHERE i.import_batch_id=tr.import_batch_id AND i.source_row_number=tr.source_row_number
);

-- Si la carte est reconnue mais que le véhicule reste introuvable, afficher la
-- vraie donnée à corriger au lieu de continuer à accuser la carte.
UPDATE transaction_review SET issue_type='UNKNOWN_VEHICLE'
WHERE status='PENDING' AND issue_type IN ('UNKNOWN_CARD','UNAVAILABLE_CARD') AND fuel_card_id IS NOT NULL;

COMMIT;
