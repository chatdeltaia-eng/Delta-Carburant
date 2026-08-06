BEGIN;

UPDATE app_user
SET email = regexp_replace(email::text, '@deltacarburant\.ma$', '@deltacarburant.com')::citext
WHERE email::text ~* '@deltacarburant\.ma$';

COMMIT;
