BEGIN;

-- Une carte Total est identifiee par son numero officiel a 4 chiffres et son
-- numero de paiement a 6 chiffres. Le modele du vehicule n'entre jamais dans
-- le rapprochement : seule la plaque officielle exacte est utilisee.
CREATE TEMP TABLE total_card_duplicate_map ON COMMIT DROP AS
SELECT duplicate.id AS duplicate_id, canonical.id AS canonical_id
FROM fuel_card canonical
JOIN fuel_card duplicate ON duplicate.id <> canonical.id
WHERE canonical.deleted_at IS NULL
  AND canonical.official_card_number ~ '^[0-9]{4}$'
  AND canonical.total_payment_number ~ '^[0-9]{6}$'
  AND duplicate.deleted_at IS NULL
  AND (
    regexp_replace(duplicate.masked_card_number,'[^0-9]','','g') = canonical.official_card_number
    OR regexp_replace(duplicate.masked_card_number,'[^0-9]','','g') = canonical.total_payment_number
    OR (
      length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g')) > 6
      AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6) = canonical.total_payment_number
    )
  );

UPDATE fuel_transaction ft
SET fuel_card_id=m.canonical_id, corrected_at=now()
FROM total_card_duplicate_map m WHERE ft.fuel_card_id=m.duplicate_id;

UPDATE transaction_review tr SET fuel_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE tr.fuel_card_id=m.duplicate_id;

UPDATE card_request cr SET fuel_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE cr.fuel_card_id=m.duplicate_id;

UPDATE card_request cr SET source_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE cr.source_card_id=m.duplicate_id;

UPDATE anomaly a SET fuel_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE a.fuel_card_id=m.duplicate_id;

UPDATE fuel_card fc SET old_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE fc.old_card_id=m.duplicate_id;

UPDATE fuel_card fc SET replacement_card_id=m.canonical_id
FROM total_card_duplicate_map m WHERE fc.replacement_card_id=m.duplicate_id;

-- On conserve l'affectation de la carte officielle et on ferme uniquement les
-- affectations des anciennes cartes techniques creees par les imports.
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM total_card_duplicate_map m
WHERE ca.fuel_card_id=m.duplicate_id AND ca.ends_at IS NULL;

UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
FROM total_card_duplicate_map m WHERE fc.id=m.duplicate_id;

-- Reapplique la plaque officielle aux cartes personnalisees. Ainsi la carte
-- 002508 est liee uniquement a 7613 TU 242, meme si plusieurs vehicules ont le
-- modele TOYOTA HIACE.
WITH exact_vehicle AS (
  SELECT DISTINCT ON (fc.id) fc.id AS card_id, v.id AS vehicle_id, v.company_id
  FROM fuel_card fc
  JOIN vehicle v ON v.active AND v.deleted_at IS NULL
   AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') =
       regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g')
  WHERE fc.deleted_at IS NULL AND fc.card_category='PERSONALIZED'
  ORDER BY fc.id,v.updated_at DESC
), fixed_assignment AS (
  UPDATE card_assignment ca
  SET vehicle_id=e.vehicle_id, beneficiary_id=b.id,
      workflow_status='APPROVED_ZIN',reviewed_at=now()
  FROM exact_vehicle e
  JOIN fuel_card fc ON fc.id=e.card_id
  JOIN department d ON d.company_id=e.company_id AND d.name='Cartes Total'
  JOIN beneficiary b ON b.company_id=e.company_id AND b.department_id=d.id
   AND b.display_name=fc.holder_name
  WHERE ca.fuel_card_id=e.card_id AND ca.ends_at IS NULL AND ca.is_primary
  RETURNING ca.fuel_card_id,ca.vehicle_id,ca.beneficiary_id
)
UPDATE fuel_transaction ft
SET vehicle_id=fa.vehicle_id,beneficiary_id=fa.beneficiary_id,corrected_at=now()
FROM fixed_assignment fa
WHERE ft.fuel_card_id=fa.fuel_card_id AND ft.deleted_at IS NULL
  AND (ft.vehicle_id IS DISTINCT FROM fa.vehicle_id OR ft.beneficiary_id IS DISTINCT FROM fa.beneficiary_id);

COMMIT;
