BEGIN;

-- Retirer les pseudo-cartes recréées depuis les transactions après le
-- vidage DC. Elles portent uniquement un suffixe de moyen de paiement, aucun
-- contrôle Mobility et aucun plafond. Les transactions restent conservées et
-- seront rapprochées lorsque les 40 cartes officielles seront réimportées.
WITH latest_rebuild AS (
  SELECT max(created_at) AS started_at
  FROM audit_log
  WHERE action='ARCHIVE_DC_CARDS_FOR_TOTAL_REEXTRACTION'
    AND entity_id='TOTAL_MOBILITY_CARDS:DC'
), archived AS (
  UPDATE fuel_card fc
  SET deleted_at=now(),deleted_by=NULL,updated_at=now()
  FROM company c,latest_rebuild rebuild
  WHERE fc.company_id=c.id AND c.code='DC' AND fc.deleted_at IS NULL
    AND fc.created_at>=rebuild.started_at
    AND fc.monthly_limit=0
    AND fc.total_mobility_checked_at IS NULL
    AND fc.holder_name IS NULL
    AND fc.expires_on IS NULL
    AND fc.status='TO_ASSIGN'
  RETURNING fc.id,fc.masked_card_number
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:total-dc-rebuild','ARCHIVE_TRANSACTION_STUB_CARDS','integration',
  'TOTAL_MOBILITY_CARDS:DC',jsonb_build_object('archivedCards',count(*),
    'cardSuffixes',coalesce(jsonb_agg(masked_card_number ORDER BY masked_card_number),'[]'::jsonb),
    'transactionsPreserved',true)
FROM archived;

COMMIT;
