BEGIN;

-- Référentiel officiel Total fourni par Zin. Les numéros sont stockés sans
-- espaces afin de correspondre directement aux exports Total.
WITH reference(card_no,payment_no,holder,registration,card_status) AS (VALUES
 ('0033','003308','MED NAJIB MAHFOUTH','236 TU 398','ACTIVE'::card_status),
 ('0029','002904','PARC','243 TU 232','ACTIVE'::card_status),
 ('0001','000106','ADEL CHAABANE','HORS PARC','ACTIVE'::card_status),
 ('0028','002805','DELTA CUISINE','HORS PARC','ACTIVE'::card_status),
 ('0014','001401','DELTA CUISINE','HORS PARC','ACTIVE'::card_status),
 ('0010','001005','Houssem','5205 TU 198','ACTIVE'::card_status),
 ('0036','003605','CHARIOT','HORS PARC','ACTIVE'::card_status),
 ('0030','003001','KASSEM','8700 TU 214','ACTIVE'::card_status),
 ('0004','000403','PARC','HORS PARC','ACTIVE'::card_status),
 ('0024','002409','GADOUR','HORS PARC','ACTIVE'::card_status),
 ('0015','001500','NEMO','HORS PARC','ACTIVE'::card_status),
 ('0041','004108','HAMMALI Mohamed','8839 TU 210','ACTIVE'::card_status),
 ('0034','003407','DELTA CUISINE','HORS PARC','ACTIVE'::card_status),
 ('0023','002300','REZGUI LOTFI','HORS PARC','ACTIVE'::card_status),
 ('0012','001203','PARTENAIRE AYOUB','HORS PARC','ACTIVE'::card_status),
 ('0008','000809','TAIEB ALOUANI','Citroen C4','ACTIVE'::card_status),
 ('0022','002201','DELTA CUISINE','2646 TU 221','ACTIVE'::card_status),
 ('0003','000304','HAITHEM MILITTI','HORS PARC','ACTIVE'::card_status),
 ('0035','003506','DELTA CUISINE','HORS PARC','ACTIVE'::card_status),
 ('0021','002102','PARTNER','5626 TU 155','ACTIVE'::card_status),
 ('0007','000700','MOUHAMMED BAHI-BATIMENT','HORS PARC','ACTIVE'::card_status),
 ('0019','001906','SEIFEDDINE SAID','166 TU 7992','ACTIVE'::card_status),
 ('0016','001609','DELTA CUISINE','7904 TU 138','ACTIVE'::card_status),
 ('0025','002508','TOYOTA HIACE','7613 TU 242','ACTIVE'::card_status),
 ('0006','000601','DELTA CUISINE','HORS PARC','ACTIVE'::card_status),
 ('0002','000205','SAFA HOUIJI','HORS PARC','ACTIVE'::card_status),
 ('0009','000908','MOHAMED TAYARI','HORS PARC','ACTIVE'::card_status),
 ('0011','001104','JUMPY','4276 TU 159','ACTIVE'::card_status),
 ('0027','002706','DELTA CUISINE','595 TU 257','ACTIVE'::card_status),
 ('0005','000502','AVANZA','HORS PARC','ACTIVE'::card_status),
 ('0031','003100','Ahmed MAREGHNI','6674 TU 175','ACTIVE'::card_status),
 ('0039','003902','TAHER DENGUIR','HORS PARC','ACTIVE'::card_status),
 ('0040','004009','JAWHER DENGAIR','HORS PARC','ACTIVE'::card_status),
 ('0020','002003','NIZAR MAALAM','214 TU 9127','ACTIVE'::card_status),
 ('0032','003209','MEHREZ ZAKRAOUI','9458 TU 240','ACTIVE'::card_status),
 ('0026','002607','DELTA CUISINE','596 TU 257','ACTIVE'::card_status),
 ('0038','003803','GOLF','6257 TU 145','ACTIVE'::card_status),
 ('0018','001807','GHARBI Wissam','170 TU 4850','ACTIVE'::card_status),
 ('0042','004207','TAIEB ALWANI','C4','SUSPENDED'::card_status),
 ('0043','004306','SAFA MIMOUNI','HORS PARC','SUSPENDED'::card_status),
 ('0013','001302','AYOUB','HORS PARC','SUSPENDED'::card_status),
 ('0017','001708','HORS PARC 14','HORS PARC','SUSPENDED'::card_status),
 ('0037','003704','DELTA CUISINE','HORS PARC','SUSPENDED'::card_status)
), resolved AS (
 SELECT r.*,v.id AS vehicle_id,
   coalesce(v.company_id,(SELECT id FROM company WHERE code='DELTA' LIMIT 1)) AS company_id
 FROM reference r
 LEFT JOIN LATERAL (
   SELECT v.id,v.company_id FROM vehicle v
   WHERE v.active AND v.deleted_at IS NULL
     AND regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g') IN (
       regexp_replace(upper(r.registration),'[^A-Z0-9]','','g'),
       regexp_replace(regexp_replace(upper(r.registration),'[^A-Z0-9]','','g'),'^([0-9]+)TU([0-9]+)$','\2TU\1'))
   ORDER BY CASE WHEN regexp_replace(upper(v.registration_display),'[^A-Z0-9]','','g')=
     regexp_replace(upper(r.registration),'[^A-Z0-9]','','g') THEN 0 ELSE 1 END
   LIMIT 1
 ) v ON regexp_replace(upper(r.registration),'[^A-Z0-9]','','g') NOT IN ('HORSPARC','C4','CITROENC4')
), updated AS (
 UPDATE fuel_card fc SET
   company_id=r.company_id,
   official_card_number=r.card_no,
   total_payment_number=r.payment_no,
   holder_name=r.holder,
   official_registration=r.registration,
   expires_on=date '2030-06-30',
   status=r.card_status,
   card_category=(CASE WHEN regexp_replace(upper(r.registration),'[^A-Z0-9]','','g') IN ('HORSPARC','C4','CITROENC4')
     THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
   updated_at=now()
 FROM resolved r
 WHERE fc.deleted_at IS NULL AND (
   fc.official_card_number=r.card_no OR fc.total_payment_number=r.payment_no OR
   regexp_replace(fc.masked_card_number,'[^0-9]','','g') IN (r.card_no,r.payment_no))
 RETURNING fc.id,fc.official_card_number,fc.company_id
), inserted AS (
 INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,
   card_category,official_card_number,total_payment_number,holder_name,official_registration,expires_on)
 SELECT r.company_id,pgp_sym_encrypt(r.payment_no,$1,'cipher-algo=aes256'),hmac(r.payment_no,$2,'sha256'),
   r.payment_no,0,r.card_status,
   (CASE WHEN regexp_replace(upper(r.registration),'[^A-Z0-9]','','g') IN ('HORSPARC','C4','CITROENC4')
     THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
   r.card_no,r.payment_no,r.holder,r.registration,date '2030-06-30'
 FROM resolved r
 WHERE NOT EXISTS (SELECT 1 FROM fuel_card fc WHERE fc.deleted_at IS NULL AND (
   fc.official_card_number=r.card_no OR fc.total_payment_number=r.payment_no OR
   regexp_replace(fc.masked_card_number,'[^0-9]','','g') IN (r.card_no,r.payment_no)))
 RETURNING id,official_card_number,company_id
), all_cards AS (
 SELECT * FROM updated UNION ALL SELECT * FROM inserted
), departments AS (
 INSERT INTO department(company_id,name)
 SELECT DISTINCT company_id,'Cartes Total' FROM resolved WHERE company_id IS NOT NULL
 ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id,company_id
), beneficiaries AS (
 INSERT INTO beneficiary(company_id,department_id,display_name)
 SELECT DISTINCT r.company_id,d.id,r.holder FROM resolved r JOIN departments d ON d.company_id=r.company_id
 ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id,company_id,display_name
), assigned AS (
 UPDATE card_assignment ca SET beneficiary_id=b.id,vehicle_id=r.vehicle_id,
   workflow_status='APPROVED_ZIN',reviewed_at=now()
 FROM all_cards c JOIN resolved r ON r.card_no=c.official_card_number
 JOIN beneficiaries b ON b.company_id=r.company_id AND b.display_name=r.holder
 WHERE ca.fuel_card_id=c.id AND ca.ends_at IS NULL AND ca.is_primary
 RETURNING ca.fuel_card_id
)
INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status)
SELECT c.id,b.id,r.vehicle_id,'APPROVED_ZIN'
FROM all_cards c JOIN resolved r ON r.card_no=c.official_card_number
JOIN beneficiaries b ON b.company_id=r.company_id AND b.display_name=r.holder
WHERE NOT EXISTS (SELECT 1 FROM card_assignment ca
  WHERE ca.fuel_card_id=c.id AND ca.ends_at IS NULL AND ca.is_primary);

