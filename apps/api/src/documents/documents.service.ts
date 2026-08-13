import { BadRequestException,Injectable,NotFoundException } from '@nestjs/common';import { DatabaseService } from '../database/database.service';
type Actor={sub:string;email:string;role:string};
@Injectable() export class DocumentsService {constructor(private readonly db:DatabaseService){}
 async statement(period:'WEEK'|'MONTH',start:string|undefined,actor:Actor){const anchor=start&&/^\d{4}-\d{2}-\d{2}$/.test(start)?start:new Date().toISOString().slice(0,10);const trunc=period==='WEEK'?'week':'month';
  const rows=await this.db.query(`SELECT ft.id,ft.transaction_date AS date,fc.masked_card_number AS card,coalesce(b.display_name,fc.holder_name,'—') AS beneficiary,coalesce(v.registration_display,'—') AS vehicle,ft.station,ft.product,ft.quantity_liters::float AS liters,ft.amount_incl_tax::float AS amount,ft.validation_status AS "billingStatus"
   FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id
   WHERE ft.deleted_at IS NULL AND ft.transaction_date>=date_trunc($1,$2::date) AND ft.transaction_date<date_trunc($1,$2::date)+CASE WHEN $1='week' THEN interval '1 week' ELSE interval '1 month' END
   AND ($3<>'NAJIB_ASSIGNER' OR fc.responsible_user_id=$4) ORDER BY ft.transaction_date,fc.masked_card_number`,[trunc,anchor,actor.role,actor.sub]);
  const [bounds]=await this.db.query(`SELECT date_trunc($1,$2::date)::date AS "startDate",(date_trunc($1,$2::date)+CASE WHEN $1='week' THEN interval '1 week' ELSE interval '1 month' END-interval '1 day')::date AS "endDate"`,[trunc,anchor]);
  return {documentNumber:`FAC-${period}-${String(bounds.startDate).slice(0,10).replace(/-/g,'')}`,period,startDate:bounds.startDate,endDate:bounds.endDate,transactions:rows,totalTransactions:rows.length,totalLiters:rows.reduce((s,r)=>s+Number(r.liters),0),totalAmount:rows.reduce((s,r)=>s+Number(r.amount),0),generatedAt:new Date().toISOString(),issuer:'Delta Carburant',source:'Transactions TotalEnergies importées'};}
 async ensureReceipts(){await this.db.query(`INSERT INTO card_distribution_receipt(receipt_number,fuel_card_id,beneficiary_id,vehicle_id,distributed_to,requested_by)
  SELECT 'RCD-'||to_char(current_date,'YYYY')||'-'||upper(substr(replace(fc.id::text,'-',''),1,10)),fc.id,ca.beneficiary_id,ca.vehicle_id,fc.responsible_user_id,coalesce(ca.requested_by,fc.responsible_user_id)
  FROM fuel_card fc LEFT JOIN LATERAL(SELECT beneficiary_id,vehicle_id,requested_by FROM card_assignment WHERE fuel_card_id=fc.id AND ends_at IS NULL ORDER BY starts_at DESC LIMIT 1)ca ON true
  WHERE fc.deleted_at IS NULL AND fc.status IN('ACTIVE','DISTRIBUTED','ASSIGNED') ON CONFLICT(fuel_card_id) DO NOTHING`);}
 async receipts(actor:Actor){await this.ensureReceipts();return this.db.query(`SELECT r.id,r.receipt_number AS "receiptNumber",fc.masked_card_number AS card,fc.status AS "cardStatus",coalesce(b.display_name,fc.holder_name,'—') AS beneficiary,coalesce(v.registration_display,'—') AS vehicle,coalesce(owner.display_name,'—') AS "distributedTo",r.status,r.zin_approved_at AS "zinApprovedAt",zin.display_name AS "zinApprovedBy",r.dg_approved_at AS "dgApprovedAt",dg.display_name AS "dgApprovedBy",r.issued_at AS "issuedAt",r.created_at AS "createdAt"
  FROM card_distribution_receipt r JOIN fuel_card fc ON fc.id=r.fuel_card_id LEFT JOIN beneficiary b ON b.id=r.beneficiary_id LEFT JOIN vehicle v ON v.id=r.vehicle_id LEFT JOIN app_user owner ON owner.id=r.distributed_to LEFT JOIN app_user zin ON zin.id=r.zin_approved_by LEFT JOIN app_user dg ON dg.id=r.dg_approved_by
  WHERE $2<>'NAJIB_ASSIGNER' OR r.distributed_to=$1 OR fc.responsible_user_id=$1 ORDER BY r.created_at DESC`,[actor.sub,actor.role]);}
 async returnReceipts(actor:Actor){return this.db.query(`SELECT rr.id,rr.receipt_number AS "receiptNumber",fc.masked_card_number AS card,
  returned.display_name AS "returnedBy",zin.display_name AS "receivedBy",dg.display_name AS "dgApprovedBy",
  cr.zin_approved_at AS "zinApprovedAt",cr.dg_approved_at AS "dgApprovedAt",rr.returned_at AS "returnedAt",rr.consumption_rate::float AS "consumptionRate",rr.consumption_month AS "consumptionMonth",
  coalesce(rr.monthly_limit,fc.monthly_limit)::float AS "monthlyLimit",coalesce(rr.consumed_amount,0)::float AS "consumedAmount",
  coalesce(rr.consumed_liters,0)::float AS "consumedLiters",coalesce(rr.transaction_count,0)::int AS "transactionCount",
  rr.restored_at AS "restoredAt",restored.display_name AS "restoredBy",fc.status AS "cardStatus",fc.monthly_limit::float AS "currentLimit"
  FROM card_return_receipt rr JOIN fuel_card fc ON fc.id=rr.fuel_card_id JOIN app_user returned ON returned.id=rr.returned_by
  JOIN app_user zin ON zin.id=rr.received_by JOIN card_request cr ON cr.id=rr.card_request_id JOIN app_user dg ON dg.id=cr.dg_approved_by LEFT JOIN app_user restored ON restored.id=rr.restored_by
  WHERE returned.role='NAJIB_ASSIGNER'
    AND ($2<>'NAJIB_ASSIGNER' OR rr.returned_by=$1)
  ORDER BY rr.returned_at DESC`,[actor.sub,actor.role]);}
 async restoreReturnedCard(id:string,actor:Actor){return this.db.transaction(async client=>{
  const found=await client.query(`SELECT rr.*,fc.status,fc.monthly_limit,fc.masked_card_number,cr.beneficiary_id,cr.vehicle_id
    FROM card_return_receipt rr JOIN fuel_card fc ON fc.id=rr.fuel_card_id JOIN card_request cr ON cr.id=rr.card_request_id
    WHERE rr.id=$1 FOR UPDATE OF rr,fc`,[id]);const receipt=found.rows[0];
  if(!receipt)throw new NotFoundException('Reçu de restitution introuvable');
  if(receipt.restored_at)throw new BadRequestException('Cette carte a déjà été restaurée à Najib');
  if(receipt.status!=='SAFE')throw new BadRequestException('La carte doit être au coffre avant sa restauration');
  if(Number(receipt.monthly_limit)<=0)throw new BadRequestException('Le plafond de la carte doit être configuré avant sa restauration');
  await client.query(`UPDATE fuel_card SET status='DISTRIBUTED',card_category='OFF_PARK',responsible_user_id=$2 WHERE id=$1`,[receipt.fuel_card_id,receipt.returned_by]);
  await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at)
    VALUES($1,$2,$3,'APPROVED_ZIN',$4,$5,now())`,[receipt.fuel_card_id,receipt.beneficiary_id,receipt.vehicle_id,receipt.returned_by,actor.sub]);
  await client.query(`UPDATE card_return_receipt SET restored_by=$2,restored_at=now(),restored_limit=$3 WHERE id=$1`,[id,actor.sub,receipt.monthly_limit]);
  await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) VALUES($1,'Carte restaurée à Najib',$2,'returns','fuel_card',$3)`,[receipt.returned_by,`La carte ${receipt.masked_card_number} vous a été restaurée avec un plafond de ${Number(receipt.monthly_limit).toFixed(3)} TND`,receipt.fuel_card_id]);
  await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'RESTORE_RETURNED_CARD','fuel_card',$2,$3)`,[actor.email,receipt.fuel_card_id,{responsibleUserId:receipt.returned_by,monthlyLimit:Number(receipt.monthly_limit),returnReceiptId:id}]);
  return {id,cardId:receipt.fuel_card_id,status:'DISTRIBUTED',restoredTo:receipt.returned_by,monthlyLimit:Number(receipt.monthly_limit)};
 });}
 async approve(id:string,actor:Actor){return this.db.transaction(async client=>{const found=await client.query(`SELECT r.*,fc.masked_card_number FROM card_distribution_receipt r JOIN fuel_card fc ON fc.id=r.fuel_card_id WHERE r.id=$1 AND r.status<>'REVOKED' FOR UPDATE OF r`,[id]);if(!found.rows[0])throw new NotFoundException('Reçu introuvable');
  if(actor.role==='ZIN_FINANCE'){if(found.rows[0].zin_approved_at)throw new BadRequestException('Ce reçu est déjà autorisé par Zin');await client.query(`UPDATE card_distribution_receipt SET zin_approved_by=$2,zin_approved_at=now() WHERE id=$1`,[id,actor.sub]);}
  else if(actor.role==='DIRECTION_GENERAL'){if(found.rows[0].dg_approved_at)throw new BadRequestException('Ce reçu est déjà autorisé par la DG');await client.query(`UPDATE card_distribution_receipt SET dg_approved_by=$2,dg_approved_at=now() WHERE id=$1`,[id,actor.sub]);}
  else await client.query(`UPDATE card_distribution_receipt SET zin_approved_by=$2,zin_approved_at=coalesce(zin_approved_at,now()),dg_approved_by=$2,dg_approved_at=coalesce(dg_approved_at,now()) WHERE id=$1`,[id,actor.sub]);
  const row=await client.query(`UPDATE card_distribution_receipt SET status=CASE WHEN zin_approved_at IS NOT NULL AND dg_approved_at IS NOT NULL THEN 'AUTHORIZED' ELSE 'PENDING' END,issued_at=CASE WHEN zin_approved_at IS NOT NULL AND dg_approved_at IS NOT NULL THEN coalesce(issued_at,now()) ELSE NULL END WHERE id=$1 RETURNING *`,[id]);
  await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'APPROVE_CARD_RECEIPT','card_distribution_receipt',$2,$3)`,[actor.email,id,{role:actor.role,status:row.rows[0].status}]);return row.rows[0];});}
}
