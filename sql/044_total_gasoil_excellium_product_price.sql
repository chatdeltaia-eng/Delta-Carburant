BEGIN;

-- « GO SS EXC » = Gasoil Sans Soufre Excellium dans les exports Total.
-- Tarif fournisseur constaté sur l'export Total du 11/08/2026 :
-- 30,000 TND / 11,760 L = 2,551 TND/L.
INSERT INTO fuel_price (
  company_id, product, old_price, new_price, variation_percent,
  effective_date, source, source_url
)
SELECT c.id, 'GASOIL PREMIUM / POWER', 2.551, 2.551, 0,
  DATE '2026-08-11', 'TOTAL_SUPPLIER',
  'https://services.totalenergies.tn/ma-station-service/nos-carburants/excellium'
FROM company c
WHERE c.code = 'DC' AND c.active
  AND NOT EXISTS (
    SELECT 1 FROM fuel_price fp
    WHERE fp.company_id = c.id
      AND upper(fp.product) = 'GASOIL PREMIUM / POWER'
      AND fp.effective_date = DATE '2026-08-11'
  );

WITH applicable AS (
  SELECT ft.id, fp.new_price
  FROM fuel_transaction ft
  JOIN fuel_card fc ON fc.id = ft.fuel_card_id
  JOIN LATERAL (
    SELECT p.new_price
    FROM fuel_price p
    WHERE p.company_id = fc.company_id
      AND upper(p.product) = 'GASOIL PREMIUM / POWER'
    ORDER BY
      (p.effective_date <= ft.transaction_date::date) DESC,
      CASE WHEN p.effective_date <= ft.transaction_date::date THEN p.effective_date END DESC,
      CASE WHEN p.effective_date > ft.transaction_date::date THEN p.effective_date END ASC,
      p.created_at DESC
    LIMIT 1
  ) fp ON true
  WHERE ft.deleted_at IS NULL
    AND regexp_replace(upper(coalesce(ft.product, '')), '[^A-Z0-9]', '', 'g')
      IN ('GOSSEXC', 'GASOILSSEXC', 'GASOIL50EXC', 'GASOILEXC', 'GASSEXC', 'GASEXC', 'GASOILPOWER')
), calculated AS (
  SELECT ft.id, a.new_price,
    round(ft.quantity_liters * a.new_price, 3) AS expected,
    round(ft.amount_incl_tax - round(ft.quantity_liters * a.new_price, 3), 3) AS difference
  FROM fuel_transaction ft
  JOIN applicable a ON a.id = ft.id
)
UPDATE fuel_transaction ft
SET unit_price = c.new_price,
    expected_amount = c.expected,
    billing_difference = c.difference,
    validation_status = CASE
      WHEN abs(c.difference) <= greatest(0.05, c.expected * 0.005)
        THEN 'BILLING_OK'
      ELSE 'BILLING_MISMATCH'
    END,
    billing_checked_at = now()
FROM calculated c
WHERE ft.id = c.id;

COMMIT;