-- Corrige aussi les transactions déjà importées : la ligne source et le
-- numéro de paiement Total déterminent la carte; sa plaque officielle
-- détermine ensuite le véhicule. Le montant journalier reste inchangé.
WITH matched AS (
 SELECT DISTINCT ON (ft.id) ft.id AS transaction_id,fc.id AS card_id,ca.beneficiary_id,ca.vehicle_id
 FROM fuel_transaction ft
 JOIN transaction_review tr ON tr.import_batch_id=ft.import_batch_id AND tr.source_row_number=ft.source_row_number
 JOIN fuel_card fc ON fc.deleted_at IS NULL AND (
   fc.total_payment_number=regexp_replace(tr.card_number,'[^0-9]','','g') OR
   fc.official_card_number=regexp_replace(tr.card_number,'[^0-9]','','g') OR
   nullif(ltrim(fc.total_payment_number,'0'),'')=nullif(ltrim(regexp_replace(tr.card_number,'[^0-9]','','g'),'0'),'') OR
   nullif(ltrim(fc.official_card_number,'0'),'')=nullif(ltrim(regexp_replace(tr.card_number,'[^0-9]','','g'),'0'),''))
 LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
 WHERE ft.deleted_at IS NULL
 ORDER BY ft.id,CASE WHEN fc.total_payment_number=regexp_replace(tr.card_number,'[^0-9]','','g') THEN 0 ELSE 1 END
)
UPDATE fuel_transaction ft SET fuel_card_id=m.card_id,
  beneficiary_id=coalesce(m.beneficiary_id,ft.beneficiary_id),
  vehicle_id=coalesce(m.vehicle_id,ft.vehicle_id),corrected_at=now()
FROM matched m WHERE ft.id=m.transaction_id AND (
  ft.fuel_card_id IS DISTINCT FROM m.card_id OR
  (m.beneficiary_id IS NOT NULL AND ft.beneficiary_id IS DISTINCT FROM m.beneficiary_id) OR
  (m.vehicle_id IS NOT NULL AND ft.vehicle_id IS DISTINCT FROM m.vehicle_id));

COMMIT;
