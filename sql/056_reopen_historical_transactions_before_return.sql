BEGIN;

-- Une carte restituée est aujourd'hui SAFE, mais ses opérations Total faites
-- avant la restitution restent valides. Fermer les faux contrôles créés avec
-- l'ancien test basé uniquement sur l'état courant. Le prochain instantané
-- Total pourra alors réimporter ces lignes normalement.
UPDATE transaction_review tr
SET status='REJECTED',
    decided_at=now(),
    decision_reason='Faux positif corrigé : transaction antérieure à la restitution de la carte'
FROM fuel_card fc
JOIN card_return_receipt rr ON rr.fuel_card_id=fc.id
WHERE tr.status='PENDING'
  AND tr.issue_type='UNAVAILABLE_CARD'
  AND tr.transaction_date<=rr.returned_at
  AND (
    regexp_replace(tr.card_number,'[^0-9]','','g')=fc.total_payment_number
    OR (length(regexp_replace(tr.card_number,'[^0-9]','','g'))>6
      AND right(regexp_replace(tr.card_number,'[^0-9]','','g'),6)=fc.total_payment_number)
    OR regexp_replace(tr.card_number,'[^0-9]','','g')=regexp_replace(fc.masked_card_number,'[^0-9]','','g')
    OR regexp_replace(tr.card_number,'[^0-9]','','g')=fc.official_card_number
  );

COMMIT;
