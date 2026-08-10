BEGIN;

-- Correction du referentiel officiel transmis le 10/08/2026 : 41 cartes,
-- plafonds mensuels, immatriculations fixes, observations et etat en coffre.
CREATE TEMP TABLE corrected_card_reference (
  payment_no text PRIMARY KEY,
  holder text NOT NULL,
  registration text,
  observation text,
  in_safe boolean NOT NULL DEFAULT false,
  monthly_limit numeric(14,3) NOT NULL
) ON COMMIT DROP;

INSERT INTO corrected_card_reference(payment_no,holder,registration,observation,in_safe,monthly_limit) VALUES
 ('002409','GADOUR',null,'CODE PIN NON DISPONIBLE',true,500),
 ('002003','NIZAR MAALAM','214 TU 9127','CODE PIN NON DISPONIBLE',true,300),
 ('001104','JUMPY','4276 TU 159','CODE PIN NON DISPONIBLE',true,250),
 ('001005','HOUSSEM',null,null,true,250),
 ('000106','ADEL CHAABANE',null,'PIN ACTIVEE',true,250),
 ('003803','GOLF','6257 TU 145',null,true,1000),
 ('000304','HAITHEM MILITI',null,null,false,150),
 ('003407','DELTA CUISINE',null,'CODE PIN NON DISPONIBLE',true,650),
 ('001609','DELTA CUISINE','7904 TU 138',null,true,300),
 ('004108','MED FELFEL','8839 TU 210',null,false,1200),
 ('001807','WISSAM GHARBI','170 TU 4850',null,false,300),
 ('002805','KAMEL RH',null,null,false,350),
 ('000205','SAFA RH',null,null,false,100),
 ('003308','NAJIB MAHFOUDH','398 TU 236',null,false,450),
 ('002904','ZIE RAHMANI','243 TU 232',null,false,350),
 ('001708','WALID TURKI','8698 TU 214',null,false,300),
 ('002102','YOSRI BEN SAAD',null,null,false,500),
 ('001500','AMINE HADDED',null,null,false,300),
 ('002508','HOSNI BEN ALI','7613 TU 242',null,false,500),
 ('003100','AHMED GARA','7085 TU 189',null,false,400),
 ('001203','AYOUB FAKER','5626 TU 155',null,false,250),
 ('000908','MAOHAMED TAYARI',null,null,false,200),
 ('003001','KACEM BOUCHRIKA',null,null,false,350),
 ('000809','TAIEB ALOUINI',null,null,false,200),
 ('003506','NAJIB CHARIOT',null,null,false,700),
 ('003605','NAJIB CHARIOT',null,null,false,700),
 ('000502','NAJIB AVANZA',null,null,false,200),
 ('002300','NAJIB D-MAX',null,null,false,500),
 ('000403','MED ALI DRIDI',null,null,false,150),
 ('000601','ANIS BEL HADJ MABROUK',null,null,false,200),
 ('001906','ISSAM KHOUNI','7992 TU 166',null,false,300),
 ('004009','JAWHAR DENGUIR','6499 TU 197','Le recu n''est pas signe.',false,1000),
 ('003902','TAHAR DENGUIR','9014 TU 242','Le recu n''est pas signe.',false,1000),
 ('003209','MAHREZ ZAKRAOUI','9458 TU 240',null,false,400),
 ('001401','SKANDER SADEK','596 TU 257',null,false,300),
 ('002706','YASSER','595 TU 257',null,false,500),
 ('002201','AMINE OUCHI','9459 TU 240',null,false,500),
 ('002607','MALEK POSEUR','7612 TU 243',null,false,500),
 ('001302','AYOUB',null,null,true,250),
 ('004207','TAIEB ALOUINI',null,null,true,250),
 ('000700','MOHAMED AMAYED',null,null,false,200);

-- legacy_state conserve les indications du fichier source sans rendre les
-- cartes inactives. Toutes les cartes restent donc utilisables.
UPDATE fuel_card fc SET
  holder_name=r.holder,
  official_registration=coalesce(r.registration,'HORS PARC'),
  monthly_limit=r.monthly_limit,
  legacy_state=concat_ws(' | ',CASE WHEN r.in_safe THEN 'EN COFFRE' END,r.observation),
  card_category=(CASE WHEN r.registration IS NULL THEN 'OFF_PARK' ELSE 'PERSONALIZED' END)::card_category,
  status='ACTIVE',
  updated_at=now()
