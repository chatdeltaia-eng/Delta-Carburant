BEGIN;

ALTER TABLE transaction_review
  DROP CONSTRAINT IF EXISTS transaction_review_issue_type_check;
ALTER TABLE transaction_review
  ADD CONSTRAINT transaction_review_issue_type_check
  CHECK (issue_type IN (
    'UNKNOWN_CARD','UNAVAILABLE_CARD','UNKNOWN_VEHICLE','UNAVAILABLE_VEHICLE','MISSING_BENEFICIARY'
  ));

-- Une alerte plafond n'est vraie qu'au-delà de 100 %. Les anciennes alertes
-- devenues fausses après correction d'un plafond sont fermées immédiatement.
WITH current_usage AS (
  SELECT a.id,fc.monthly_limit,
    coalesce(sum(ft.amount_incl_tax) FILTER (
      WHERE ft.deleted_at IS NULL
        AND ft.transaction_date>=date_trunc('month',a.created_at)
        AND ft.transaction_date<date_trunc('month',a.created_at)+interval '1 month'
    ),0) AS consumed
  FROM anomaly a
  JOIN fuel_card fc ON fc.id=a.fuel_card_id
  LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id
  WHERE a.anomaly_type='MONTHLY_LIMIT_EXCEEDED'
    AND a.status IN ('OPEN','IN_REVIEW')
  GROUP BY a.id,fc.monthly_limit
)
UPDATE anomaly a
SET status='RESOLVED',resolved_at=now(),
  resolution='Correction automatique : consommation inférieure ou égale à 100 % du plafond'
FROM current_usage u
WHERE a.id=u.id AND (u.monthly_limit<=0 OR u.consumed<=u.monthly_limit);

COMMIT;
