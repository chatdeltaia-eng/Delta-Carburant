BEGIN;

-- Restore access to the professional Mahdi BI account after its email was
-- normalized by migration 062. Limit the update to this exact account.
UPDATE app_user
SET password_hash = '$argon2id$v=19$m=65536,p=4,t=3$m3JTiGaWNzDvHLxc4lZ/Mg$kUE4d477iWz4CZoeIc3gFLhLbNg4BWcRHplDuZH9+6Q',
    active = true,
    failed_login_attempts = 0,
    locked_until = NULL,
    updated_at = now()
WHERE lower(email) = 'khaled.sfaxi@deltacuisine.com';

COMMIT;
