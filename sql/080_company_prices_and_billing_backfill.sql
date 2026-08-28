BEGIN;

-- Delta Cuisine possédait déjà l'historique de référence. Le rendre disponible
-- pour chaque société active afin que DCD, IKIT et TCM aient le même contrôle.
INSERT INTO fuel_price(company_id,product,old_price,new_price,variation_percent,
  effective_date,created_by,created_at,source,source_url)
SELECT target.id,source.product,source.old_price,source.new_price,source.variation_percent,
  source.effective_date,source.created_by,source.created_at,source.source,source.source_url
FROM company target
JOIN company dc ON dc.code='DC'
JOIN fuel_price source ON source.company_id=dc.id
WHERE target.active
  AND NOT EXISTS (
    SELECT 1 FROM fuel_price existing
    WHERE existing.company_id=target.id
      AND upper(existing.product)=upper(source.product)
      AND existing.effective_date=source.effective_date
  );

-- Recalculer le prix appliqué et la conformité de toutes les transactions,
-- société par société, y compris celles déjà importées avant ce correctif.
WITH priced AS (
  SELECT ft.id,ft.quantity_liters,ft.amount_incl_tax,price.new_price
  FROM fuel_transaction ft
  JOIN fuel_card fc ON fc.id=ft.fuel_card_id
  LEFT JOIN LATERAL (
    SELECT fp.new_price FROM fuel_price fp
    WHERE fp.company_id=fc.company_id AND upper(fp.product)=CASE
      WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOIL','GO','DIESEL') THEN 'GASOIL ORDINAIRE'
      WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOILSS','GASOIL50','GOSSO') THEN 'GASOIL SANS SOUFRE (GASOIL 50)'
      WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SUPERSP','SSP','ESSENCE','ESSENCESANSPLOMB') THEN 'ESSENCE SANS PLOMB'
      WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASEXC','GASSEXC','GASOILEXC','GOSSEXC','GASOILSSEXC','GASOIL50EXC','GASOILPOWER') THEN 'GASOIL PREMIUM / POWER'
      WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SSPEXC','SUPERSPEXC','SUPEREXC','ESSENCEEXC','ESSENCEPOWER') THEN 'ESSENCE PREMIUM / POWER'
      ELSE upper(trim(coalesce(ft.product,''))) END
    ORDER BY (fp.effective_date<=ft.transaction_date::date) DESC,
      CASE WHEN fp.effective_date<=ft.transaction_date::date THEN fp.effective_date END DESC,
      CASE WHEN fp.effective_date>ft.transaction_date::date THEN fp.effective_date END ASC,
      fp.created_at DESC LIMIT 1
  ) price ON true
  WHERE ft.deleted_at IS NULL
), calculated AS (
  SELECT id,new_price,round(quantity_liters*new_price,3) expected,
    round(amount_incl_tax-round(quantity_liters*new_price,3),3) difference
  FROM priced WHERE new_price IS NOT NULL
)
UPDATE fuel_transaction ft SET unit_price=c.new_price,expected_amount=c.expected,
  billing_difference=c.difference,validation_status=CASE
    WHEN abs(c.difference)<=greatest(.05,c.expected*.005) THEN 'BILLING_OK'
    ELSE 'BILLING_MISMATCH' END,billing_checked_at=now()
FROM calculated c WHERE ft.id=c.id;

UPDATE fuel_transaction ft SET unit_price=null,expected_amount=null,billing_difference=null,
  validation_status='PRICE_UNAVAILABLE',billing_checked_at=now()
WHERE ft.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM fuel_price fp JOIN fuel_card fc ON fc.id=ft.fuel_card_id
  WHERE fp.company_id=fc.company_id AND upper(fp.product)=CASE
    WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOIL','GO','DIESEL') THEN 'GASOIL ORDINAIRE'
    WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOILSS','GASOIL50','GOSSO') THEN 'GASOIL SANS SOUFRE (GASOIL 50)'
    WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SUPERSP','SSP','ESSENCE','ESSENCESANSPLOMB') THEN 'ESSENCE SANS PLOMB'
    WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASEXC','GASSEXC','GASOILEXC','GOSSEXC','GASOILSSEXC','GASOIL50EXC','GASOILPOWER') THEN 'GASOIL PREMIUM / POWER'
    WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SSPEXC','SUPERSPEXC','SUPEREXC','ESSENCEEXC','ESSENCEPOWER') THEN 'ESSENCE PREMIUM / POWER'
    ELSE upper(trim(coalesce(ft.product,''))) END
);

COMMIT;
