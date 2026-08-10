BEGIN;

DO $$
DECLARE
  najib_id uuid;
  dc_id uuid;
BEGIN
  SELECT id INTO najib_id
  FROM app_user
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

  -- Le numéro officiel est stocké avec des zéros initiaux (ex. 003506).
  -- Comparer sa valeur numérique normalisée évite de vider le périmètre Najib.
  UPDATE fuel_card
  SET responsible_user_id=NULL,
      card_category='PERSONALIZED',
      updated_at=now()
  WHERE responsible_user_id=najib_id
    AND coalesce(
      nullif(ltrim(regexp_replace(coalesce(official_card_number,''),'[^0-9]','','g'),'0'),''),
      nullif(ltrim(regexp_replace(coalesce(masked_card_number,''),'[^0-9]','','g'),'0'),''),
      '0'
    ) NOT IN ('3506','3605','502','2300','3209','1401','2706','2201','2607');

  -- Quatre cartes Najib + cinq cartes poseurs distribuées par Najib.
  -- Elles constituent son unique périmètre de suivi et de répartition.
  UPDATE fuel_card
  SET responsible_user_id=najib_id,
      company_id=dc_id,
      card_category='OFF_PARK',
      status=CASE WHEN status='SAFE' THEN 'ACTIVE'::card_status ELSE status END,
      updated_at=now()
  WHERE deleted_at IS NULL
    AND coalesce(
      nullif(ltrim(regexp_replace(coalesce(official_card_number,''),'[^0-9]','','g'),'0'),''),
      nullif(ltrim(regexp_replace(coalesce(masked_card_number,''),'[^0-9]','','g'),'0'),''),
      '0'
    ) IN ('3506','3605','502','2300','3209','1401','2706','2201','2607');

  -- Les véhicules associés aux cinq cartes poseurs font partie du parc que
  -- Najib peut utiliser lors de la répartition des transactions.
  UPDATE vehicle
  SET managed_by=najib_id, updated_at=now()
  WHERE deleted_at IS NULL
    AND company_id=dc_id
    AND regexp_replace(upper(registration_display),'[^A-Z0-9]','','g')
      IN ('9458TU240','596TU257','595TU257','9459TU240','7612TU243');
END $$;

COMMIT;
