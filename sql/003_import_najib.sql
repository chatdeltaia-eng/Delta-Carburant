\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE najib_stage (
  source_row_number integer,
  company_raw text,
  card_number_raw text,
  pin_raw text,
  vehicle_raw text,
  brand_raw text,
  registration_raw text,
  monthly_limit_raw text,
  state_raw text,
  beneficiary_raw text,
  department_raw text,
  threshold_alert_raw text
) ON COMMIT DROP;

COPY najib_stage FROM STDIN WITH (FORMAT csv, HEADER false, DELIMITER E'\t', NULL '\N');
-- Le flux de données et la ligne « \. » sont injectés ici par le script d'import.

