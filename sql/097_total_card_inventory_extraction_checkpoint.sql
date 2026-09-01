CREATE TABLE IF NOT EXISTS total_card_inventory_extraction_checkpoint (
  client_name text NOT NULL,
  card_number text NOT NULL,
  payment_method_number text NOT NULL DEFAULT '',
  card_data jsonb NOT NULL,
  expected_total integer NOT NULL CHECK (expected_total > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(client_name, card_number, payment_method_number)
);

CREATE INDEX IF NOT EXISTS idx_total_card_inventory_checkpoint_client
  ON total_card_inventory_extraction_checkpoint(client_name, updated_at);
