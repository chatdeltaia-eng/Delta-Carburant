BEGIN;

CREATE TABLE IF NOT EXISTS management_mail_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type text NOT NULL,
  recipients text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('SENT','FAILED','SKIPPED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_management_mail_log_daily ON management_mail_log(report_type,created_at DESC);

-- Mahdi BI utilise l'adresse professionnelle communiquée par la Direction.
-- Une base ancienne peut contenir à la fois les profils « Mahdi » et
-- « Super Admin ». Ne modifier qu'un seul compte évite d'attribuer la même
-- adresse (unique) aux deux lignes pendant cette migration.
WITH mahdi_account AS (
  SELECT id
  FROM app_user
  WHERE lower(display_name) IN ('mahdi','mahdi bi','super admin','superadmin')
  ORDER BY
    CASE lower(display_name)
      WHEN 'mahdi bi' THEN 0
      WHEN 'mahdi' THEN 1
      ELSE 2
    END,
    created_at,
    id
  LIMIT 1
)
UPDATE app_user AS target
SET email='khaled.sfaxi@deltacuisine.com'::citext
FROM mahdi_account
WHERE target.id=mahdi_account.id
  AND NOT EXISTS (
    SELECT 1
    FROM app_user AS existing
    WHERE existing.email='khaled.sfaxi@deltacuisine.com'::citext
  );

COMMIT;
