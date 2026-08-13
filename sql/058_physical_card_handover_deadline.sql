BEGIN;

-- La double approbation autorise la restitution, mais ne prouve pas encore
-- que Najib a physiquement remis la carte. Il dispose de 90 minutes pour la
-- signer. Passé ce délai la carte reste/revient sous sa responsabilité, sans
-- modification du plafond ni de la consommation du mois.
ALTER TABLE card_request
  ADD COLUMN IF NOT EXISTS handover_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS handover_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS handover_signed_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS handover_expired_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_card_request_handover_deadline
  ON card_request(handover_deadline)
  WHERE handover_deadline IS NOT NULL AND handover_signed_at IS NULL AND handover_expired_at IS NULL;

COMMIT;
