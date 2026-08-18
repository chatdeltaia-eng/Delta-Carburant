BEGIN;

-- Ces clients sont disponibles dans la session Mobility Business. Ils doivent
-- être proposés dès la connexion, même avant leur première extraction de
-- cartes. L'agent les enrichira ensuite sans recréer de société.
INSERT INTO company(code,name,active) VALUES
  ('IKIT','IKIT TN',true),
  ('TCM','STE LES TECHNIQUES DE MARBRE',true),
  ('DCD','DELTA CUISINE DISTRIBUTION',true)
ON CONFLICT(code) DO UPDATE SET name=excluded.name,active=true,updated_at=now();

INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
VALUES('migration-069','REGISTER_TOTAL_CLIENTS','system','TOTAL_MOBILITY_CLIENTS',
  '{"clients":["IKIT TN","STE LES TECHNIQUES DE MARBRE","DELTA CUISINE DISTRIBUTION"]}'::jsonb);

COMMIT;
