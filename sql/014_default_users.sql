BEGIN;

INSERT INTO app_user (email, display_name, password_hash, role, active)
VALUES
  ('najib@deltacarburant.com', 'Najib', '$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0', 'NAJIB_ASSIGNER', true),
  ('zin@deltacarburant.com', 'Zin', '$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0', 'ZIN_FINANCE', true),
  ('dg@deltacarburant.com', 'Direction Generale', '$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0', 'DIRECTION_GENERAL', true),
  ('superadmin@deltacarburant.com', 'Super Admin', '$argon2id$v=19$m=65536,p=4,t=3$RiK01tVoy3eihaK/IFQNYQ$Py+nQi6H6UINTNsCac9xf3HErt09DJmaWQ2zlIv6rL0', 'SUPER_ADMIN', true)
ON CONFLICT (email) DO UPDATE
SET display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    active = true;

COMMIT;
