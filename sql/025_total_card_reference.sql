BEGIN;

ALTER TABLE fuel_card
  ADD COLUMN IF NOT EXISTS official_card_number text,
  ADD COLUMN IF NOT EXISTS total_payment_number text,
  ADD COLUMN IF NOT EXISTS holder_name text,
  ADD COLUMN IF NOT EXISTS official_registration text,
  ADD COLUMN IF NOT EXISTS expires_on date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_card_official_number
  ON fuel_card(official_card_number) WHERE official_card_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_card_total_payment_number
  ON fuel_card(total_payment_number) WHERE total_payment_number IS NOT NULL;

WITH cards(card_no,payment_no,registration,holder) AS (VALUES
 ('0026','002607','596TU257','DELTA CUISINE'),('0038','003803','6257TU145','GOLF'),
 ('0018','001807','170TU4850','GHARBI Wissam'),('0031','003100','6674TU175','Ahmed MAREGHNI'),
 ('0039','003902','HORS PARC','TAHER DENGUIR'),('0040','004009','HORS PARC','JAWHER DENGAIR'),
 ('0020','002003','214TU9127','NIZAR MAALAM'),('0032','003209','9458TU240','MEHREZ ZAKRAOUI'),
 ('0007','000700','HORS PARC','MOUHAMMED BAHI-BATIMENT'),('0019','001906','166TU7992','SEIFEDDINE SAID'),
 ('0016','001609','7904TU138','DELTA CUISINE'),('0025','002508','7613TU242','TOYOTA HIACE'),
 ('0006','000601','HORS PARC','DELTA CUISINE'),('0008','000809','CITROEN C4','TAIEB ALOUANI'),
 ('0022','002201','2646TU221','DELTA CUISINE'),('0003','000304','HORS PARC','HAITHEM MILITTI'),
 ('0035','003506','HORS PARC','DELTA CUISINE'),('0021','002102','5626TU155','PARTNER'),
 ('0015','001500','HORS PARC','NEMO'),('0041','004108','8839TU210','HAMMAMI Mohamed'),
 ('0034','003407','HORS PARC','DELTA CUISINE'),('0023','002300','HORS PARC','REZGUI LOTFI'),
 ('0012','001203','HORS PARC','PARTENAIRE AYOUB'),('0010','001005','5205TU198','Houssem'),
 ('0036','003605','HORS PARC','CHARIOT'),('0030','003001','8700TU214','KASSEM'),
 ('0004','000403','HORS PARC','PARC'),('0024','002409','HORS PARC','GADOUR'),
 ('0033','003308','236TU398','MED NAJIB MAHFOUTH'),('0029','002905','243TU232','PARC'),
 ('0001','000106','HORS PARC','ADEL CHAABANE'),('0028','002805','HORS PARC','DELTA CUISINE'),
 ('0014','001401','HORS PARC','DELTA CUISINE')
), resolved AS (
 SELECT x.*,v.id vehicle_id,coalesce(v.company_id,(SELECT id FROM company WHERE code='DELTA')) company_id
 FROM cards x LEFT JOIN LATERAL (
   SELECT id,company_id FROM vehicle
   WHERE active AND deleted_at IS NULL AND (
     regexp_replace(upper(registration_display),'[^A-Z0-9]','','g')=x.registration OR
     regexp_replace(upper(registration_display),'[^A-Z0-9]','','g')=
       regexp_replace(x.registration,'^([0-9]+)TU([0-9]+)$','\2TU\1')
   ) LIMIT 1
 ) v ON x.registration NOT ILIKE 'HORS%'
), departments AS (
 INSERT INTO department(company_id,name)
 SELECT DISTINCT company_id,'Cartes Total' FROM resolved
 ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id,company_id
), beneficiaries AS (
 INSERT INTO beneficiary(company_id,department_id,display_name)
 SELECT DISTINCT r.company_id,d.id,r.holder FROM resolved r JOIN departments d ON d.company_id=r.company_id
 ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id,company_id,display_name
), updated AS (
 UPDATE fuel_card fc SET official_card_number=r.card_no,total_payment_number=r.payment_no,
   holder_name=r.holder,official_registration=r.registration,expires_on=date '2030-06-30',updated_at=now()
 FROM resolved r WHERE fc.deleted_at IS NULL AND (
   regexp_replace(fc.masked_card_number,'[^0-9]','','g')=r.payment_no OR
   regexp_replace(fc.masked_card_number,'[^0-9]','','g')=r.card_no)
 RETURNING fc.id,fc.company_id,fc.official_card_number,fc.holder_name
), inserted AS (
 INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,
   card_category,official_card_number,total_payment_number,holder_name,official_registration,expires_on)
 SELECT r.company_id,pgp_sym_encrypt(r.payment_no,$1,'cipher-algo=aes256'),hmac(r.payment_no,$2,'sha256'),
   r.payment_no,0,'ACTIVE',
   (CASE WHEN r.registration ILIKE 'HORS%' THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
   r.card_no,r.payment_no,r.holder,r.registration,date '2030-06-30' FROM resolved r
 WHERE NOT EXISTS(SELECT 1 FROM fuel_card fc WHERE fc.official_card_number=r.card_no OR
   regexp_replace(fc.masked_card_number,'[^0-9]','','g') IN (r.card_no,r.payment_no))
 ON CONFLICT(official_card_number) WHERE official_card_number IS NOT NULL DO UPDATE SET
   total_payment_number=excluded.total_payment_number,holder_name=excluded.holder_name,
   official_registration=excluded.official_registration,expires_on=excluded.expires_on,updated_at=now()
 RETURNING id,company_id,official_card_number,holder_name
), all_cards AS (
 SELECT * FROM updated UNION ALL SELECT * FROM inserted
)
INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status)
SELECT i.id,b.id,r.vehicle_id,'APPROVED_ZIN' FROM all_cards i
JOIN resolved r ON r.card_no=i.official_card_number
JOIN beneficiaries b ON b.company_id=i.company_id AND b.display_name=r.holder
WHERE NOT EXISTS(SELECT 1 FROM card_assignment ca WHERE ca.fuel_card_id=i.id AND ca.ends_at IS NULL AND ca.is_primary);

