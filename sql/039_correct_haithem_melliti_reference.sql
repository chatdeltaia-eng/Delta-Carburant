BEGIN;

-- Correction orthographique du bénéficiaire de la carte 0304. Le véhicule de
-- référence reste actif et son historique (transactions/audit) est conservé.
DO $$
DECLARE
  dc_id uuid;
  v_vehicle_id uuid;
  v_beneficiary_id uuid;
  department_id uuid;
BEGIN
  SELECT id INTO dc_id FROM company WHERE code='DC' AND active LIMIT 1;
  IF dc_id IS NULL THEN RAISE EXCEPTION 'Société DC introuvable'; END IF;

  INSERT INTO department(company_id,name) VALUES(dc_id,'Cartes Total')
    ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name
    RETURNING id INTO department_id;

  INSERT INTO beneficiary(company_id,department_id,display_name)
    VALUES(dc_id,department_id,'HAITHEM MELLITI')
    ON CONFLICT(company_id,display_name) DO UPDATE SET active=true
    RETURNING id INTO v_beneficiary_id;

  SELECT id INTO v_vehicle_id FROM vehicle
  WHERE company_id=dc_id AND source_card_number='304'
  ORDER BY updated_at DESC LIMIT 1;
  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'Véhicule de la carte 304 introuvable';
  END IF;

  UPDATE vehicle SET driver_name='HAITHEM MELLITI',reference_beneficiary_id=v_beneficiary_id,
    active=true,deleted_at=NULL,deleted_by=NULL,updated_at=now()
  WHERE id=v_vehicle_id;

  UPDATE fuel_card SET holder_name='HAITHEM MELLITI',reference_vehicle_id=v_vehicle_id,
    company_id=dc_id,updated_at=now()
  WHERE deleted_at IS NULL AND
    coalesce(nullif(ltrim(regexp_replace(coalesce(total_payment_number,masked_card_number),'[^0-9]','','g'),'0'),''),'0')='304';

  UPDATE card_assignment ca
  SET beneficiary_id=v_beneficiary_id,vehicle_id=v_vehicle_id
  WHERE fuel_card_id IN (
    SELECT fc.id FROM fuel_card fc
    WHERE fc.deleted_at IS NULL AND fc.reference_vehicle_id=v_vehicle_id
  ) AND ends_at IS NULL;

  UPDATE beneficiary SET active=false
  WHERE company_id=dc_id AND upper(display_name) IN ('HAITHEM MILITI','HAITEM MILITI')
    AND id<>v_beneficiary_id;

  INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
  VALUES('migration-039','RESTORE_AND_CORRECT','vehicle',v_vehicle_id,
    jsonb_build_object('beneficiary','HAITHEM MELLITI','card','304'));
END $$;

COMMIT;
