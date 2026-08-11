BEGIN;

-- Une affectation de reference (carte -> vehicule) ne doit pas etre confondue
-- avec la garde physique de la carte ni avec la repartition d'une transaction.
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS registration_missing boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS source_card_number text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS reference_beneficiary_id uuid REFERENCES beneficiary(id);
ALTER TABLE fuel_card ADD COLUMN IF NOT EXISTS reference_vehicle_id uuid REFERENCES vehicle(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_source_card
  ON vehicle(company_id,source_card_number) WHERE deleted_at IS NULL AND source_card_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fuel_card_reference_vehicle ON fuel_card(reference_vehicle_id);

CREATE TEMP TABLE new_fleet (
  position integer PRIMARY KEY,
  payment_number text UNIQUE NOT NULL,
  holder text NOT NULL,
  registration text,
  vehicle_type text,
  in_safe boolean NOT NULL DEFAULT false,
  managed_by_najib boolean NOT NULL DEFAULT false,
  observation text,
  monthly_limit numeric(14,3) NOT NULL
) ON COMMIT DROP;

INSERT INTO new_fleet(position,payment_number,holder,registration,vehicle_type,in_safe,managed_by_najib,observation,monthly_limit) VALUES
 (1,'2409','GADOUR',NULL,'Véhicule personnalisé',true,false,'Code PIN non disponible',500),
 (2,'2003','NIZAR MAALAM',NULL,'Véhicule personnalisé',true,false,'Code PIN non disponible',300),
 (3,'1104','JUPPY',NULL,'Jumpy',true,false,'Code PIN non disponible',250),
 (4,'1005','HOUSSEM',NULL,'Véhicule personnalisé',true,false,NULL,250),
 (5,'106','ADEL CHAABANE',NULL,'Véhicule personnalisé',true,false,'PIN activé',250),
 (6,'3803','GOLF','6257 TU 145','Golf',true,false,NULL,1000),
 (7,'304','HAITHEM MILITI',NULL,'Hyundai',false,false,NULL,150),
 (8,'3407','DELTA CUISINE',NULL,'Véhicule personnalisé',true,false,'Code PIN non disponible',650),
 (9,'1609','DELTA CUISINE','7904 TU 138',NULL,true,false,NULL,300),
 (10,'4108','MED FELFEL','588 TU 236',NULL,false,false,NULL,1200),
 (11,'1807','WISSAM GHARBI','181 TU 723',NULL,false,false,NULL,300),
 (12,'2805','KAMEL RH',NULL,'Golf 6',false,false,NULL,350),
 (13,'205','SAFA RH',NULL,'Dacia',false,false,NULL,100),
 (14,'3308','NAJIB MAHFOUDH','398 TU 236',NULL,false,false,NULL,450),
 (15,'2904','ZIE RAHMANI','243 TU 232',NULL,false,false,NULL,350),
 (16,'1708','WALID TURKI','8698 TU 214',NULL,false,false,NULL,300),
 (17,'2102','YOSRI BEN SAAD',NULL,'Golf 5',false,false,NULL,500),
 (18,'1500','AMINE HADDED',NULL,'Hyundai',false,false,NULL,300),
 (19,'2508','HOSNI BEN ALI','7613 TU 243',NULL,false,false,NULL,500),
 (20,'3100','AHMED GARA','7085 TU 189',NULL,false,false,NULL,400),
 (21,'1203','AYOUB FAKER','5626 TU 155',NULL,false,false,NULL,250),
 (22,'908','MAOHAMED TAYARI',NULL,'Peugeot 206',false,false,NULL,200),
 (23,'3001','KACEM BOUCHRIKA','8700 TU 214',NULL,false,false,NULL,350),
 (24,'809','TAIEB ALOUINI',NULL,'Citroën C4',false,false,NULL,200),
 (25,'3506','NAJIB CHARIOT',NULL,'Hyundai',false,true,NULL,700),
 (26,'3605','NAJIB CHARIOT',NULL,'Linde',false,true,NULL,700),
 (27,'502','NAJIB AVANZA','171 TU 6625',NULL,false,true,NULL,200),
 (28,'2300','NAJIB D-MAX','5102 TU 217','Isuzu D-Max',false,true,'Transactions répartissables à Malek Poseur',500),
 (29,'403','MED ALI DRIDI',NULL,'Opel',false,false,NULL,150),
 (30,'601','ANIS BEL HADJ MABROUK',NULL,'Kia',false,false,NULL,200),
 (31,'1906','ISSAM KHOUNI','7992 TU 166',NULL,false,false,NULL,300),
 (32,'4009','JAWHAR DENGUIR','6499 TU 197',NULL,false,false,'Le reçu n''est pas signé',1000),
 (33,'3902','TAHAR DENGUIR','9014 TU 242',NULL,false,false,'Le reçu n''est pas signé',1000),
 (34,'3209','MAHREZ ZAKRAOUI','9458 TU 240',NULL,false,true,NULL,400),
 (35,'1401','SKANDER SADEK','596 TU 257',NULL,false,true,NULL,300),
 (36,'2706','MOEZ SAIDI','595 TU 257',NULL,false,true,NULL,500),
 (37,'2201','AMINE OUCHI','9459 TU 240',NULL,false,true,NULL,500),
 (38,'2607','MALEK POSEUR','7612 TU 243',NULL,false,true,NULL,500),
 (39,'1302','AYOUB',NULL,'Véhicule personnalisé',true,false,NULL,250),
 (40,'4207','TAIEB ALOUINI',NULL,'Véhicule personnalisé',true,false,NULL,250),
 (41,'700','MOHAMED AMAYED',NULL,'Véhicule personnalisé',false,false,NULL,200);

DO $$
DECLARE
  dc_id uuid;
  najib_id uuid;
  item record;
  card_id uuid;
  vehicle_id uuid;
  beneficiary_id uuid;
  department_id uuid;
  matched_cards integer;
BEGIN
  SELECT id INTO dc_id FROM company WHERE code='DC' AND active LIMIT 1;
  SELECT id INTO najib_id FROM app_user WHERE role='NAJIB_ASSIGNER' AND active
    ORDER BY CASE WHEN lower(display_name) LIKE '%najib%' THEN 0 ELSE 1 END,created_at LIMIT 1;
  IF dc_id IS NULL THEN RAISE EXCEPTION 'Société DC introuvable'; END IF;
  IF najib_id IS NULL THEN RAISE EXCEPTION 'Responsable Najib introuvable'; END IF;

  SELECT count(*) INTO matched_cards FROM new_fleet nf WHERE EXISTS (
    SELECT 1 FROM fuel_card fc WHERE fc.deleted_at IS NULL AND
      coalesce(nullif(ltrim(regexp_replace(coalesce(fc.total_payment_number,fc.masked_card_number),'[^0-9]','','g'),'0'),''),'0')=
      coalesce(nullif(ltrim(nf.payment_number,'0'),''),'0'));
  IF matched_cards<>41 THEN
    RAISE EXCEPTION 'Référentiel incomplet : % carte(s) trouvée(s) sur 41',matched_cards;
  END IF;

  INSERT INTO department(company_id,name) VALUES(dc_id,'Cartes Total')
    ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id INTO department_id;

  -- Les anciennes lignes restent historisées pour les anciennes transactions,
  -- mais disparaissent du référentiel actif.
  UPDATE vehicle SET active=false,deleted_at=coalesce(deleted_at,now()),updated_at=now()
  WHERE deleted_at IS NULL;

  FOR item IN SELECT * FROM new_fleet ORDER BY position LOOP
    SELECT id INTO card_id FROM fuel_card fc WHERE fc.deleted_at IS NULL AND
      coalesce(nullif(ltrim(regexp_replace(coalesce(fc.total_payment_number,fc.masked_card_number),'[^0-9]','','g'),'0'),''),'0')=
      coalesce(nullif(ltrim(item.payment_number,'0'),''),'0') LIMIT 1;

    INSERT INTO vehicle(company_id,registration_normalized,registration_display,vehicle_type,model,
      driver_name,notes,active,managed_by,registration_missing,source_card_number,deleted_at)
    VALUES(dc_id,
      CASE WHEN item.registration IS NULL THEN 'CARTE'||item.payment_number ELSE regexp_replace(upper(item.registration),'[^A-Z0-9]','','g') END,
      coalesce(item.registration,'Sans matricule'),item.vehicle_type,item.vehicle_type,item.holder,item.observation,true,
      CASE WHEN item.managed_by_najib THEN najib_id ELSE NULL END,item.registration IS NULL,item.payment_number,NULL)
    ON CONFLICT(company_id,registration_normalized) DO UPDATE SET
      registration_display=excluded.registration_display,vehicle_type=excluded.vehicle_type,model=excluded.model,
      driver_name=excluded.driver_name,notes=excluded.notes,active=true,managed_by=excluded.managed_by,
      registration_missing=excluded.registration_missing,source_card_number=excluded.source_card_number,
      deleted_at=NULL,updated_at=now()
    RETURNING id INTO vehicle_id;

    INSERT INTO beneficiary(company_id,department_id,display_name)
      VALUES(dc_id,department_id,item.holder)
      ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id INTO beneficiary_id;

    UPDATE vehicle SET reference_beneficiary_id=beneficiary_id WHERE id=vehicle_id;

    UPDATE fuel_card SET company_id=dc_id,holder_name=item.holder,
      official_registration=item.registration,reference_vehicle_id=vehicle_id,
      card_category=CASE WHEN item.managed_by_najib THEN 'OFF_PARK'::card_category ELSE 'PERSONALIZED'::card_category END,
      responsible_user_id=CASE WHEN item.managed_by_najib THEN najib_id ELSE NULL END,
      monthly_limit=item.monthly_limit,legacy_state=concat_ws(' | ',CASE WHEN item.in_safe THEN 'EN COFFRE' END,item.observation),
      status=CASE WHEN item.in_safe THEN 'SAFE'::card_status ELSE 'ACTIVE'::card_status END,updated_at=now()
    WHERE id=card_id;

    UPDATE card_assignment SET ends_at=coalesce(ends_at,now())
      WHERE fuel_card_id=card_id AND ends_at IS NULL;
    IF NOT item.in_safe THEN
      INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at)
      VALUES(card_id,beneficiary_id,vehicle_id,'APPROVED_ZIN',najib_id,najib_id,now());
    END IF;
  END LOOP;

  -- Les cartes absentes des captures ne font plus partie du référentiel actif.
  UPDATE fuel_card fc SET status='SUSPENDED',responsible_user_id=NULL,updated_at=now()
  WHERE fc.deleted_at IS NULL AND fc.company_id=dc_id AND NOT EXISTS (
    SELECT 1 FROM new_fleet nf WHERE
      coalesce(nullif(ltrim(regexp_replace(coalesce(fc.total_payment_number,fc.masked_card_number),'[^0-9]','','g'),'0'),''),'0')=
      coalesce(nullif(ltrim(nf.payment_number,'0'),''),'0'));

  -- Remise à zéro opérationnelle demandée avant le nouvel import Total.
  -- Rien n'est détruit physiquement : l'historique et l'audit restent
  -- récupérables, mais aucune ancienne anomalie/répartition ne réapparaît.
  UPDATE transaction_allocation SET workflow_status='REJECTED',reviewed_by=najib_id,
    reviewed_at=now(),decision_reason='Réinitialisation avant nouvel import Total'
  WHERE workflow_status IN ('PENDING','APPROVED');
  UPDATE fuel_transaction SET deleted_at=coalesce(deleted_at,now()),deleted_by=coalesce(deleted_by,najib_id)
  WHERE deleted_at IS NULL;
  UPDATE transaction_review SET status='REJECTED',decided_by=najib_id,decided_at=now(),
    decision_reason='Réinitialisation avant nouvel import Total' WHERE status='PENDING';
  UPDATE anomaly SET status='RESOLVED',resolution='Réinitialisation du référentiel et nouvel import Total demandé',
    resolved_at=now() WHERE status IN ('OPEN','IN_REVIEW');
  UPDATE mileage_reading SET status='REJECTED',validated_by=najib_id,validated_at=now(),
    rejection_reason='Réinitialisation avant nouvel import Total',
    decision_reason='Réinitialisation avant nouvel import Total' WHERE status='PENDING';
  INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
    VALUES('migration-038','REBUILD_REFERENCE','vehicle','ALL',
      jsonb_build_object('vehicles',41,'safeCards',10,'transactionsReset',true,'anomaliesResolved',true));
