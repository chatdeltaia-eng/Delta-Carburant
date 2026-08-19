BEGIN;

-- Les anciennes versions du robot ont pris des numéros du paginator pour des
-- cartes et ont créé 29 lignes sans aucun détail Total. Elles gonflent le
-- compteur DC à 72. On archive uniquement ces lignes entièrement vides ; une
-- carte liée à une transaction, une affectation ou un responsable est gardée.
WITH removed AS (
  UPDATE fuel_card fc
  SET deleted_at=now(),updated_at=now()
  FROM company c
  WHERE fc.company_id=c.id
    AND c.code='DC'
    AND fc.deleted_at IS NULL
    AND fc.monthly_limit=0
    AND nullif(btrim(fc.total_payment_number),'') IS NULL
    AND nullif(btrim(fc.holder_name),'') IS NULL
    AND nullif(btrim(fc.official_registration),'') IS NULL
    AND fc.expires_on IS NULL
    AND fc.responsible_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM fuel_transaction ft
      WHERE ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM card_assignment ca
      WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL
    )
  RETURNING fc.id
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'migration-071','REMOVE_EMPTY_DC_CARDS','system','DC_CARDS',
       jsonb_build_object('removed',count(*),'reason','empty rows created from Total paginator')
FROM removed;

COMMIT;
