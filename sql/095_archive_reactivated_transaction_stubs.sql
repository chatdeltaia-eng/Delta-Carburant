BEGIN;

-- Les huit suffixes existaient parfois avant la reconstruction et ont été
-- réactivés par ON CONFLICT : leur created_at est donc antérieur au rebuild.
-- Les identifier par leur signature fonctionnelle, sans condition de date.
WITH archived AS (
  UPDATE fuel_card fc
  SET deleted_at=now(),deleted_by=NULL,updated_at=now()
  FROM company c
  WHERE fc.company_id=c.id AND c.code='DC' AND fc.deleted_at IS NULL
    AND fc.monthly_limit=0
    AND fc.total_mobility_checked_at IS NULL
    AND nullif(trim(fc.holder_name),'') IS NULL
    AND fc.expires_on IS NULL
    AND fc.status='TO_ASSIGN'
    AND fc.responsible_user_id IS NULL
  RETURNING fc.id,fc.masked_card_number
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:total-dc-rebuild','ARCHIVE_REACTIVATED_TRANSACTION_STUBS','integration',
  'TOTAL_MOBILITY_CARDS:DC',jsonb_build_object('archivedCards',count(*),
    'cardSuffixes',coalesce(jsonb_agg(masked_card_number ORDER BY masked_card_number),'[]'::jsonb),
    'transactionsPreserved',true)
FROM archived;

COMMIT;
