BEGIN;

-- Reconstruction demandée du référentiel actif Delta Cuisine. Il s'agit
-- d'un archivage récupérable : les transactions, affectations et historiques
-- restent physiquement liés aux mêmes identifiants. L'agent Total réactive
-- ensuite uniquement les 40 cartes VALIDE après lecture de leurs 40 limites.
WITH target AS MATERIALIZED (
  SELECT fc.id,fc.company_id,fc.masked_card_number,fc.official_card_number,
    fc.total_payment_number,fc.holder_name,fc.monthly_limit
  FROM fuel_card fc
  JOIN company c ON c.id=fc.company_id
  WHERE c.code='DC' AND fc.deleted_at IS NULL
  FOR UPDATE
), archived AS (
  UPDATE fuel_card fc
  SET deleted_at=now(),deleted_by=NULL,monthly_limit=0,updated_at=now()
  FROM target t
  WHERE fc.id=t.id
  RETURNING fc.id
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,old_values,new_values)
SELECT 'system:total-dc-rebuild','ARCHIVE_DC_CARDS_FOR_TOTAL_REEXTRACTION','integration',
  'TOTAL_MOBILITY_CARDS:DC',
  jsonb_build_object('cards',coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,'cardNumber',t.masked_card_number,'officialCardNumber',t.official_card_number,
    'paymentNumber',t.total_payment_number,'holder',t.holder_name,'monthlyLimit',t.monthly_limit
  ) ORDER BY t.masked_card_number),'[]'::jsonb)),
  jsonb_build_object('archivedCards',count(a.id),'oldLimitsReset',true,
    'transactionsPreserved',true,'assignmentsPreserved',true,'recoverable',true,
    'expectedReimportedValidCards',40)
FROM target t
JOIN archived a ON a.id=t.id;

COMMIT;
