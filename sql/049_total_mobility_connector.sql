CREATE TABLE IF NOT EXISTS total_mobility_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  customer_number text NOT NULL,
  site_number text NOT NULL,
  user_id text,
  username text,
  refresh_token_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sync_interval_minutes integer NOT NULL DEFAULT 60 CHECK(sync_interval_minutes BETWEEN 15 AND 1440),
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  connected_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_total_mobility_single_connection
  ON total_mobility_connection((true));

CREATE TABLE IF NOT EXISTS total_mobility_sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES total_mobility_connection(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','SKIPPED')),
  fetched_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  review_rows integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_total_mobility_sync_run_date
  ON total_mobility_sync_run(started_at DESC);

INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
VALUES('migration-049','ENABLE_TOTAL_MOBILITY_CONNECTOR','system','TOTAL_MOBILITY',
  '{"authentication":"Cognito refresh token encrypted","intervalMinutes":60,"passwordStored":false}'::jsonb);
