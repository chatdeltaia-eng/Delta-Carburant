import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor = { sub: string; email: string };
type Correction = { station?: string; liters?: number; amount?: number; reason: string };
type Allocation = { beneficiaryId?: string; vehicleId?: string; beneficiary?:string;vehicle?:string; amount: number; liters?: number; note?: string };
type ImportRow = { date:string; cardNumber:string; vehicle?:string; station?:string; product?:string; liters:number; amount:number; previousMileage?:number; mileage?:number; authorizationCode?:string };
@Injectable()
export class TransactionsService {
  constructor(private readonly db: DatabaseService) {}
  list(actor: { sub: string; role: string }) { return this.db.query(`SELECT ft.id,ft.transaction_date AS date,fc.masked_card_number AS card,
    ft.station,ft.product,ft.quantity_liters AS liters,ft.amount_incl_tax AS amount,tib.source_filename AS file,
    b.display_name AS beneficiary,v.registration_display AS vehicle,ft.corrected_at AS "correctedAt",
    fc.card_category AS "cardCategory",fc.monthly_limit AS "monthlyLimit",
    coalesce(sum(ta.allocated_amount) FILTER(WHERE ta.workflow_status='APPROVED'),0) AS "allocatedAmount",
    ft.amount_incl_tax-coalesce(sum(ta.allocated_amount) FILTER(WHERE ta.workflow_status='APPROVED'),0) AS "remainingAmount",
    (array_agg(ta.id) FILTER(WHERE ta.workflow_status='PENDING'))[1] AS "pendingAllocationId",
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',detail.id,'beneficiary',db.display_name,'vehicle',dv.registration_display,
      'amount',detail.allocated_amount,'liters',detail.allocated_liters,'note',detail.note,'status',detail.workflow_status,
      'allocatedAt',detail.allocated_at) ORDER BY detail.allocated_at)
      FROM transaction_allocation detail
      JOIN beneficiary db ON db.id=detail.beneficiary_id
      JOIN vehicle dv ON dv.id=detail.vehicle_id
      WHERE detail.fuel_transaction_id=ft.id),'[]'::jsonb) AS allocations
    FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
    LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id
    LEFT JOIN transaction_import_batch tib ON tib.id=ft.import_batch_id
    LEFT JOIN transaction_allocation ta ON ta.fuel_transaction_id=ft.id
    WHERE ft.deleted_at IS NULL AND ($1::boolean=false OR (fc.card_category='OFF_PARK' AND fc.responsible_user_id=$2))
    GROUP BY ft.id,fc.id,tib.source_filename,b.display_name,v.registration_display
    ORDER BY ft.transaction_date DESC`, [actor.role==='NAJIB_ASSIGNER',actor.sub]); }
  reviews() { return this.db.query(`SELECT id,issue_type AS "issueType",status,card_number AS "cardNumber",
    vehicle_registration AS vehicle,transaction_date AS date,station,product,quantity_liters AS liters,
    amount_incl_tax AS amount,created_at AS "createdAt" FROM transaction_review ORDER BY created_at DESC`); }
  async import(dto:{filename:string;rows:ImportRow[]},actor:Actor) { return this.db.transaction(async client => {
    if (!dto.rows.length) throw new BadRequestException('Le fichier ne contient aucune transaction');
    const batch = await client.query(`INSERT INTO transaction_import_batch(source_filename,source_sha256,imported_by,total_rows)
      VALUES($1,encode(digest($2 || clock_timestamp()::text,'sha256'),'hex'),$3,$4) RETURNING id`,[dto.filename,dto.filename,actor.sub,dto.rows.length]);
    let imported=0,review=0,duplicates=0;
    for (let index=0;index<dto.rows.length;index++) {
      const row=dto.rows[index], cardKey=row.cardNumber.replace(/\D/g,'');
      const card=await client.query(`SELECT id,company_id FROM fuel_card WHERE deleted_at IS NULL AND regexp_replace(masked_card_number,'[^0-9]','','g')=$1 LIMIT 1`,[cardKey]);
      const vehicleKey=(row.vehicle??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const vehicle=vehicleKey ? await client.query(`SELECT id,company_id FROM vehicle WHERE registration_normalized=$1 AND active LIMIT 1`,[vehicleKey]) : {rows:[]};
      const issue=!card.rows[0]?'UNKNOWN_CARD':vehicleKey&&(!vehicle.rows[0]||vehicle.rows[0].company_id!==card.rows[0].company_id)?'UNKNOWN_VEHICLE':null;
      if (issue) {
        await client.query(`INSERT INTO transaction_review(import_batch_id,source_row_number,issue_type,card_number,vehicle_registration,
          transaction_date,station,product,quantity_liters,amount_incl_tax,fuel_card_id,previous_mileage,reported_mileage,authorization_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [batch.rows[0].id,index+1,issue,row.cardNumber,row.vehicle??null,row.date,row.station??null,row.product??null,row.liters,row.amount,card.rows[0]?.id??null,row.previousMileage??null,row.mileage??null,row.authorizationCode??null]); review++; continue;
      }
      const external=row.authorizationCode?.trim()?`TOTAL:${row.authorizationCode.trim()}`:`${dto.filename}:${index+1}:${cardKey}:${row.date}`;
      const inserted=await client.query(`INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,vehicle_id,transaction_date,station,product,
        quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'TOTAL_EXCEL',$9,$10,$11,$12,$13)
        ON CONFLICT(external_transaction_id,source) DO NOTHING RETURNING id`,[external,card.rows[0].id,vehicle.rows[0]?.id??null,row.date,row.station??null,row.product??null,row.liters,row.amount,batch.rows[0].id,index+1,row.previousMileage??null,row.mileage??null,row.authorizationCode??null]);
      inserted.rowCount ? imported++ : duplicates++;
    }
    await client.query(`UPDATE transaction_import_batch SET imported_rows=$2,duplicate_rows=$3,rejected_rows=$4 WHERE id=$1`,[batch.rows[0].id,imported,duplicates,review]);
    if(review) await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
      SELECT id,'Transactions inconnues détectées',$2,'WARNING','anomalies','transaction_import_batch',$3 FROM app_user
      WHERE active AND role::text=ANY($1::text[])`,[['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],`${review} transaction(s) nécessitent la vérification d’une carte ou d’un véhicule`,batch.rows[0].id]);
    return {batchId:batch.rows[0].id,imported,duplicates,pendingReview:review};
  }); }
  async review(id:string,dto:{decision:'ACCEPTED'|'REJECTED';reason?:string},actor:Actor) { return this.db.transaction(async client => {
    const found=await client.query(`SELECT * FROM transaction_review WHERE id=$1 AND status='PENDING' FOR UPDATE`,[id]);
    const row=found.rows[0]; if(!row) throw new NotFoundException('Contrôle introuvable ou déjà traité');
    if(dto.decision==='REJECTED') {
      await client.query(`INSERT INTO anomaly(fuel_card_id,anomaly_type,severity,status,description,assigned_to)
        VALUES($1,$2,'HIGH','OPEN',$3,$4)`,[row.fuel_card_id,row.issue_type,row.issue_type==='UNKNOWN_CARD'?`Carte ${row.card_number} inconnue de DeltaCarburant ayant effectué une transaction de ${row.amount_incl_tax}`:`Véhicule ${row.vehicle_registration} externe utilisant la carte ${row.card_number}`,actor.sub]);
    } else {
      let cardId=row.fuel_card_id;
      const company=row.fuel_card_id?await client.query(`SELECT company_id AS id FROM fuel_card WHERE id=$1`,[row.fuel_card_id]):await client.query(`SELECT id FROM company WHERE code='DELTA' AND active LIMIT 1`);
      if(!cardId) {
        const created=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,card_category)
          VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,0,'ACTIVE','PERSONALIZED') RETURNING id`,[company.rows[0].id,row.card_number,process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key']); cardId=created.rows[0].id;
      }
      let vehicleId=null;
      if(row.vehicle_registration) { const key=row.vehicle_registration.toUpperCase().replace(/[^A-Z0-9]/g,''); const vehicle=await client.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,requires_review)
        VALUES($1,$2,$3,false) ON CONFLICT(company_id,registration_normalized) DO UPDATE SET active=true RETURNING id`,[company.rows[0].id,key,row.vehicle_registration]); vehicleId=vehicle.rows[0].id; }
      await client.query(`INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,vehicle_id,transaction_date,station,product,quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'TOTAL_EXCEL',$9,$10,$11,$12,$13)`,[row.authorization_code?`TOTAL:${row.authorization_code}`:`review:${row.id}`,cardId,vehicleId,row.transaction_date,row.station,row.product,row.quantity_liters,row.amount_incl_tax,row.import_batch_id,row.source_row_number,row.previous_mileage,row.reported_mileage,row.authorization_code]);
    }
    const result=await client.query(`UPDATE transaction_review SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'transaction_review',$3,$4)`,[actor.email,dto.decision,id,{reason:dto.reason}]); return result.rows[0];
  }); }
  async allocate(id: string, dto: Allocation, actor: Actor) { return this.db.transaction(async client => {
    const transaction = await client.query(`SELECT ft.amount_incl_tax,ft.quantity_liters,fc.responsible_user_id,
      fc.company_id FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.id=$1 AND ft.deleted_at IS NULL AND fc.card_category='OFF_PARK' FOR UPDATE OF ft,fc`, [id]);
    const source = transaction.rows[0];
    if (!source) throw new NotFoundException('Transaction hors parc introuvable');
    if (source.responsible_user_id !== actor.sub) throw new NotFoundException('Cette carte hors parc ne relève pas de ce responsable');
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) throw new BadRequestException('Le montant à répartir doit être positif');
    const allocationTotal = await client.query(`SELECT coalesce(sum(allocated_amount),0) AS allocated
      FROM transaction_allocation WHERE fuel_transaction_id=$1 AND workflow_status IN('PENDING','APPROVED')`, [id]);
    if (Number(allocationTotal.rows[0].allocated)+dto.amount > Number(source.amount_incl_tax)) throw new BadRequestException('La répartition dépasse le montant de la transaction Total');
    let beneficiaryId=dto.beneficiaryId,vehicleId=dto.vehicleId;
    if(!beneficiaryId&&dto.beneficiary){const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Hors parc') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[source.company_id]);const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[source.company_id,department.rows[0].id,dto.beneficiary.trim()]);beneficiaryId=beneficiary.rows[0].id;}
    if(!vehicleId&&dto.vehicle){const key=dto.vehicle.toUpperCase().replace(/[^A-Z0-9]/g,'');const vehicle=await client.query(`SELECT id FROM vehicle WHERE company_id=$1 AND registration_normalized=$2 AND active AND deleted_at IS NULL`,[source.company_id,key]);vehicleId=vehicle.rows[0]?.id;}
    if(!beneficiaryId||!vehicleId)throw new BadRequestException('Bénéficiaire ou véhicule introuvable dans la société de la carte');
    const targets = await client.query(`SELECT b.company_id AS beneficiary_company,v.company_id AS vehicle_company
      FROM beneficiary b,vehicle v WHERE b.id=$1 AND v.id=$2`, [beneficiaryId,vehicleId]);
    if (!targets.rows[0] || targets.rows[0].beneficiary_company !== source.company_id || targets.rows[0].vehicle_company !== source.company_id)
      throw new BadRequestException('Le bénéficiaire et le véhicule doivent appartenir à la société de la carte');
    const result = await client.query(`INSERT INTO transaction_allocation(fuel_transaction_id,beneficiary_id,vehicle_id,
      allocated_amount,allocated_liters,note,allocated_by,workflow_status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`,
      [id,beneficiaryId,vehicleId,dto.amount,dto.liters??null,dto.note??null,actor.sub]);
    await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) SELECT id,'Répartition à valider',$2,'transactions','transaction_allocation',$3 FROM app_user WHERE active AND role::text=ANY($1::text[])`,[['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],`Répartition de ${dto.amount} sur une transaction hors parc`,result.rows[0].id]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
      VALUES($1,'ALLOCATE','fuel_transaction',$2,$3)`, [actor.email,id,result.rows[0]]);
    return {
      ...result.rows[0],
      originalAmount: Number(source.amount_incl_tax),
      allocatedAmount: Number(allocationTotal.rows[0].allocated)+dto.amount,
      remainingAmount: Number(source.amount_incl_tax)-Number(allocationTotal.rows[0].allocated)-dto.amount,
    };
  }); }
  async decideAllocation(id:string,dto:{decision:'APPROVED'|'REJECTED';reason?:string},actor:Actor){if(dto.decision==='REJECTED'&&!dto.reason?.trim())throw new BadRequestException('Le motif du refus est obligatoire');return this.db.transaction(async client=>{const current=await client.query(`SELECT ta.*,fc.masked_card_number FROM transaction_allocation ta JOIN fuel_transaction ft ON ft.id=ta.fuel_transaction_id JOIN fuel_card fc ON fc.id=ft.fuel_card_id WHERE ta.id=$1 AND ta.workflow_status='PENDING' FOR UPDATE OF ta`,[id]);if(!current.rows[0])throw new NotFoundException('Répartition introuvable ou déjà traitée');const row=current.rows[0];const result=await client.query(`UPDATE transaction_allocation SET workflow_status=$2,reviewed_by=$3,reviewed_at=now(),decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) VALUES($1,$2,$3,'transactions','transaction_allocation',$4)`,[row.allocated_by,dto.decision==='APPROVED'?'Répartition validée':'Répartition refusée',`${row.masked_card_number} · ${row.allocated_amount} — ${dto.reason??'validée'}`,id]);return result.rows[0];});}
  async correct(id: string, dto: Correction, actor: Actor) { return this.db.transaction(async client => {
    const before = await client.query('SELECT * FROM fuel_transaction WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
    if (!before.rows[0]) throw new NotFoundException('Transaction introuvable');
    const result = await client.query(`UPDATE fuel_transaction SET station=coalesce($2,station),
      quantity_liters=coalesce($3,quantity_liters),amount_incl_tax=coalesce($4,amount_incl_tax),
      corrected_at=now(),corrected_by=$5,correction_reason=$6 WHERE id=$1 RETURNING *`,
      [id,dto.station??null,dto.liters??null,dto.amount??null,actor.sub,dto.reason]);
    await client.query(`INSERT INTO fuel_transaction_revision(fuel_transaction_id,changed_by,old_values,new_values,reason)
      VALUES($1,$2,$3,$4,$5)`,[id,actor.sub,before.rows[0],result.rows[0],dto.reason]);
    return result.rows[0];
  }); }
  async remove(id: string, actor: Actor) { return this.db.transaction(async client => {
    const result = await client.query('UPDATE fuel_transaction SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id, actor.sub]);
    if (!result.rows[0]) throw new NotFoundException('Transaction introuvable');
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'SOFT_DELETE','fuel_transaction',$2,$3)`, [actor.email,id,{deleted:true}]);
    return { success: true };
  }); }
  async removeAll(actor: Actor) { return this.db.transaction(async client => {
    const result = await client.query('UPDATE fuel_transaction SET deleted_at=now(),deleted_by=$1 WHERE deleted_at IS NULL', [actor.sub]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,new_values) VALUES($1,'BATCH_SOFT_DELETE','fuel_transaction',$2)`, [actor.email,{count:result.rowCount}]);
    return { success: true, deleted: result.rowCount };
  }); }
}
