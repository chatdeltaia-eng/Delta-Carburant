BEGIN;

-- Correction de la clé de rapprochement : 0033 0 8 devient 003308 et ses
-- quatre derniers chiffres sont 3308 (pas 0308).
WITH corrected AS (
  UPDATE fuel_card fc
  SET monthly_limit=450,updated_at=now()
  FROM company c
  WHERE fc.company_id=c.id AND c.code='DC' AND fc.deleted_at IS NULL
    AND regexp_replace(coalesce(fc.official_card_number,fc.masked_card_number),'[^0-9]','','g')='0033'
  RETURNING fc.id,fc.company_id,fc.holder_name,fc.total_payment_number
)
INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
SELECT 'system:verified-total-correction','CORRECT_TOTAL_CARD_LIMIT','fuel_card',id::text,
  jsonb_build_object('companyId',company_id,'cardNumber','0033','paymentLast4','3308',
    'paymentNumber',total_payment_number,'holder',holder_name,'monthlyLimit',450,
    'source','Mobility Business card product restriction')
FROM corrected;

COMMIT;
