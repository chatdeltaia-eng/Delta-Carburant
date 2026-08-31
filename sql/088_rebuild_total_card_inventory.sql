BEGIN;

-- Reconstruction demandee du referentiel cartes Total. Les lignes restent
-- physiquement presentes afin que l'operation soit recuperable et que les
-- transactions ne soient jamais supprimees. Au redemarrage de l'API, l'agent
-- Total reimporte chaque client et reactive/recree uniquement les cartes
-- effectivement visibles dans « Gerer les cartes ».
WITH archived AS (
  UPDATE fuel_card
  SET deleted_at=now(),deleted_by=NULL,updated_at=now()
  WHERE deleted_at IS NULL
  RETURNING id,company_id
), summary AS (
  SELECT company_id,count(*)::int AS archived_count FROM archived GROUP BY company_id
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:total-card-rebuild','ARCHIVE_FOR_TOTAL_REEXTRACTION','integration',
  'TOTAL_MOBILITY_CARDS:'||company_id::text,
  jsonb_build_object('companyId',company_id,'archivedCards',archived_count,
    'transactionsPreserved',true,'recoverable',true)
FROM summary;

COMMIT;
