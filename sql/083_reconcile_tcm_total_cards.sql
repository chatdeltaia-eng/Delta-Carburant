BEGIN;

-- Referentiel TCM confirme dans Total Mobility Business le 28/08/2026.
WITH source(card_number,payment_number,registration,holder_name,expires_on) AS (VALUES
  ('0008','000808','TOYOTA RAV 4','FAKHRI DENGUIR','2030-06-30'::date),
  ('0003','000303','3987 TU 202','Métreur TECNO','2030-06-30'::date),
  ('0006','000600','5626 TU 155','STE LES TECHNIQUES DE MARBRE','2030-06-30'::date),
  ('0001','000105','HORS PARC','CHOKRI','2030-06-30'::date),
  ('0007','000709','7223 TU 227','HYUNDAI H350','2030-06-30'::date),
  ('0002','000204','HORS PARC','STE LES TECHNIQUES DE MARBRE','2030-06-30'::date),
  ('0005','000501','1155 TU 205','DUCATO TECNOMARBRE','2030-06-30'::date)
), tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1)
INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,
  card_category,total_mobility_status,total_mobility_checked_at,official_card_number,total_payment_number,
  holder_name,official_registration,expires_on)
SELECT tcm.id,pgp_sym_encrypt(s.card_number,$1,'cipher-algo=aes256'),hmac(s.card_number,$2,'sha256'),
  s.card_number,0,'TO_ASSIGN','PERSONALIZED','VALIDE',now(),s.card_number,s.payment_number,
  s.holder_name,s.registration,s.expires_on
FROM source s CROSS JOIN tcm
ON CONFLICT(company_id,card_number_hmac) DO UPDATE SET deleted_at=NULL,masked_card_number=excluded.masked_card_number,
  official_card_number=excluded.official_card_number,total_payment_number=excluded.total_payment_number,
  holder_name=excluded.holder_name,official_registration=excluded.official_registration,expires_on=excluded.expires_on,
  total_mobility_status='VALIDE',total_mobility_checked_at=now(),updated_at=now();

-- La ligne 0501 a ete creee par confusion entre carte 0005 et mode de paiement
-- 0005 0 1. Deplacer ses transactions vers 0005 puis retirer le doublon.
WITH tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1), cards AS (
  SELECT fc.id,fc.masked_card_number FROM fuel_card fc CROSS JOIN tcm
  WHERE fc.company_id=tcm.id AND fc.deleted_at IS NULL AND fc.masked_card_number IN ('0005','0501')
), canonical AS (SELECT id FROM cards WHERE masked_card_number='0005'), duplicate AS (SELECT id FROM cards WHERE masked_card_number='0501')
UPDATE fuel_transaction ft SET fuel_card_id=canonical.id
FROM canonical,duplicate WHERE ft.fuel_card_id=duplicate.id;

WITH tcm AS (SELECT id FROM company WHERE code='TCM' LIMIT 1), canonical AS (
  SELECT id FROM fuel_card,tcm WHERE company_id=tcm.id AND masked_card_number='0005' AND deleted_at IS NULL LIMIT 1
)
UPDATE transaction_review tr SET fuel_card_id=canonical.id
FROM canonical WHERE tr.company_id=(SELECT id FROM tcm)
  AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),4)='0501';

UPDATE fuel_card SET deleted_at=now(),updated_at=now()
WHERE company_id=(SELECT id FROM company WHERE code='TCM') AND masked_card_number='0501' AND deleted_at IS NULL;

-- Rattacher les plaques reelles aux vehicules de la meme societe.
UPDATE fuel_card fc SET reference_vehicle_id=v.id,updated_at=now()
FROM vehicle v WHERE fc.company_id=(SELECT id FROM company WHERE code='TCM') AND v.company_id=fc.company_id
  AND v.active AND v.deleted_at IS NULL
  AND regexp_replace(upper(v.registration_display),'[^A-Z0-9]','','g')
      =regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g');

COMMIT;
