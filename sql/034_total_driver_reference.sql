BEGIN;

ALTER TABLE driver ADD COLUMN IF NOT EXISTS customer_number text;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS driver_number text;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS driver_code text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_company_driver_number
  ON driver(company_id, driver_number)
  WHERE deleted_at IS NULL AND driver_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_company_driver_code
  ON driver(company_id, driver_code)
  WHERE deleted_at IS NULL AND driver_code IS NOT NULL;

WITH dc AS (
  SELECT id FROM company WHERE code = 'DC' LIMIT 1
), source(customer_number,customer_name,driver_number,first_name,last_name,driver_code) AS (
  VALUES
    ('10391','DELTA CUISINE','0001','Jawher','Denguir','0740'),
    ('10391','DELTA CUISINE','0002','Ayoub','FAKER','2002'),
    ('10391','DELTA CUISINE','0003','Najib','MAHFOUDH','3077'),
    ('10391','DELTA CUISINE','0004','Mahrez','ZAKRAOUI','7194')
)
INSERT INTO driver(
  company_id,full_name,customer_number,customer_name,driver_number,
  first_name,last_name,driver_code,active
)
SELECT dc.id, concat_ws(' ',source.first_name,source.last_name),
  source.customer_number,source.customer_name,source.driver_number,
  source.first_name,source.last_name,source.driver_code,true
FROM dc CROSS JOIN source
ON CONFLICT (company_id,full_name) DO UPDATE SET
  customer_number=excluded.customer_number,
  customer_name=excluded.customer_name,
  driver_number=excluded.driver_number,
  first_name=excluded.first_name,
  last_name=excluded.last_name,
  driver_code=excluded.driver_code,
  active=true,
  deleted_at=NULL,
  updated_at=now();

COMMIT;
