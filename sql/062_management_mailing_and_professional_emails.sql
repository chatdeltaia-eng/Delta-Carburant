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
UPDATE app_user SET email='khaled.sfaxi@deltacuisine.com'::citext
WHERE lower(display_name) IN ('mahdi','mahdi bi','super admin')
  AND NOT EXISTS (SELECT 1 FROM app_user WHERE email='khaled.sfaxi@deltacuisine.com'::citext);

COMMIT;
