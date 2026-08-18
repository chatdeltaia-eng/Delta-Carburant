-- Total can reuse the same short card/payment number for different clients.
-- The business key is therefore the company plus the official card number,
-- not the official card number globally.
DROP INDEX IF EXISTS uq_fuel_card_official_number;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_card_company_official_number
  ON fuel_card(company_id, official_card_number)
  WHERE official_card_number IS NOT NULL AND deleted_at IS NULL;
