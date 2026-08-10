BEGIN;

-- Nouveau referentiel officiel transmis le 10/08/2026. Il remplace les
-- anciennes cartes sans supprimer les utilisateurs. Le numero Total est
-- conserve sur six chiffres pour correspondre aux exports de transactions.
CREATE TEMP TABLE new_total_card_reference (
  card_no text PRIMARY KEY,
  payment_no text UNIQUE NOT NULL,
  holder text NOT NULL,
  registration text
) ON COMMIT DROP;

INSERT INTO new_total_card_reference(card_no,payment_no,holder,registration) VALUES
 ('0001','002409','GADOUR',null),
 ('0002','002003','NIZAR MAALAM',null),
 ('0003','001104','JUMPY',null),
 ('0004','001005','HOUSSEM',null),
 ('0005','000106','ADEL CHAABANE',null),
 ('0006','003803','GOLF','6257TU 145'),
 ('0007','000304','HAITHEM MILITI',null),
 ('0008','003407','DELTA CUISINE',null),
 ('0009','001609','DELTA CUISINE','7904TU138'),
 ('0010','004108','MED FELFEL','588TU236'),
 ('0011','001807','WISSAM GHARBI','170 TU 4850'),
 ('0012','002805','KAMEL RH',null),
 ('0013','000205','SAFA RH',null),
 ('0014','003308','NAJIB MAHFOUDH','398TU236'),
 ('0015','002904','ZIE RAHMANI','243TU232'),
 ('0016','001708','WALID TURKI','8698TU214'),
 ('0017','002102','YOSRI BEN SAAD',null),
 ('0018','001500','AMINE HADDED',null),
 ('0019','002508','HOSNI BEN ALI',null),
 ('0020','003100','AHMED GARA','7085TU189'),
 ('0021','001203','AYOUB FAKER','5626TU155'),
 ('0022','000908','MAOHAMED TAYARI',null),
 ('0023','003001','KACEM BOUCHRIKA',null),
 ('0024','000809','TAIEB ALOUINI',null),
 ('0025','003506','NAJIB CHARIOT',null),
 ('0026','003605','NAJIB CHARIOT',null),
 ('0027','000502','NAJIB AVANZA',null),
 ('0028','002300','NAJIB D-MAX',null),
 ('0029','000403','MED ALI DRIDI',null),
 ('0030','000601','ANIS BEL HADJ MABROUK',null),
 ('0031','001906','ISSAM KHOUNI','7992TU166'),
 ('0032','004009','JAWHAR DENGUIR','6499TU197'),
 ('0033','003902','TAHAR DENGUIR','9014TU242'),
 ('0034','003209','MAHREZ ZAKRAOUI','9458 TU 240'),
 ('0035','001401','SKANDER SADEK','596TU257'),
 ('0036','002706','YASSER','595TU257'),
 ('0037','002201','AMINE OUCHI','9459 TU 240'),
 ('0038','002607','MALEK POSEUR','7612 TU 243'),
 ('0039','001302','AYOUB',null),
 ('0040','004207','TAIEB ALOUINI',null),
 ('0041','000700','MOHAMED AMAYED',null);

CREATE TEMP TABLE new_card_map ON COMMIT DROP AS
SELECT r.*, existing.id AS card_id
FROM new_total_card_reference r
LEFT JOIN LATERAL (
  SELECT fc.id
  FROM fuel_card fc
  WHERE (
    fc.total_payment_number=r.payment_no OR
    regexp_replace(fc.masked_card_number,'[^0-9]','','g')=r.payment_no OR
    (length(regexp_replace(fc.masked_card_number,'[^0-9]','','g'))>6 AND
      right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),6)=r.payment_no)
  )
  ORDER BY CASE WHEN fc.deleted_at IS NULL THEN 0 ELSE 1 END,
    CASE WHEN fc.total_payment_number=r.payment_no THEN 0 ELSE 1 END,fc.updated_at DESC
  LIMIT 1
) existing ON true;

-- Les numeros officiels de l'ancien referentiel ne designent pas toujours la
-- meme carte Total dans le nouveau fichier (par exemple 0001). La resolution
-- ci-dessus est faite a partir du numero Total; on libere ensuite les anciens
-- numeros officiels pour permettre leur reattribution sans collision unique.
UPDATE fuel_card SET official_card_number=null,updated_at=now()
WHERE official_card_number IS NOT NULL;

UPDATE fuel_card fc SET
  official_card_number=m.card_no,total_payment_number=m.payment_no,
  holder_name=m.holder,official_registration=coalesce(m.registration,'HORS PARC'),
  card_category=(CASE WHEN m.registration IS NULL THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
  status='ACTIVE',deleted_at=null,updated_at=now()
FROM new_card_map m WHERE fc.id=m.card_id;

WITH delta AS (SELECT id FROM company WHERE code='DELTA' LIMIT 1),
najib AS (SELECT id FROM app_user WHERE role='NAJIB_ASSIGNER' AND active ORDER BY created_at LIMIT 1)
INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,
  monthly_limit,status,card_category,responsible_user_id,official_card_number,total_payment_number,
  holder_name,official_registration,expires_on)
