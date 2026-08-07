BEGIN;

-- Les exports Total contiennent un identifiant long (par exemple
-- 790351010391002508) dont les six derniers chiffres sont le numéro officiel
-- du mode de paiement (002508). Les anciens imports ont parfois créé une
-- seconde carte avec l'identifiant long. Cette migration rattache tout
-- l'historique à l'unique carte du référentiel, puis masque le doublon.
WITH canonical AS (
  SELECT id,total_payment_number
  FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id,canonical.id AS canonical_id
  FROM canonical
  JOIN fuel_card duplicate ON duplicate.id<>canonical.id
    AND duplicate.deleted_at IS NULL
    AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
    AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE fuel_transaction ft SET fuel_card_id=d.canonical_id,corrected_at=now()
FROM duplicates d WHERE ft.fuel_card_id=d.duplicate_id;

WITH canonical AS (
  SELECT id,total_payment_number FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id,canonical.id AS canonical_id
  FROM canonical JOIN fuel_card duplicate ON duplicate.id<>canonical.id
   AND duplicate.deleted_at IS NULL
   AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
   AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE transaction_review tr SET fuel_card_id=d.canonical_id
FROM duplicates d WHERE tr.fuel_card_id=d.duplicate_id;

WITH canonical AS (
  SELECT id,total_payment_number FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id,canonical.id AS canonical_id
  FROM canonical JOIN fuel_card duplicate ON duplicate.id<>canonical.id
   AND duplicate.deleted_at IS NULL
   AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
   AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE card_request cr SET fuel_card_id=d.canonical_id
FROM duplicates d WHERE cr.fuel_card_id=d.duplicate_id;

WITH canonical AS (
  SELECT id,total_payment_number FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id,canonical.id AS canonical_id
  FROM canonical JOIN fuel_card duplicate ON duplicate.id<>canonical.id
   AND duplicate.deleted_at IS NULL
   AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
   AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE anomaly a SET fuel_card_id=d.canonical_id
FROM duplicates d WHERE a.fuel_card_id=d.duplicate_id;

-- Une affectation active existe déjà sur la carte officielle. On ferme celle
-- du doublon sans toucher aux véhicules ni aux bénéficiaires.
WITH canonical AS (
  SELECT id,total_payment_number FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id
  FROM canonical JOIN fuel_card duplicate ON duplicate.id<>canonical.id
   AND duplicate.deleted_at IS NULL
   AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
   AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM duplicates d
WHERE ca.fuel_card_id=d.duplicate_id AND ca.ends_at IS NULL;

WITH canonical AS (
  SELECT id,total_payment_number FROM fuel_card
  WHERE deleted_at IS NULL AND official_card_number IS NOT NULL
    AND total_payment_number ~ '^[0-9]{6}$'
), duplicates AS (
  SELECT duplicate.id AS duplicate_id
  FROM canonical JOIN fuel_card duplicate ON duplicate.id<>canonical.id
   AND duplicate.deleted_at IS NULL
   AND right(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'),6)=canonical.total_payment_number
   AND length(regexp_replace(duplicate.masked_card_number,'[^0-9]','','g'))>6
)
UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
FROM duplicates d WHERE fc.id=d.duplicate_id;

COMMIT;
