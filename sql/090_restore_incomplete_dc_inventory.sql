BEGIN;

-- Restaurer uniquement les cartes DC archivées par une passe d'import ayant
-- pris un inventaire incomplet pour une liste autoritaire. L'UPDATE et l'audit
-- partagent le même now() transactionnel, donc les archives manuelles ne sont
-- jamais réactivées par cette migration.
WITH incomplete_runs AS (
  SELECT created_at
  FROM audit_log
  WHERE action='IMPORT_TOTAL_CARD_STATUSES'
    AND entity_type='integration'
    AND entity_id='TOTAL_MOBILITY_CARDS'
    AND new_values->>'company'='DC'
    AND coalesce((new_values->>'removed')::int,0)>0
    AND coalesce((new_values->>'expectedTotal')::int,0)<>43
), restored AS (
  UPDATE fuel_card fc
  SET deleted_at=NULL,deleted_by=NULL,updated_at=now()
  FROM company c,incomplete_runs run
  WHERE fc.company_id=c.id AND c.code='DC'
    AND fc.deleted_at IS NOT NULL
    AND fc.updated_at=run.created_at
  RETURNING fc.id
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:total-card-recovery','RESTORE_INCOMPLETE_DC_INVENTORY','integration',
  'TOTAL_MOBILITY_CARDS:DC',jsonb_build_object('restoredCards',count(*),'expectedCards',43)
FROM restored;

COMMIT;
