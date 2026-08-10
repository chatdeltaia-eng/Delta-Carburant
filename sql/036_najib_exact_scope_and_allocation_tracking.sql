BEGIN;

ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS managed_by uuid REFERENCES app_user(id);
ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES driver(id);
ALTER TABLE transaction_allocation ADD COLUMN IF NOT EXISTS reported_mileage numeric(12,1);

DO $$
DECLARE
  najib_id uuid;
  dc_id uuid;
BEGIN
  SELECT id INTO najib_id FROM app_user
  WHERE role='NAJIB_ASSIGNER' AND active
  ORDER BY CASE WHEN lower(display_name) LIKE '%najib%' THEN 0 ELSE 1 END, created_at
  LIMIT 1;
  SELECT id INTO dc_id FROM company WHERE code='DC' AND active LIMIT 1;

  IF najib_id IS NULL THEN
    RAISE EXCEPTION 'Utilisateur Najib (NAJIB_ASSIGNER) introuvable';
  END IF;
  IF dc_id IS NULL THEN
    RAISE EXCEPTION 'Société DC introuvable';
  END IF;

  -- Najib suit uniquement les quatre cartes montrées par le métier.
  UPDATE fuel_card
  SET responsible_user_id=NULL,
      card_category='PERSONALIZED',
      updated_at=now()
  WHERE responsible_user_id=najib_id
    AND coalesce(official_card_number,regexp_replace(masked_card_number,'[^0-9]','','g'))
        NOT IN ('3506','3605','0502','502','2300');

  UPDATE fuel_card
  SET responsible_user_id=najib_id,
      company_id=dc_id,
      card_category='OFF_PARK',
      status=CASE WHEN status='SAFE' THEN 'ACTIVE'::card_status ELSE status END,
      updated_at=now()
  WHERE deleted_at IS NULL
    AND coalesce(official_card_number,regexp_replace(masked_card_number,'[^0-9]','','g'))
        IN ('3506','3605','0502','502','2300');

  -- Parc initial visible dans la capture. Les futurs véhicules créés par Najib
  -- recevront managed_by automatiquement via l'API.
  UPDATE vehicle SET managed_by=najib_id,company_id=dc_id,updated_at=now()
  WHERE deleted_at IS NULL
    AND regexp_replace(upper(registration_display),'[^A-Z0-9]','','g')
        IN ('9458TU240','596TU257','595TU257','9459TU240','7612TU243');
END $$;

CREATE INDEX IF NOT EXISTS idx_vehicle_managed_by ON vehicle(managed_by) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_allocation_driver ON transaction_allocation(driver_id);

COMMIT;
