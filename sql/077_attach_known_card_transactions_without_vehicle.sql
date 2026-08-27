BEGIN;

-- Une opération Total dont la carte est connue est une consommation réelle,
-- même lorsque le véhicule n'est pas encore disponible dans le référentiel.
-- On rattache les anciennes lignes en attente à la carte de la même société ;
-- le véhicule reste nullable et sera corrigé séparément par Zin / la DG.
INSERT INTO department(company_id,name)
SELECT DISTINCT fc.company_id,'Transactions importées'
FROM transaction_review tr
JOIN fuel_card fc ON fc.deleted_at IS NULL
 AND fc.company_id=tr.company_id
 AND right(regexp_replace(coalesce(fc.total_payment_number,fc.masked_card_number),'[^0-9]','','g'),4)
     =right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)
WHERE tr.status='PENDING'
  AND tr.issue_type IN ('UNKNOWN_VEHICLE','UNAVAILABLE_VEHICLE','MISSING_BENEFICIARY')
ON CONFLICT(company_id,name) DO NOTHING;

WITH matched AS (
  SELECT tr.id AS review_id,tr.import_batch_id,tr.source_row_number,tr.transaction_date,
    tr.station,tr.product,tr.quantity_liters,tr.amount_incl_tax,tr.previous_mileage,
    tr.reported_mileage,tr.authorization_code,tr.vehicle_registration,
    fc.id AS fuel_card_id,fc.company_id,fc.masked_card_number,
    coalesce(nullif(tr.beneficiary_name,''),nullif(fc.holder_name,''),'Carte '||fc.masked_card_number) AS beneficiary_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.deleted_at IS NULL
   AND fc.company_id=tr.company_id
   AND right(regexp_replace(coalesce(fc.total_payment_number,fc.masked_card_number),'[^0-9]','','g'),4)
       =right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)
  WHERE tr.status='PENDING'
    AND tr.issue_type IN ('UNKNOWN_VEHICLE','UNAVAILABLE_VEHICLE','MISSING_BENEFICIARY')
    AND 1=(SELECT count(*) FROM fuel_card candidate
      WHERE candidate.deleted_at IS NULL AND candidate.company_id=tr.company_id
        AND right(regexp_replace(coalesce(candidate.total_payment_number,candidate.masked_card_number),'[^0-9]','','g'),4)
            =right(regexp_replace(tr.card_number,'[^0-9]','','g'),4))
), ensured_beneficiary AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT m.company_id,d.id,m.beneficiary_name
  FROM matched m JOIN department d ON d.company_id=m.company_id AND d.name='Transactions importées'
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true
  RETURNING id,company_id,display_name
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,
    transaction_date,station,product,quantity_liters,amount_incl_tax,source,import_batch_id,
    source_row_number,previous_mileage,reported_mileage,authorization_code)
  SELECT 'review:'||m.review_id,m.fuel_card_id,b.id,NULL,m.transaction_date,m.station,m.product,
    m.quantity_liters,m.amount_incl_tax,'TOTAL_EXCEL',m.import_batch_id,m.source_row_number,
    m.previous_mileage,m.reported_mileage,m.authorization_code
  FROM matched m
  JOIN ensured_beneficiary b ON b.company_id=m.company_id AND b.display_name=m.beneficiary_name
  ON CONFLICT(external_transaction_id,source) DO UPDATE SET deleted_at=NULL,deleted_by=NULL,
    fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id
  RETURNING id,external_transaction_id,fuel_card_id
), marked AS (
  UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),
    decision_reason='Carte reconnue par le moyen de paiement à 4 chiffres ; consommation rattachée sans attendre le véhicule.'
  FROM inserted i
  WHERE i.external_transaction_id='review:'||tr.id
  RETURNING tr.id,i.id AS transaction_id,i.fuel_card_id,tr.issue_type,tr.vehicle_registration
)
INSERT INTO anomaly(fuel_transaction_id,fuel_card_id,anomaly_type,severity,status,description,metadata)
SELECT transaction_id,fuel_card_id,issue_type,'HIGH','OPEN',
  format('Consommation affectée à la carte connue ; véhicule %s à vérifier.',coalesce(vehicle_registration,'non renseigné')),
  jsonb_build_object('reviewId',id,'vehicle',vehicle_registration)
FROM marked
WHERE issue_type IN ('UNKNOWN_VEHICLE','UNAVAILABLE_VEHICLE')
  AND NOT EXISTS(SELECT 1 FROM anomaly a WHERE a.fuel_transaction_id=marked.transaction_id
    AND a.anomaly_type=marked.issue_type AND a.status IN ('OPEN','IN_REVIEW'));

COMMIT;
