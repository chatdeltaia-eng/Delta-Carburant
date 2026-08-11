BEGIN;

-- Une opération Total est identifiée d'abord par la carte et l'horodatage
-- exact. Le code d'autorisation distingue deux mouvements réellement séparés
-- à la même seconde. S'il est absent, les caractéristiques financières et le
-- point de vente constituent la clé de secours.
CREATE TEMP TABLE duplicate_total_transactions ON COMMIT DROP AS
SELECT id
FROM (
  SELECT ft.id,
    row_number() OVER (
      PARTITION BY ft.fuel_card_id,ft.transaction_date,
        coalesce(
          nullif(upper(trim(ft.authorization_code)),''),
          md5(upper(trim(coalesce(ft.station,''))) || '|' ||
            upper(trim(coalesce(ft.product,''))) || '|' ||
            ft.quantity_liters::text || '|' || ft.amount_incl_tax::text || '|' ||
            coalesce(ft.vehicle_id::text,''))
        )
      ORDER BY ft.created_at,ft.id
    ) AS duplicate_rank
  FROM fuel_transaction ft
  WHERE ft.deleted_at IS NULL AND ft.source='TOTAL_EXCEL'
) ranked
WHERE duplicate_rank>1;

UPDATE fuel_transaction ft
SET deleted_at=now()
FROM duplicate_total_transactions duplicate
WHERE ft.id=duplicate.id;

UPDATE anomaly a
SET status='DISMISSED',resolved_at=coalesce(a.resolved_at,now()),
  resolution=coalesce(a.resolution,'Transaction Total dupliquée lors d’un réimport')
FROM duplicate_total_transactions duplicate
WHERE a.fuel_transaction_id=duplicate.id AND a.status IN ('OPEN','IN_REVIEW');

-- La contrainte rend le doublonnage impossible en base, y compris si deux
-- imports sont lancés simultanément.
CREATE UNIQUE INDEX IF NOT EXISTS uq_total_transaction_business_identity
ON fuel_transaction (
  fuel_card_id,
  transaction_date,
  coalesce(
    nullif(upper(trim(authorization_code)),''),
    md5(upper(trim(coalesce(station,''))) || '|' ||
      upper(trim(coalesce(product,''))) || '|' ||
      quantity_liters::text || '|' || amount_incl_tax::text || '|' ||
      coalesce(vehicle_id::text,''))
  )
)
WHERE deleted_at IS NULL AND source='TOTAL_EXCEL';

COMMIT;
