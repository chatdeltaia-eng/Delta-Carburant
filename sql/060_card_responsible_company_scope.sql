BEGIN;
INSERT INTO anomaly(fuel_card_id,anomaly_type,severity,status,description,assigned_to,metadata)
SELECT fc.id,'CARD_RESPONSIBLE_COMPANY_MISMATCH','HIGH','OPEN',u.display_name||' ne peut pas être responsable de la carte '||fc.masked_card_number||' de la société '||c.code,
 (SELECT id FROM app_user WHERE active AND role='ZIN_FINANCE' ORDER BY created_at LIMIT 1),jsonb_build_object('responsibleUserId',u.id,'responsibleName',u.display_name,'company',c.code)
FROM fuel_card fc JOIN company c ON c.id=fc.company_id JOIN app_user u ON u.id=fc.responsible_user_id
WHERE fc.deleted_at IS NULL AND fc.card_category='OFF_PARK' AND ((lower(u.display_name)='aymen' AND c.code<>'TCM') OR (lower(u.display_name)='mouine' AND c.code<>'DC') OR (lower(u.display_name)='najib' AND c.code NOT IN('DC','DCD')))
AND NOT EXISTS(SELECT 1 FROM anomaly a WHERE a.fuel_card_id=fc.id AND a.anomaly_type='CARD_RESPONSIBLE_COMPANY_MISMATCH' AND a.status IN('OPEN','IN_REVIEW'));
COMMIT;
