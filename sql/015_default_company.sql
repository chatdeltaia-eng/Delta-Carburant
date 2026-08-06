BEGIN;

INSERT INTO company (code, name, active)
VALUES ('DELTA', 'Delta Carburant', true)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    active = true;

UPDATE app_user
SET company_id = (SELECT id FROM company WHERE code = 'DELTA')
WHERE email::text IN (
  'najib@deltacarburant.com',
  'zin@deltacarburant.com',
  'dg@deltacarburant.com',
  'superadmin@deltacarburant.com'
);

COMMIT;
