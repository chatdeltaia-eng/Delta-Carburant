BEGIN;

-- 0501 est le suffixe transactionnel du mode de paiement 0005 0 1, pas une
-- carte distincte. La carte officielle visible dans Total est 0005.
WITH tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1), canonical AS (
  SELECT id FROM fuel_card,tcm WHERE company_id=tcm.id AND masked_card_number='0005'
  ORDER BY (deleted_at IS NULL) DESC,created_at LIMIT 1
), duplicates AS (
  SELECT fc.id FROM fuel_card fc,tcm,canonical
  WHERE fc.company_id=tcm.id AND fc.id<>canonical.id
    AND (fc.masked_card_number='0501' OR fc.official_card_number='0501')
)
UPDATE fuel_transaction ft SET fuel_card_id=canonical.id
FROM canonical WHERE ft.fuel_card_id IN (SELECT id FROM duplicates);

WITH tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1), canonical AS (
  SELECT id FROM fuel_card,tcm WHERE company_id=tcm.id AND masked_card_number='0005'
  ORDER BY (deleted_at IS NULL) DESC,created_at LIMIT 1
), duplicates AS (
  SELECT fc.id FROM fuel_card fc,tcm,canonical
  WHERE fc.company_id=tcm.id AND fc.id<>canonical.id
    AND (fc.masked_card_number='0501' OR fc.official_card_number='0501')
)
UPDATE transaction_review tr SET fuel_card_id=canonical.id
FROM canonical WHERE tr.fuel_card_id IN (SELECT id FROM duplicates)
  OR (tr.company_id=(SELECT id FROM tcm) AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)='0501');

WITH tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1), canonical AS (
  SELECT id FROM fuel_card,tcm WHERE company_id=tcm.id AND masked_card_number='0005'
  ORDER BY (deleted_at IS NULL) DESC,created_at LIMIT 1
)
UPDATE card_assignment ca SET ends_at=coalesce(ends_at,now()),is_primary=false
WHERE ca.fuel_card_id IN (SELECT fc.id FROM fuel_card fc,tcm,canonical
  WHERE fc.company_id=tcm.id AND fc.id<>canonical.id
    AND (fc.masked_card_number='0501' OR fc.official_card_number='0501')) AND ca.ends_at IS NULL;

UPDATE fuel_card SET deleted_at=now(),updated_at=now()
WHERE company_id=(SELECT id FROM company WHERE code='TCM')
  AND (masked_card_number='0501' OR official_card_number='0501');

-- Corriger directement la ligne officielle 0005, sans dependre de son ancienne
-- empreinte HMAC qui avait ete calculee avec une colonne decalee.
UPDATE fuel_card SET deleted_at=NULL,masked_card_number='0005',official_card_number='0005',
  total_payment_number='000501',holder_name='DUCATO TECNOMARBRE',official_registration='1155 TU 205',
  expires_on='2030-06-30',total_mobility_status='VALIDE',total_mobility_checked_at=now(),updated_at=now()
WHERE id=(SELECT fc.id FROM fuel_card fc JOIN company c ON c.id=fc.company_id
  WHERE c.code='TCM' AND fc.masked_card_number='0005' ORDER BY (fc.deleted_at IS NULL) DESC,fc.created_at LIMIT 1);

UPDATE fuel_card fc SET reference_vehicle_id=v.id,updated_at=now()
FROM vehicle v WHERE fc.company_id=(SELECT id FROM company WHERE code='TCM')
  AND fc.masked_card_number='0005' AND fc.deleted_at IS NULL AND v.company_id=fc.company_id
  AND v.active AND v.deleted_at IS NULL
  AND regexp_replace(upper(v.registration_display),'[^A-Z0-9]','','g')='1155TU205';

COMMIT;
