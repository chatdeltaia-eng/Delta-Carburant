BEGIN;

-- Ces deux profils doivent toujours être proposés comme responsables de carte,
-- quel que soit le client sélectionné.
UPDATE app_user
SET display_name='Zin Finance', active=true
WHERE role='ZIN_FINANCE' OR lower(email)='zin@deltacarburant.com';

UPDATE app_user
SET display_name='Mahdi BI', role='SUPER_ADMIN', active=true
WHERE lower(display_name) IN ('mahdi','mahdi bi','super admin','superadmin')
   OR lower(email) IN ('mehdi@deltacarburant.com','khaled.sfaxi@deltacuisine.com');

-- Répare les bases anciennes sur lesquelles les comptes initiaux n'existent pas.
INSERT INTO app_user(email,display_name,password_hash,role,active)
SELECT 'zin@deltacarburant.com','Zin Finance',password_hash,'ZIN_FINANCE',true
FROM app_user
WHERE password_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_user WHERE role='ZIN_FINANCE')
ORDER BY created_at
LIMIT 1;

INSERT INTO app_user(email,display_name,password_hash,role,active)
SELECT 'mehdi@deltacarburant.com','Mahdi BI',password_hash,'SUPER_ADMIN',true
FROM app_user
WHERE password_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM app_user
    WHERE role='SUPER_ADMIN'
      AND lower(display_name) IN ('mahdi','mahdi bi','super admin','superadmin')
  )
ORDER BY created_at
LIMIT 1;

COMMIT;
