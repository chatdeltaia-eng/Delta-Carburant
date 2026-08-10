BEGIN;

-- La colonne "en coffre" est un etat de distribution : Oui signifie que la
-- carte est physiquement au coffre et ne doit avoir aucune affectation active.
WITH safe_cards(payment_no) AS (VALUES
  ('002409'),('002003'),('001104'),('001005'),('000106'),
  ('003803'),('003407'),('001609'),('001302'),('004207')
)
UPDATE fuel_card fc SET status='SAFE',legacy_state=CASE
  WHEN nullif(fc.legacy_state,'') IS NULL THEN 'EN COFFRE'
  WHEN fc.legacy_state NOT ILIKE '%EN COFFRE%' THEN 'EN COFFRE | '||fc.legacy_state
  ELSE fc.legacy_state END,updated_at=now()
FROM safe_cards s
WHERE fc.deleted_at IS NULL AND fc.total_payment_number=s.payment_no;

WITH safe_cards(payment_no) AS (VALUES
  ('002409'),('002003'),('001104'),('001005'),('000106'),
  ('003803'),('003407'),('001609'),('001302'),('004207')
)
UPDATE card_assignment ca SET ends_at=greatest(now(),ca.starts_at)
FROM fuel_card fc JOIN safe_cards s ON s.payment_no=fc.total_payment_number
WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL;

-- Toutes les cartes indiquees "Non" sont disponibles. On retire une ancienne
-- mention coffre eventuelle sans effacer les autres observations.
WITH safe_cards(payment_no) AS (VALUES
  ('002409'),('002003'),('001104'),('001005'),('000106'),
  ('003803'),('003407'),('001609'),('001302'),('004207')
)
UPDATE fuel_card fc SET status='ACTIVE',
  legacy_state=nullif(trim(both ' |' from replace(coalesce(fc.legacy_state,''),'EN COFFRE','')),''),
  updated_at=now()
WHERE fc.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM fuel_card all_cards
    WHERE all_cards.id=fc.id AND all_cards.official_card_number BETWEEN '0001' AND '0041')
  AND NOT EXISTS (SELECT 1 FROM safe_cards s WHERE s.payment_no=fc.total_payment_number);

DO $$
DECLARE safe_count integer; distributed_safe_count integer;
BEGIN
  SELECT count(*) INTO safe_count FROM fuel_card
  WHERE deleted_at IS NULL AND status='SAFE';
  SELECT count(*) INTO distributed_safe_count
  FROM fuel_card fc JOIN card_assignment ca ON ca.fuel_card_id=fc.id
  WHERE fc.deleted_at IS NULL AND fc.status='SAFE' AND ca.ends_at IS NULL;
  IF safe_count<>10 THEN
    RAISE EXCEPTION 'Le referentiel doit contenir exactement 10 cartes en coffre, obtenu: %',safe_count;
  END IF;
  IF distributed_safe_count<>0 THEN
    RAISE EXCEPTION 'Une carte en coffre ne peut pas etre distribuee';
  END IF;
END $$;

COMMIT;
