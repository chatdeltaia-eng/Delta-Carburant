BEGIN;

UPDATE app_user
SET password_hash = '$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0'
WHERE email::text IN (
  'najib@deltacarburant.com',
  'zin@deltacarburant.com',
  'dg@deltacarburant.com',
  'superadmin@deltacarburant.com'
);

COMMIT;