FROM corrected_card_reference r
WHERE fc.deleted_at IS NULL AND fc.total_payment_number=r.payment_no;

-- Les cartes sans plaque fixe doivent rester libres : Najib saisit le
-- vehicule reel pour chaque transaction. On retire toute ancienne affectation
-- principale susceptible d'afficher une plaque obsolete.
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM fuel_card fc JOIN corrected_card_reference r ON r.payment_no=fc.total_payment_number
WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND r.registration IS NULL;

-- Cree les vehicules manquants correspondant aux plaques fixes.
WITH delta AS (SELECT id FROM company WHERE code='DELTA' LIMIT 1)
INSERT INTO vehicle(company_id,registration_display,brand,model)
SELECT delta.id,r.registration,r.holder,'Carte Total'
FROM corrected_card_reference r CROSS JOIN delta
WHERE r.registration IS NOT NULL
ON CONFLICT(company_id,registration_normalized) DO UPDATE SET
  registration_display=excluded.registration_display,active=true,deleted_at=null,updated_at=now();

WITH delta AS (SELECT id FROM company WHERE code='DELTA' LIMIT 1), dep AS (
  INSERT INTO department(company_id,name)
  SELECT id,'Cartes Total' FROM delta
  ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name
  RETURNING id,company_id
)
INSERT INTO beneficiary(company_id,department_id,display_name)
SELECT dep.company_id,dep.id,r.holder FROM corrected_card_reference r CROSS JOIN dep
ON CONFLICT(company_id,display_name) DO UPDATE SET active=true;

-- Remplace uniquement une affectation fixe devenue incorrecte; une affectation
-- deja conforme est preservee avec son historique.
WITH expected AS (
  SELECT fc.id AS card_id,b.id AS beneficiary_id,v.id AS vehicle_id
  FROM corrected_card_reference r
  JOIN fuel_card fc ON fc.deleted_at IS NULL AND fc.total_payment_number=r.payment_no
  JOIN beneficiary b ON b.company_id=fc.company_id AND b.display_name=r.holder
  JOIN vehicle v ON v.company_id=fc.company_id AND v.active AND v.deleted_at IS NULL
    AND v.registration_normalized=regexp_replace(upper(r.registration),'[^A-Z0-9]','','g')
  WHERE r.registration IS NOT NULL
)
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM expected e WHERE ca.fuel_card_id=e.card_id AND ca.ends_at IS NULL
  AND (ca.beneficiary_id<>e.beneficiary_id OR ca.vehicle_id IS DISTINCT FROM e.vehicle_id);

WITH expected AS (
  SELECT fc.id AS card_id,b.id AS beneficiary_id,v.id AS vehicle_id
  FROM corrected_card_reference r
  JOIN fuel_card fc ON fc.deleted_at IS NULL AND fc.total_payment_number=r.payment_no
  JOIN beneficiary b ON b.company_id=fc.company_id AND b.display_name=r.holder
  JOIN vehicle v ON v.company_id=fc.company_id AND v.active AND v.deleted_at IS NULL
    AND v.registration_normalized=regexp_replace(upper(r.registration),'[^A-Z0-9]','','g')
  WHERE r.registration IS NOT NULL
)
INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status)
SELECT e.card_id,e.beneficiary_id,e.vehicle_id,'APPROVED_ZIN' FROM expected e
WHERE NOT EXISTS (SELECT 1 FROM card_assignment ca
  WHERE ca.fuel_card_id=e.card_id AND ca.ends_at IS NULL AND ca.is_primary);

DO $$
DECLARE card_count integer; limit_total numeric(14,3); corrected_count integer;
BEGIN
  SELECT count(*),sum(monthly_limit) INTO card_count,limit_total FROM corrected_card_reference;
  IF card_count<>41 OR limit_total<>17050 THEN
    RAISE EXCEPTION 'Referentiel source invalide: % cartes, total plafonds %',card_count,limit_total;
  END IF;
  SELECT count(*) INTO corrected_count FROM fuel_card fc
  JOIN corrected_card_reference r ON r.payment_no=fc.total_payment_number
  WHERE fc.deleted_at IS NULL AND fc.monthly_limit=r.monthly_limit
    AND fc.holder_name=r.holder
    AND fc.official_registration=coalesce(r.registration,'HORS PARC');
  IF corrected_count<>41 THEN
    RAISE EXCEPTION 'La correction doit affecter exactement 41 cartes, obtenu: %',corrected_count;
  END IF;
END $$;

COMMIT;