END $$;

DO $$
DECLARE vehicle_count integer; linked_count integer; beneficiary_count integer; safe_count integer;
  invalid_safe integer; dmax_count integer; non_dc_count integer; limit_total numeric(14,3);
BEGIN
  SELECT count(*) INTO vehicle_count FROM vehicle v
    WHERE v.active AND v.deleted_at IS NULL AND v.source_card_number IS NOT NULL;
  SELECT count(*) INTO non_dc_count FROM vehicle v JOIN company c ON c.id=v.company_id
    WHERE v.active AND v.deleted_at IS NULL AND c.code<>'DC';
  SELECT count(*) INTO linked_count FROM fuel_card fc JOIN vehicle v ON v.id=fc.reference_vehicle_id
    WHERE fc.deleted_at IS NULL AND v.active AND v.deleted_at IS NULL;
  SELECT count(*) INTO beneficiary_count FROM vehicle v JOIN beneficiary b ON b.id=v.reference_beneficiary_id
    WHERE v.active AND v.deleted_at IS NULL AND b.company_id=v.company_id;
  SELECT count(*),sum(monthly_limit) INTO safe_count,limit_total FROM fuel_card WHERE deleted_at IS NULL AND status='SAFE';
  SELECT count(*) INTO invalid_safe FROM fuel_card fc JOIN card_assignment ca ON ca.fuel_card_id=fc.id
    WHERE fc.deleted_at IS NULL AND fc.status='SAFE' AND ca.ends_at IS NULL;
  SELECT count(*) INTO dmax_count FROM fuel_card fc JOIN vehicle v ON v.id=fc.reference_vehicle_id
    WHERE fc.deleted_at IS NULL AND fc.total_payment_number='002300' AND fc.holder_name='NAJIB D-MAX'
      AND v.registration_normalized='5102TU217';
  IF vehicle_count<>41 OR linked_count<>41 OR beneficiary_count<>41 OR non_dc_count<>0 THEN
    RAISE EXCEPTION 'Référentiel invalide : % véhicules, % cartes, % bénéficiaires, % hors DC',vehicle_count,linked_count,beneficiary_count,non_dc_count;
  END IF;
  IF safe_count<>10 OR invalid_safe<>0 THEN
    RAISE EXCEPTION 'État coffre invalide : % cartes, % distribution(s) active(s)',safe_count,invalid_safe;
  END IF;
  IF dmax_count<>1 THEN RAISE EXCEPTION 'Affectation Najib D-Max / carte 2300 invalide'; END IF;
  SELECT sum(monthly_limit) INTO limit_total FROM fuel_card WHERE deleted_at IS NULL;
  IF limit_total<>17050 THEN RAISE EXCEPTION 'Total des plafonds invalide : %',limit_total; END IF;
END $$;

COMMIT;