-- Reprend automatiquement les anciennes lignes mises en attente uniquement à
-- cause du format de plaque. L'affectation officielle de la carte reste la
-- source de vérité pour le véhicule et le titulaire.
WITH matched AS (
 SELECT tr.*,fc.id card_id,ca.vehicle_id,ca.beneficiary_id
 FROM transaction_review tr
 JOIN fuel_card fc ON fc.official_registration IS NOT NULL AND fc.official_registration NOT ILIKE 'HORS%'
 JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
 WHERE tr.status='PENDING' AND (
   regexp_replace(upper(tr.vehicle_registration),'[^A-Z0-9]','','g')=
     regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g') OR
   regexp_replace(upper(tr.vehicle_registration),'[^A-Z0-9]','','g')=
     regexp_replace(regexp_replace(upper(fc.official_registration),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1')
 )
)
INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,
 station,product,quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,
 previous_mileage,reported_mileage,authorization_code)
SELECT CASE WHEN authorization_code IS NOT NULL THEN 'TOTAL:'||authorization_code ELSE 'review:'||id END,
 card_id,beneficiary_id,vehicle_id,transaction_date,station,product,quantity_liters,amount_incl_tax,
 'TOTAL_EXCEL',import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code
FROM matched ON CONFLICT DO NOTHING;

UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),decision_reason='Rapprochement automatique carte/véhicule'
WHERE tr.status='PENDING' AND EXISTS(
 SELECT 1 FROM fuel_transaction ft WHERE ft.import_batch_id=tr.import_batch_id AND ft.source_row_number=tr.source_row_number
);

COMMIT;
