BEGIN;

-- La migration 088 a archivé le référentiel complet avant de savoir si
-- l'extraction Total suivante aboutirait. Restaurer uniquement les lignes
-- touchées par cette migration : son UPDATE et son audit partagent le même
-- now() transactionnel, ce qui évite de réactiver une carte archivée
-- volontairement avant ou après l'opération.
WITH rebuild_runs AS (
  SELECT created_at,
    replace(entity_id,'TOTAL_MOBILITY_CARDS:','')::uuid AS company_id
  FROM audit_log
  WHERE actor='system:total-card-rebuild'
    AND action='ARCHIVE_FOR_TOTAL_REEXTRACTION'
    AND entity_type='integration'
    AND entity_id LIKE 'TOTAL_MOBILITY_CARDS:%'
), restored AS (
  UPDATE fuel_card fc
  SET deleted_at=NULL,deleted_by=NULL,updated_at=now()
  FROM rebuild_runs run
  WHERE fc.company_id=run.company_id
    AND fc.deleted_at IS NOT NULL
    AND fc.updated_at=run.created_at
  RETURNING fc.id,fc.company_id
), summary AS (
  SELECT company_id,count(*)::int AS restored_count
  FROM restored
  GROUP BY company_id
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:total-card-recovery','RESTORE_TOTAL_CARD_INVENTORY','integration',
  'TOTAL_MOBILITY_CARDS:'||company_id::text,
  jsonb_build_object('companyId',company_id,'restoredCards',restored_count,
    'reason','Recovery after migration 088','transactionsPreserved',true)
FROM summary;

COMMIT;
