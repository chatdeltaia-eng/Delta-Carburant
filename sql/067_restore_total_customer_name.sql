BEGIN;

-- The live driver sync previously copied the local company code (DC) into
-- customer_name. Total's customer selector expects its commercial name.
UPDATE driver
SET customer_name='DELTA CUISINE',updated_at=now()
WHERE deleted_at IS NULL
  AND regexp_replace(coalesce(customer_number,''),'[^0-9]','','g')='10391'
  AND customer_name IS DISTINCT FROM 'DELTA CUISINE';

COMMIT;
