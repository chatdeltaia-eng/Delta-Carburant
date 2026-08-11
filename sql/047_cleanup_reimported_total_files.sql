BEGIN;

-- Nettoie les lignes créées lorsque exactement le même export Total a été
-- importé plusieurs fois avant la correction de l'horodatage. Le couple
-- fichier + numéro de ligne est uniquement utilisé ici pour réparer
-- l'historique; les nouveaux imports utilisent l'identité métier complète.
CREATE TEMP TABLE repeated_file_transactions ON COMMIT DROP AS
SELECT id
FROM (
  SELECT ft.id,
    row_number() OVER (
      PARTITION BY tib.source_filename,ft.source_row_number,ft.fuel_card_id,
        upper(trim(coalesce(ft.station,''))),upper(trim(coalesce(ft.product,''))),
        ft.quantity_liters,ft.amount_incl_tax
      ORDER BY tib.imported_at,ft.created_at,ft.id
    ) AS duplicate_rank
  FROM fuel_transaction ft
  JOIN transaction_import_batch tib ON tib.id=ft.import_batch_id
  WHERE ft.deleted_at IS NULL AND ft.source='TOTAL_EXCEL' AND ft.source_row_number IS NOT NULL
) ranked
WHERE duplicate_rank>1;

UPDATE fuel_transaction ft SET deleted_at=now()
FROM repeated_file_transactions duplicate
WHERE ft.id=duplicate.id;

UPDATE anomaly a
SET status='DISMISSED',resolved_at=coalesce(a.resolved_at,now()),
  resolution=coalesce(a.resolution,'Doublon issu du réimport du même fichier Total')
FROM repeated_file_transactions duplicate
WHERE a.fuel_transaction_id=duplicate.id AND a.status IN ('OPEN','IN_REVIEW');

COMMIT;
