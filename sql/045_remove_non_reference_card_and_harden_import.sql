BEGIN;

-- Carte créée à tort par un ancien import Total. Elle est archivée avec ses
-- données dépendantes afin de préserver l'audit sans rester visible dans le parc.
WITH target AS (
  SELECT id FROM fuel_card
  WHERE regexp_replace(masked_card_number,'[^0-9]','','g')='790351010391001900'
    AND deleted_at IS NULL
)
UPDATE fuel_transaction ft
SET deleted_at=coalesce(ft.deleted_at,now())
FROM target WHERE ft.fuel_card_id=target.id;

WITH target AS (
  SELECT id FROM fuel_card
  WHERE regexp_replace(masked_card_number,'[^0-9]','','g')='790351010391001900'
    AND deleted_at IS NULL
)
UPDATE card_assignment ca SET ends_at=coalesce(ca.ends_at,now())
FROM target WHERE ca.fuel_card_id=target.id AND ca.ends_at IS NULL;

WITH target AS (
  SELECT id FROM fuel_card
  WHERE regexp_replace(masked_card_number,'[^0-9]','','g')='790351010391001900'
    AND deleted_at IS NULL
)
UPDATE anomaly a SET status='DISMISSED',resolved_at=coalesce(a.resolved_at,now()),
  resolution=coalesce(a.resolution,'Carte hors référentiel archivée')
FROM target WHERE a.fuel_card_id=target.id AND a.status IN ('OPEN','IN_REVIEW');

UPDATE transaction_review SET status='REJECTED',decided_at=coalesce(decided_at,now()),
  decision_reason=coalesce(decision_reason,'Carte absente du référentiel officiel DC')
WHERE regexp_replace(card_number,'[^0-9]','','g')='790351010391001900' AND status='PENDING';

UPDATE fuel_card SET deleted_at=coalesce(deleted_at,now()),status='CANCELLED',updated_at=now()
WHERE regexp_replace(masked_card_number,'[^0-9]','','g')='790351010391001900' AND deleted_at IS NULL;

COMMIT;
