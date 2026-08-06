BEGIN;

-- Les responsables hors parc utilisent le même rôle métier ; leur identité et
-- leur périmètre sont portés par app_user et fuel_card.responsible_user_id.
INSERT INTO app_user(company_id,email,display_name,password_hash,role,active)
SELECT c.id,v.email,v.name,'$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0','NAJIB_ASSIGNER',true
FROM company c CROSS JOIN (VALUES
 ('aymen@deltacarburant.com','Aymen'),('mouine@deltacarburant.com','Mouine'),
 ('khalil@deltacarburant.com','Khalil'),('mehdi@deltacarburant.com','Mehdi'),
 ('coffre.jawhar@deltacarburant.com','Coffre Jawhar')
) v(email,name) WHERE c.code='DELTA'
ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,active=true;

INSERT INTO company(code,name) VALUES
 ('DC','Delta Cuisine'),('DCD','Delta Cuisine Distribution'),('TCM','TCM'),('IKIT','IKIT')
ON CONFLICT(code) DO UPDATE SET name=excluded.name,active=true;

ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS fleet_number integer;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS vehicle_type text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS first_registration_date date;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS owner_name text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS credit_due_date date;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS assignment_company text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS driver_name text;
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS notes text;

WITH source(no,registration,kind,company_code,brand,model,driver,notes) AS (VALUES
(1,'945TU144','CRAFTER','DC','VOLKSWAGEN','2EH1B5','RAMZI SOLTANI','SOUS-TRAITANCE'),
(2,'5626TU155','PARTNER','DC','PEUGEOT','GBWJYB1P','AYOUB',null),(3,'5629TU155','PARTNER','DC','PEUGEOT','GBWJYB1P','RIDHA BEN KHLIFA','SOUS-TRAITANCE'),
(4,'1673TU163','DUCATO','TCM','FIAT','250 CCMFCBX','MONDHER DHAWAHRI',null),(5,'7992TU166','NEMO','DC','CITROEN','AA8HSC','ISSAM - MAINTENANCE',null),
(6,'5266TU168','CLIO','DC','RENAULT','5ROKOH','TAHAR DENGUIR',null),(7,'6625TU171','AVANZA','DC','TOYOTA','F651LMGQMF','SCE-MAINTENANCE-PARC AUTO',null),
(8,'3555TU173','CRAFTER','DC','VOLKSWAGEN',null,'CHADLY MECNO','EN PANNE - SOUS-TRAITANCE'),(9,'3557TU173','CRAFTER','DC','VOLKSWAGEN','2EFH1F5','SKANDER SADEK',null),
(10,'2472TU177','NEMO','IKIT','CITROEN','NEMO','WALID TURKI',null),(11,'723TU181','SEAT','DCD','SEAT','LEON','CHEDLY WISSAM GHARBI',null),
(12,'688TU187','CAMION','IKIT','HYUNDAI','CAMION','MALEK',null),(13,'6625TU189','CRAFTER','TCM','VOLKSWAGEN','CRAFTER','CHADLY MECNO','EN PANNE'),
(14,'7085TU189','MAZDA 2','TCM','MAZDA','2','AHMED GARA',null),(15,'8667TU196','DUCATO','DCD','FIAT','DUCATO','CHAFIK SABBAHI',null),
(16,'6499TU197','TIGUAN','IKIT','VOLKSWAGEN','TIGUAN','JAWHAR DENGUIR',null),(17,'9247TU197','TATA','DC','TATA',null,'AHMED MANSOUR','SOUS-TRAITANCE'),
(18,'671TU198','MAZDA','DC','MAZDA','9','TAHER DENGUIR',null),(19,'4162TU200','NEMO','DCD','CITROEN','NEMO','IKIT-SFAX',null),
(20,'3986TU202','NEMO','DC','CITROEN','NEMO','METREUR - CHARGUIA - EZZEDDINE',null),(21,'1155TU205','DUCATO','TCM','FIAT','250 CCMFCBX','BEL AOUED AUTO','EN PANNE'),
(22,'8839TU210','MICRO-BUS','DC','HYUNDAI','H350','MED FELFEL',null),(23,'8700TU214','FIORINO','TCM','FIAT','FIORINO','KACEM - PROMOTION',null),
(24,'8698TU214','FIORINO','DC','FIAT','FIORINO','WALID TURKI',null),(25,'9127TU214','FIORINO','IKIT','FIAT','FIORINO','NIZAR MAALEM / YASSINE',null),
(26,'5102TU217','DMAX','TCM','ISUZU','DMAX','MOHAMED AMAYED',null),(27,'6987TU219','T.KING','DC','T.KING',null,'SEDDIK',null),
(28,'2646TU221','DONGFENG','IKIT','DONGFENG',null,'BEL AOUED AUTO','EN PANNE'),(29,'7224TU227','HYUNDAI H350','DC','HYUNDAI','H350','MOHAMED HAMMAMI',null),
(30,'7223TU227','HYUNDAI H350','TCM','HYUNDAI','H350','CHAFIK SABBAHI',null),(31,'9895TU227','FIORINO','DCD','FIAT','FIORINO','WAEL KROUT',null),
(32,'9894TU227','FIORINO','DCD','FIAT','FIORINO','AYMEN NECHI - METREUR - HAMMAMET',null),(33,'9896TU227','FIORINO','DC','FIAT','FIORINO','SHOW ROOM DJERBA',null),
(34,'8198TU229','TOYOTA','TCM','TOYOTA','RAV 4','FAKHRI DENGUIR',null),(35,'7726TU231','FIORINO','IKIT','FIAT','FIORINO','YAHYAOUI ABDERAHMEN','SOUS-TRAITANCE'),
(36,'9313TU231','OPEL','DC','OPEL','MOKKA','HOUSSEM DENGUIR',null),(37,'243TU232','FIORINO','DC','FIAT','FIORINO','COURSIER - BECHRY ABDERAZZEK',null),
(38,'398TU236','OPEL','DCD','OPEL','COMBO','MED NAJIB MAHFOUDH',null),(39,'588TU236','OPEL','DCD','OPEL','COMBO','MED FELFEL',null),
(40,'7303TU242','MERCEDES','DCD','MERCEDES','C180','MOHAMED DENGUIR',null),(41,'9014TU242','SKODA','DC','SKODA','OCTAVIA','TAHAR DENGUIR',null),
(42,'9459TU240','TOYOTA','DCD','TOYOTA','HIACE','RAOUF',null),(43,'IMMATRICULATION-MANQUANTE-43','TOYOTA','DCD','TOYOTA','HIACE','RAMZI GHAZWANI','IMMATRICULATION À COMPLÉTER'),
(44,'7613TU243','TOYOTA','DCD','TOYOTA','HIACE','HOSNI',null),(45,'7612TU243','TOYOTA','DCD','TOYOTA','HIACE','AMINE',null),
(46,'811TU246','TOYOTA','TCM','TOYOTA','HIACE','MEHREZ',null),(47,'4274TU254','BOXER','DCD','PEUGEOT','BOXER','AMARA - POSE',null),
(48,'3619TU254','BOXER','DC','PEUGEOT','BOXER','HBIB RAJHI',null),(49,'596TU257','TOYOTA','DC','TOYOTA','HIACE','MOHAMED BEN MBAREK',null),
(50,'595TU257','TOYOTA','DC','TOYOTA','HIACE','BILEL',null)
)
INSERT INTO vehicle(company_id,registration_normalized,registration_display,brand,model,active,requires_review,fleet_number,vehicle_type,driver_name,notes)
SELECT c.id,upper(regexp_replace(s.registration,'[^A-Za-z0-9]','','g')),s.registration,s.brand,s.model,
 s.no<>43,s.no=43,s.no,s.kind,s.driver,s.notes FROM source s JOIN company c ON c.code=s.company_code
ON CONFLICT(company_id,registration_normalized) DO UPDATE SET brand=excluded.brand,model=excluded.model,
 active=excluded.active,requires_review=excluded.requires_review,fleet_number=excluded.fleet_number,
 vehicle_type=excluded.vehicle_type,driver_name=excluded.driver_name,notes=excluded.notes;

COMMIT;
