BEGIN;

-- Rattacher les véhicules déjà importés à leur chauffeur Total. Le nom et la
-- société doivent correspondre exactement après normalisation ; une identité
-- ambiguë n'est volontairement pas affectée.
WITH matches AS (
  SELECT v.id AS vehicle_id,min(d.id::text)::uuid AS driver_id,min(d.full_name) AS full_name
  FROM vehicle v
  JOIN driver d ON d.company_id=v.company_id
    AND d.deleted_at IS NULL AND d.active
    AND regexp_replace(upper(d.full_name),'[^A-Z0-9]','','g')=
        regexp_replace(upper(coalesce(v.driver_name,'')),'[^A-Z0-9]','','g')
  WHERE v.deleted_at IS NULL AND nullif(v.driver_name,'') IS NOT NULL
  GROUP BY v.id
  HAVING count(*)=1
)
UPDATE vehicle v
SET driver_id=m.driver_id,driver_name=m.full_name,updated_at=now()
FROM matches m
WHERE v.id=m.vehicle_id AND v.driver_id IS DISTINCT FROM m.driver_id;

COMMIT;
