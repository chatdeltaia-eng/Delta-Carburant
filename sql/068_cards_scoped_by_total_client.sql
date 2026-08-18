BEGIN;

-- Les numéros courts affichés par Total (0001, 0004, ...) sont uniques dans
-- un client, pas dans tout le compte Mobility Business.
ALTER TABLE fuel_card DROP CONSTRAINT IF EXISTS fuel_card_card_number_hmac_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_card_company_card_hmac
  ON fuel_card(company_id,card_number_hmac);

INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
VALUES('migration-068','SCOPE_TOTAL_CARDS_BY_COMPANY','system','TOTAL_MOBILITY_CARDS',
  '{"reason":"same short Total card number may exist for multiple clients"}'::jsonb);

COMMIT;