SELECT delta.id,pgp_sym_encrypt(m.payment_no,$1,'cipher-algo=aes256'),hmac(m.payment_no,$2,'sha256'),
  m.payment_no,0,'ACTIVE',(CASE WHEN m.registration IS NULL THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
  najib.id,m.card_no,m.payment_no,m.holder,coalesce(m.registration,'HORS PARC'),date '2030-06-30'
FROM new_card_map m CROSS JOIN delta CROSS JOIN najib WHERE m.card_id IS NULL;

-- Les 41 cartes appartiennent au perimetre visible de Najib. Les cartes sans
-- plaque sont reparties transaction par transaction; les autres conservent
-- leur plaque officielle.
UPDATE fuel_card fc SET responsible_user_id=najib.id,updated_at=now()
FROM new_total_card_reference r
CROSS JOIN LATERAL (SELECT id FROM app_user WHERE role='NAJIB_ASSIGNER' AND active ORDER BY created_at LIMIT 1) najib
WHERE fc.deleted_at IS NULL AND fc.total_payment_number=r.payment_no;

-- Une seule carte active par numero Total : rattache l'historique des anciens
-- doublons avant de les archiver.
CREATE TEMP TABLE obsolete_card_map ON COMMIT DROP AS
SELECT old.id AS old_id,current.id AS current_id
FROM fuel_card old
JOIN new_total_card_reference r ON (
  old.total_payment_number=r.payment_no OR
  (length(regexp_replace(old.masked_card_number,'[^0-9]','','g'))>6 AND
   right(regexp_replace(old.masked_card_number,'[^0-9]','','g'),6)=r.payment_no))
JOIN fuel_card current ON current.deleted_at IS NULL AND current.total_payment_number=r.payment_no
WHERE old.id<>current.id;

UPDATE fuel_transaction ft SET fuel_card_id=m.current_id,corrected_at=now()
FROM obsolete_card_map m WHERE ft.fuel_card_id=m.old_id;
UPDATE transaction_review tr SET fuel_card_id=m.current_id
FROM obsolete_card_map m WHERE tr.fuel_card_id=m.old_id;
UPDATE card_request cr SET fuel_card_id=m.current_id
FROM obsolete_card_map m WHERE cr.fuel_card_id=m.old_id;
UPDATE card_request cr SET source_card_id=m.current_id
FROM obsolete_card_map m WHERE cr.source_card_id=m.old_id;
UPDATE anomaly a SET fuel_card_id=m.current_id
FROM obsolete_card_map m WHERE a.fuel_card_id=m.old_id;
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM obsolete_card_map m WHERE ca.fuel_card_id=m.old_id AND ca.ends_at IS NULL;
UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
FROM obsolete_card_map m WHERE fc.id=m.old_id;

-- Rattache les lignes de controle creees lors des imports precedents, quand
-- ces nouveaux numeros n'existaient pas encore dans la base.
UPDATE transaction_review tr SET fuel_card_id=fc.id
FROM new_total_card_reference r
JOIN fuel_card fc ON fc.deleted_at IS NULL AND fc.total_payment_number=r.payment_no
WHERE tr.fuel_card_id IS NULL AND (
  regexp_replace(tr.card_number,'[^0-9]','','g')=r.payment_no OR
  regexp_replace(tr.card_number,'[^0-9]','','g')=r.card_no OR
  (length(regexp_replace(tr.card_number,'[^0-9]','','g'))>6 AND
   right(regexp_replace(tr.card_number,'[^0-9]','','g'),6)=r.payment_no)
);

-- Les transactions des cartes sans plaque ne doivent plus attendre une
-- verification de vehicule : Najib choisira la plaque reelle et repartira le
-- montant. On les transforme en transactions exploitables sans les dupliquer.
WITH matched_review AS (
  SELECT tr.*,fc.id AS card_id,fc.company_id,fc.holder_name
  FROM transaction_review tr
  JOIN fuel_card fc ON fc.id=tr.fuel_card_id AND fc.deleted_at IS NULL AND fc.card_category='OFF_PARK'
  WHERE tr.status='PENDING'
), dep AS (
  INSERT INTO department(company_id,name)
  SELECT DISTINCT company_id,'Hors parc' FROM matched_review
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id,company_id
), ben AS (
  INSERT INTO beneficiary(company_id,department_id,display_name)
  SELECT DISTINCT m.company_id,d.id,m.holder_name FROM matched_review m JOIN dep d USING(company_id)
  ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id,company_id,display_name
), inserted AS (
  INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,
    transaction_date,station,product,quantity_liters,amount_incl_tax,source,import_batch_id,
    source_row_number,previous_mileage,reported_mileage,authorization_code)
  SELECT coalesce('TOTAL:'||nullif(m.authorization_code,''),'review:'||m.id::text),m.card_id,b.id,null,
    m.transaction_date,m.station,m.product,m.quantity_liters,m.amount_incl_tax,'TOTAL_EXCEL',
    m.import_batch_id,m.source_row_number,m.previous_mileage,m.reported_mileage,m.authorization_code
  FROM matched_review m JOIN ben b ON b.company_id=m.company_id AND b.display_name=m.holder_name
  ON CONFLICT(external_transaction_id,source) DO NOTHING RETURNING import_batch_id,source_row_number
)
UPDATE transaction_review tr SET status='ACCEPTED',decided_at=now(),decision_reason='Rattachee automatiquement au nouveau referentiel des 41 cartes'
FROM matched_review m WHERE tr.id=m.id AND EXISTS (
  SELECT 1 FROM fuel_transaction ft WHERE ft.import_batch_id=m.import_batch_id
    AND ft.source_row_number=m.source_row_number AND ft.deleted_at IS NULL
);

-- Les anciennes cartes absentes de la nouvelle liste ne doivent plus compter
-- dans le tableau de bord.
UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
WHERE fc.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM new_total_card_reference r WHERE r.payment_no=fc.total_payment_number
);

DO $$
DECLARE card_count integer;
BEGIN
  SELECT count(*) INTO card_count FROM fuel_card WHERE deleted_at IS NULL;
  IF card_count<>41 THEN RAISE EXCEPTION 'Le nouveau referentiel doit contenir exactement 41 cartes, obtenu: %',card_count; END IF;
END $$;

COMMIT;
