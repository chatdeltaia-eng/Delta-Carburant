BEGIN;

-- Créer dans chaque société les véhicules identifiables par l'immatriculation
-- officielle Total, y compris DCD, IKIT et TCM. Les libellés HORS PARC ne sont
-- jamais transformés en faux véhicules.
INSERT INTO vehicle(company_id,registration_normalized,registration_display,active,driver_name,
  total_mobility_status,total_mobility_checked_at,total_mobility_raw)
SELECT candidate.company_id,candidate.registration_normalized,candidate.registration_display,true,candidate.driver_name,
  'DETECTED_FROM_TOTAL_CARD',now(),jsonb_build_object('source','TOTAL_CARD_BACKFILL','card',candidate.masked_card_number)
FROM (
  -- Une société peut avoir plusieurs cartes pour la même immatriculation. Un
  -- seul candidat par clé unique est nécessaire afin que ON CONFLICT ne tente
  -- pas de mettre à jour deux fois le même véhicule dans cette commande.
  SELECT DISTINCT ON (fc.company_id,regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'))
    fc.company_id,
    regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g') AS registration_normalized,
    upper(btrim(fc.official_registration)) AS registration_display,
    nullif(btrim(fc.holder_name),'') AS driver_name,
    fc.masked_card_number
  FROM fuel_card fc
  WHERE fc.deleted_at IS NULL AND nullif(btrim(fc.official_registration),'') IS NOT NULL
    AND upper(regexp_replace(fc.official_registration,'[^A-Z]','','g')) NOT IN ('HORSPARC','HP')
    AND regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g') ~ '[0-9]'
  ORDER BY fc.company_id,regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'),
    (nullif(btrim(fc.holder_name),'') IS NOT NULL) DESC,fc.updated_at DESC NULLS LAST,fc.id
) candidate
ON CONFLICT(company_id,registration_normalized) DO UPDATE SET
  active=true,deleted_at=NULL,deleted_by=NULL,
  driver_name=coalesce(nullif(excluded.driver_name,''),vehicle.driver_name),
  total_mobility_checked_at=now(),updated_at=now();

UPDATE fuel_card fc SET reference_vehicle_id=v.id,updated_at=now()
FROM vehicle v
WHERE fc.deleted_at IS NULL AND v.deleted_at IS NULL AND v.company_id=fc.company_id
  AND regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g')=v.registration_normalized
  AND fc.reference_vehicle_id IS DISTINCT FROM v.id;

-- Une carte officiellement rattachée à un véhicule transmet ce rattachement à
-- toutes ses transactions Total, sans mélange entre sociétés.
UPDATE fuel_transaction ft SET vehicle_id=fc.reference_vehicle_id
FROM fuel_card fc
WHERE ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL AND ft.vehicle_id IS NULL
  AND fc.reference_vehicle_id IS NOT NULL;

-- Reconstituer les relevés KM historiques présents dans les transactions.
INSERT INTO mileage_reading(vehicle_id,reading_date,mileage,status,source,created_by,validated_by,validated_at,
  previous_mileage,expected_mileage,detected_distance,anomaly,reconciliation_message)
SELECT ft.vehicle_id,ft.transaction_date,ft.reported_mileage,'VALIDATED','TOTAL_MOBILITY',t.connected_by,t.connected_by,now(),
  coalesce(ft.previous_mileage,0),ft.reported_mileage,greatest(0,ft.reported_mileage-coalesce(ft.previous_mileage,0)),false,
  'Kilométrage repris automatiquement depuis une transaction Total.'
FROM fuel_transaction ft CROSS JOIN LATERAL (SELECT connected_by FROM total_mobility_connection LIMIT 1) t
WHERE ft.deleted_at IS NULL AND ft.vehicle_id IS NOT NULL AND ft.reported_mileage IS NOT NULL AND ft.reported_mileage>0
  AND NOT EXISTS(SELECT 1 FROM mileage_reading mr WHERE mr.vehicle_id=ft.vehicle_id
    AND mr.reading_date=ft.transaction_date AND mr.mileage=ft.reported_mileage);

COMMIT;
