BEGIN;

ALTER TABLE card_return_receipt
  ADD COLUMN IF NOT EXISTS monthly_limit numeric(14,3),
  ADD COLUMN IF NOT EXISTS consumed_amount numeric(14,3),
  ADD COLUMN IF NOT EXISTS consumed_liters numeric(14,3),
  ADD COLUMN IF NOT EXISTS transaction_count integer;

UPDATE card_return_receipt rr SET
  monthly_limit=coalesce(rr.monthly_limit,(SELECT fc.monthly_limit FROM fuel_card fc WHERE fc.id=rr.fuel_card_id)),
  consumed_amount=coalesce(rr.consumed_amount,(SELECT sum(ft.amount_incl_tax) FROM fuel_transaction ft WHERE ft.fuel_card_id=rr.fuel_card_id AND ft.deleted_at IS NULL AND ft.transaction_date>=rr.consumption_month AND ft.transaction_date<rr.consumption_month+interval '1 month'),0),
  consumed_liters=coalesce(rr.consumed_liters,(SELECT sum(ft.quantity_liters) FROM fuel_transaction ft WHERE ft.fuel_card_id=rr.fuel_card_id AND ft.deleted_at IS NULL AND ft.transaction_date>=rr.consumption_month AND ft.transaction_date<rr.consumption_month+interval '1 month'),0),
  transaction_count=coalesce(rr.transaction_count,(SELECT count(*)::int FROM fuel_transaction ft WHERE ft.fuel_card_id=rr.fuel_card_id AND ft.deleted_at IS NULL AND ft.transaction_date>=rr.consumption_month AND ft.transaction_date<rr.consumption_month+interval '1 month'),0);

COMMIT;
