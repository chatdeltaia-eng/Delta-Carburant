BEGIN;

-- La société de la carte Total est la source d'autorité. Réparer d'abord les
-- références de cartes qui pointent vers un véhicule d'une autre société.
UPDATE fuel_card fc SET reference_vehicle_id=target.id,updated_at=now()
FROM vehicle target
WHERE fc.deleted_at IS NULL
  AND target.deleted_at IS NULL
  AND target.active
  AND target.company_id=fc.company_id
  AND regexp_replace(upper(coalesce(target.registration_normalized::text,target.registration_display)), '[^A-Z0-9]', '', 'g')
      =regexp_replace(upper(fc.official_registration), '[^A-Z0-9]', '', 'g')
  AND nullif(regexp_replace(upper(fc.official_registration), '[^A-Z0-9]', '', 'g'),'') IS NOT NULL
  AND fc.reference_vehicle_id IS DISTINCT FROM target.id;

-- Une transaction ne peut être rattachée qu'à un véhicule de la société de sa
-- carte. Utiliser la plaque du véhicule actuel ou la plaque officielle Total
-- pour retrouver son équivalent dans la bonne société.
WITH wrong AS (
  SELECT ft.id,
    coalesce(nullif(regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'),''),
             regexp_replace(upper(coalesce(old_v.registration_normalized::text,old_v.registration_display)),'[^A-Z0-9]','','g')) AS registration_key,
    fc.company_id
  FROM fuel_transaction ft
  JOIN fuel_card fc ON fc.id=ft.fuel_card_id AND fc.deleted_at IS NULL
  JOIN vehicle old_v ON old_v.id=ft.vehicle_id
  WHERE ft.deleted_at IS NULL AND old_v.company_id<>fc.company_id
), resolved AS (
  SELECT wrong.id AS transaction_id,target.id AS vehicle_id
  FROM wrong
  JOIN LATERAL (
    SELECT v.id FROM vehicle v
    WHERE v.company_id=wrong.company_id AND v.deleted_at IS NULL AND v.active
      AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g')=wrong.registration_key
    ORDER BY v.updated_at DESC NULLS LAST,v.id LIMIT 1
  ) target ON true
)
UPDATE fuel_transaction ft SET vehicle_id=resolved.vehicle_id
FROM resolved WHERE ft.id=resolved.transaction_id;

-- Si une ancienne affectation inter-sociétés ne peut pas être résolue, retirer
-- seulement le mauvais véhicule. La transaction reste dans sa société via sa
-- carte et pourra être rapprochée lors du prochain cycle Total.
UPDATE fuel_transaction ft SET vehicle_id=NULL
FROM fuel_card fc,vehicle v
WHERE ft.fuel_card_id=fc.id AND ft.vehicle_id=v.id AND ft.deleted_at IS NULL
  AND v.company_id<>fc.company_id;

-- Recréer les relevés depuis les transactions maintenant correctement
-- rattachées. La contrainte unique rend cette opération rejouable.
INSERT INTO mileage_reading(vehicle_id,reading_date,mileage,status,source,created_by,validated_by,validated_at,
  previous_mileage,expected_mileage,detected_distance,anomaly,reconciliation_message)
SELECT DISTINCT ON (ft.vehicle_id,ft.reported_mileage)
  ft.vehicle_id,ft.transaction_date,ft.reported_mileage,'VALIDATED','TOTAL_MOBILITY',t.connected_by,t.connected_by,now(),
  coalesce(ft.previous_mileage,0),ft.reported_mileage,greatest(0,ft.reported_mileage-coalesce(ft.previous_mileage,0)),false,
  'Kilométrage repris depuis la transaction Total de la société du véhicule.'
FROM fuel_transaction ft
JOIN fuel_card fc ON fc.id=ft.fuel_card_id
CROSS JOIN LATERAL (SELECT connected_by FROM total_mobility_connection LIMIT 1) t
JOIN vehicle v ON v.id=ft.vehicle_id AND v.company_id=fc.company_id
WHERE ft.deleted_at IS NULL AND ft.reported_mileage IS NOT NULL AND ft.reported_mileage>0
ORDER BY ft.vehicle_id,ft.reported_mileage,ft.transaction_date DESC,ft.created_at DESC,ft.id
ON CONFLICT(vehicle_id,mileage) WHERE source='TOTAL_MOBILITY' DO NOTHING;

-- Supprimer uniquement les relevés automatiques Total qui ne correspondent à
-- aucune transaction Total du même véhicule. Les relevés manuels sont gardés.
DELETE FROM mileage_reading mr
WHERE mr.source='TOTAL_MOBILITY'
  AND NOT EXISTS (
    SELECT 1 FROM fuel_transaction ft
    JOIN fuel_card fc ON fc.id=ft.fuel_card_id
    JOIN vehicle v ON v.id=ft.vehicle_id AND v.company_id=fc.company_id
    WHERE ft.deleted_at IS NULL AND ft.vehicle_id=mr.vehicle_id
      AND ft.reported_mileage=mr.mileage
  );

-- Recalculer le dernier KM Total de chaque véhicule uniquement depuis ses
-- transactions et relevés correctement rattachés.
UPDATE vehicle v SET total_mobility_mileage=scoped.mileage,
  total_mobility_checked_at=now(),updated_at=now()
FROM (
  SELECT v2.id,nullif(greatest(
    coalesce(max(ft.reported_mileage) FILTER (WHERE fc.id IS NOT NULL),0),
    coalesce(max(mr.mileage) FILTER (WHERE mr.source='TOTAL_MOBILITY'),0)
  ),0) AS mileage
  FROM vehicle v2
  LEFT JOIN fuel_transaction ft ON ft.vehicle_id=v2.id AND ft.deleted_at IS NULL
  LEFT JOIN fuel_card fc ON fc.id=ft.fuel_card_id AND fc.company_id=v2.company_id
  LEFT JOIN mileage_reading mr ON mr.vehicle_id=v2.id
  WHERE v2.deleted_at IS NULL
  GROUP BY v2.id
) scoped
WHERE v.id=scoped.id AND v.total_mobility_mileage IS DISTINCT FROM scoped.mileage;

COMMIT;
