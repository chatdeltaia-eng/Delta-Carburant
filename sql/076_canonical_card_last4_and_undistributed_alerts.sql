BEGIN;

-- Le numéro fonctionnel unique affiché et utilisé pour le rapprochement est
-- toujours le suffixe à quatre chiffres du moyen de paiement Total.
DROP INDEX IF EXISTS uq_fuel_card_total_payment_number;
UPDATE fuel_card SET
  total_payment_number=right(regexp_replace(total_payment_number,'[^0-9]','','g'),4),
  updated_at=now()
WHERE total_payment_number IS NOT NULL
  AND length(regexp_replace(total_payment_number,'[^0-9]','','g'))>=4
  AND total_payment_number<>right(regexp_replace(total_payment_number,'[^0-9]','','g'),4);

CREATE INDEX IF NOT EXISTS idx_fuel_card_company_payment_last4
  ON fuel_card(company_id,total_payment_number) WHERE total_payment_number IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS undistributed_card_consumption_alert (
  fuel_transaction_id uuid PRIMARY KEY REFERENCES fuel_transaction(id) ON DELETE CASCADE,
  recipients text[] NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
