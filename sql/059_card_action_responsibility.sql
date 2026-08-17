BEGIN;

CREATE TABLE IF NOT EXISTS card_action_responsibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuel_card_id uuid NOT NULL REFERENCES fuel_card(id),
  action_type text NOT NULL,
  responsible_user_id uuid NOT NULL REFERENCES app_user(id),
  performed_by uuid NOT NULL REFERENCES app_user(id),
  observation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_action_type_not_empty CHECK (btrim(action_type) <> '')
);

CREATE INDEX IF NOT EXISTS idx_card_action_responsibility_card
  ON card_action_responsibility(fuel_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_action_responsibility_responsible
  ON card_action_responsibility(responsible_user_id, created_at DESC);

ALTER TABLE card_request ADD COLUMN IF NOT EXISTS responsible_user_id uuid REFERENCES app_user(id);
CREATE INDEX IF NOT EXISTS idx_card_request_responsible ON card_request(responsible_user_id,created_at DESC);

-- Mahdi cumule les droits opérationnels de Zin et de la Direction grâce au
-- rôle SUPER_ADMIN. Aymen et Mouine sont disponibles comme responsables des
-- restitutions, alimentations et autres opérations sur les cartes.
INSERT INTO app_user(email,display_name,password_hash,role,active)
VALUES
 ('mehdi@deltacarburant.com','Mahdi',(SELECT password_hash FROM app_user WHERE email='superadmin@deltacarburant.com'),'SUPER_ADMIN',true),
 ('aymen@deltacarburant.com','Aymen',(SELECT password_hash FROM app_user WHERE email='najib@deltacarburant.com'),'NAJIB_ASSIGNER',true),
 ('mouine@deltacarburant.com','Mouine',(SELECT password_hash FROM app_user WHERE email='najib@deltacarburant.com'),'NAJIB_ASSIGNER',true)
ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,active=true;

COMMIT;
