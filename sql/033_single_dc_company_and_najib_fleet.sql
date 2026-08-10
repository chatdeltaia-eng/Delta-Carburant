BEGIN;

-- Le nouveau referentiel appartient exclusivement a Delta Carburant (DC).
-- On conserve l'identifiant historique DELTA afin de ne casser aucune
-- affectation de carte, vehicule, beneficiaire ou transaction existante.
DO $$
DECLARE
  canonical_id uuid;
  conflicting_dc_id uuid;
BEGIN
  SELECT id INTO canonical_id FROM company WHERE code='DELTA' ORDER BY created_at LIMIT 1;
  IF canonical_id IS NULL THEN
    SELECT id INTO canonical_id FROM company WHERE code='DC' ORDER BY created_at LIMIT 1;
  END IF;
  IF canonical_id IS NULL THEN
    INSERT INTO company(code,name,active) VALUES('DC','Delta Carburant',true) RETURNING id INTO canonical_id;
  END IF;

  SELECT id INTO conflicting_dc_id FROM company WHERE code='DC' AND id<>canonical_id LIMIT 1;
  IF conflicting_dc_id IS NOT NULL THEN
    UPDATE company SET code='ARCHIVE_'||left(conflicting_dc_id::text,8),active=false,updated_at=now()
    WHERE id=conflicting_dc_id;
  END IF;

  UPDATE company SET code='DC',name='Delta Carburant',active=true,updated_at=now() WHERE id=canonical_id;
  UPDATE company SET active=false,updated_at=now() WHERE id<>canonical_id;

  UPDATE fuel_card SET company_id=canonical_id,updated_at=now()
  WHERE deleted_at IS NULL AND official_card_number BETWEEN '0001' AND '0041';
  UPDATE app_user SET company_id=canonical_id,updated_at=now()
  WHERE active AND role='NAJIB_ASSIGNER';
END $$;

DO $$
DECLARE wrong_cards integer; active_companies integer;
BEGIN
  SELECT count(*) INTO wrong_cards FROM fuel_card fc JOIN company c ON c.id=fc.company_id
  WHERE fc.deleted_at IS NULL AND fc.official_card_number BETWEEN '0001' AND '0041' AND c.code<>'DC';
  SELECT count(*) INTO active_companies FROM company WHERE active;
  IF wrong_cards<>0 THEN RAISE EXCEPTION '% carte(s) ne sont pas rattachees a DC',wrong_cards; END IF;
  IF active_companies<>1 THEN RAISE EXCEPTION 'Une seule societe doit rester active, obtenu: %',active_companies; END IF;
END $$;

COMMIT;
