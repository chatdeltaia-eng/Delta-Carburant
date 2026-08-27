BEGIN;

-- Les migrations precedentes ont conserve les consommations lorsque la carte
-- etait connue mais que le vehicule ne l'etait pas encore. Une fois le
-- vehicule cree, rattacher retroactivement ces transactions par plaque et par
-- societe afin que leurs kilometrages apparaissent dans le module dedie.
WITH transaction_plates AS (
  SELECT ft.id AS transaction_id,v.id AS vehicle_id
  FROM fuel_transaction ft
  JOIN fuel_card fc ON fc.id=ft.fuel_card_id
  JOIN transaction_review tr ON
    tr.id::text=regexp_replace(coalesce(ft.external_transaction_id,''),'^review:','')
    OR (tr.import_batch_id=ft.import_batch_id AND tr.source_row_number=ft.source_row_number)
  JOIN vehicle v ON v.company_id=fc.company_id
    AND v.deleted_at IS NULL
    AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
      regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
      regexp_replace(
        regexp_replace(upper(coalesce(tr.vehicle_registration,'')),'[^A-Z0-9]','','g'),
        '^([0-9]+)TU([0-9]+)$','\2TU\1'
      )
    )
  WHERE ft.deleted_at IS NULL AND ft.vehicle_id IS NULL
), unique_matches AS (
  SELECT transaction_id,min(vehicle_id::text)::uuid AS vehicle_id
  FROM transaction_plates
  GROUP BY transaction_id
  HAVING count(DISTINCT vehicle_id)=1
)
UPDATE fuel_transaction ft
SET vehicle_id=m.vehicle_id
FROM unique_matches m
WHERE ft.id=m.transaction_id;

-- Le dernier KM Total valide devient aussi visible sur la fiche vehicule.
WITH latest AS (
  SELECT DISTINCT ON(ft.vehicle_id) ft.vehicle_id,ft.reported_mileage
  FROM fuel_transaction ft
  WHERE ft.deleted_at IS NULL AND ft.vehicle_id IS NOT NULL
    AND ft.reported_mileage IS NOT NULL AND ft.reported_mileage>0
  ORDER BY ft.vehicle_id,ft.transaction_date DESC,ft.created_at DESC
)
UPDATE vehicle v SET
  total_mobility_mileage=greatest(coalesce(v.total_mobility_mileage,0),latest.reported_mileage),
  total_mobility_checked_at=coalesce(v.total_mobility_checked_at,now()),
  updated_at=now()
FROM latest
WHERE v.id=latest.vehicle_id;

-- L'anomalie de vehicule absent n'a plus lieu d'etre apres le rattachement.
UPDATE anomaly a SET status='RESOLVED',resolved_at=now(),
  resolution='Vehicule retrouve par sa matricule dans la meme societe ; transaction et kilometrage rattaches.'
FROM fuel_transaction ft
WHERE a.fuel_transaction_id=ft.id AND ft.vehicle_id IS NOT NULL
  AND a.status IN ('OPEN','IN_REVIEW')
  AND a.anomaly_type IN ('UNKNOWN_VEHICLE','UNAVAILABLE_VEHICLE');

COMMIT;
