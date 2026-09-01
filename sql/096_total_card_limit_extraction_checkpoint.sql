CREATE TABLE IF NOT EXISTS total_card_limit_extraction_checkpoint (
  checkpoint_key text PRIMARY KEY,
  client_name text NOT NULL,
  card_number text NOT NULL,
  payment_method_number text NOT NULL DEFAULT '',
  holder_key text NOT NULL DEFAULT '',
  amount numeric(14,3) NOT NULL CHECK (amount >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_total_card_limit_checkpoint_client
  ON total_card_limit_extraction_checkpoint(client_name, updated_at);
