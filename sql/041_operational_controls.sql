BEGIN;

CREATE TABLE IF NOT EXISTS transaction_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_transaction_id uuid NOT NULL REFERENCES fuel_transaction(id),
  author_id uuid NOT NULL REFERENCES app_user(id),
  observation text NOT NULL CHECK (length(trim(observation)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transaction_observation_transaction
  ON transaction_observation(fuel_transaction_id,created_at DESC);

ALTER TABLE fuel_price
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS source_url text;

UPDATE anomaly SET status='RESOLVED',resolution=coalesce(resolution,'Nettoyage avant nouveau suivi opérationnel'),
  resolved_at=coalesce(resolved_at,now()) WHERE status IN ('OPEN','IN_REVIEW');

COMMIT;
