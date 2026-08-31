BEGIN;

-- Valeur contrôlée dans Mobility Business le 31/08/2026 :
-- carte 0033, moyen de paiement 0033 0 8, MED NAJIB MAHFOUTH,
-- Produit de la carte -> Limite de 450 TND -> Par Mois.
WITH corrected AS (
  UPDATE fuel_card fc
  SET monthly_limit=450,updated_at=now()
  FROM company c
  WHERE fc.company_id=c.id AND c.code='DC' AND fc.deleted_at IS NULL
    AND regexp_replace(coalesce(fc.official_card_number,fc.masked_card_number),'[^0-9]','','g')='0033'
    AND right(regexp_replace(coalesce(fc.total_payment_number,''),'[^0-9]','','g'),4)='0308'
  RETURNING fc.id,fc.company_id,fc.holder_name
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:verified-total-correction','CORRECT_TOTAL_CARD_LIMIT','fuel_card',id::text,
  jsonb_build_object('companyId',company_id,'cardNumber','0033','paymentLast4','0308',
    'holder',holder_name,'monthlyLimit',450,'source','Mobility Business card product restriction')
FROM corrected;

COMMIT;
