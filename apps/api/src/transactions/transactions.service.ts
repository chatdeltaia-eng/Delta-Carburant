import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor = { sub: string; email: string };
type Correction = { station?: string; liters?: number; amount?: number; reason: string };
type Allocation = { beneficiaryId?: string; vehicleId?: string; beneficiary?:string;vehicle?:string; amount: number; liters?: number; note?: string };
type ImportRow = { date:string; cardNumber:string; vehicle?:string; beneficiary?:string; station?:string; product?:string; liters:number; amount:number; previousMileage?:number; mileage?:number; authorizationCode?:string };
@Injectable()
export class TransactionsService {
  constructor(private readonly db: DatabaseService) {}
  private registrationKeys(value:string) {
    const normalized=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const match=normalized.match(/^(\d+)TU(\d+)$/);
    return match?[normalized,`${match[2]}TU${match[1]}`]:[normalized];
  }
  async list(actor: { sub: string; role: string }) {
    const transactions = await this.db.query(`SELECT ft.id,ft.transaction_date AS date,fc.masked_card_number AS card,
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
    WHERE ft.deleted_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)
    GROUP BY ft.id,fc.id,tib.source_filename,b.display_name,v.registration_display
    ORDER BY ft.transaction_date DESC`, [actor.role==='NAJIB_ASSIGNER',actor.sub]);
    if (actor.role === 'NAJIB_ASSIGNER') return transactions;
    const pending = await this.db.query(`SELECT ('review:'||tr.id::text) AS id,tr.transaction_date AS date,
      tr.card_number AS card,tr.station,tr.product,tr.quantity_liters AS liters,tr.amount_incl_tax AS amount,
      tib.source_filename AS file,tr.beneficiary_name AS beneficiary,tr.vehicle_registration AS vehicle,
      null::timestamptz AS "correctedAt",null::text AS "cardCategory",null::numeric AS "monthlyLimit",
      0::numeric AS "allocatedAmount",tr.amount_incl_tax AS "remainingAmount",null::uuid AS "pendingAllocationId",
      '[]'::jsonb AS allocations,tr.id AS "reviewId",tr.issue_type AS "reviewIssue",tr.status AS "reviewStatus"
      FROM transaction_review tr JOIN transaction_import_batch tib ON tib.id=tr.import_batch_id
      WHERE tr.status='PENDING' ORDER BY tr.transaction_date DESC`);
    return [...pending,...transactions].sort((a:any,b:any)=>new Date(b.date).getTime()-new Date(a.date).getTime());
  }
  reviews() { return this.db.query(`SELECT id,issue_type AS "issueType",status,card_number AS "cardNumber",
    vehicle_registration AS vehicle,beneficiary_name AS beneficiary,transaction_date AS date,station,product,quantity_liters AS liters,
    amount_incl_tax AS amount,created_at AS "createdAt" FROM transaction_review ORDER BY created_at DESC`); }
  async import(dto:{filename:string;rows:ImportRow[]},actor:Actor) { return this.db.transaction(async client => {
    if (!dto.rows.length) throw new BadRequestException('Le fichier ne contient aucune transaction');
    const batch = await client.query(`INSERT INTO transaction_import_batch(source_filename,source_sha256,imported_by,total_rows)
      VALUES($1,encode(digest($2 || clock_timestamp()::text,'sha256'),'hex'),$3,$4) RETURNING id`,[dto.filename,dto.filename,actor.sub,dto.rows.length]);
    let imported=0,review=0,duplicates=0;
    for (let index=0;index<dto.rows.length;index++) {
      const row=dto.rows[index], cardKey=row.cardNumber.replace(/\D/g,'');
      if (!cardKey) throw new BadRequestException(
        `Numéro du mode de paiement absent à la ligne ${index+2}. Import annulé : aucune consommation n'a été regroupée sur une carte inconnue.`,
      );
      let card=await client.query(`SELECT id,company_id,official_registration,holder_name FROM fuel_card WHERE deleted_at IS NULL AND (
        regexp_replace(masked_card_number,'[^0-9]','','g')=$1 OR official_card_number=$1 OR total_payment_number=$1
      ) ORDER BY CASE WHEN total_payment_number=$1 THEN 0 ELSE 1 END LIMIT 1`,[cardKey]);
      const vehicleKey=(row.vehicle??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const vehicleKeys=this.registrationKeys(vehicleKey);
      let vehicle=vehicleKey ? await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name
        FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL AND d.active
        WHERE regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g')=ANY($1::text[])
        AND v.active AND v.deleted_at IS NULL
        ORDER BY CASE WHEN regexp_replace(upper(v.registration_display),'[^A-Z0-9]','','g')=$2 THEN 0 ELSE 1 END LIMIT 1`,[vehicleKeys,vehicleKey]) : {rows:[]};
      const currentAssignment=card.rows[0]?await client.query(`SELECT ca.vehicle_id AS id,v.company_id,v.driver_name,d.full_name AS driver_full_name,
        ca.beneficiary_id,b.display_name AS beneficiary_name FROM card_assignment ca
        LEFT JOIN vehicle v ON v.id=ca.vehicle_id LEFT JOIN driver d ON d.id=v.driver_id AND d.active AND d.deleted_at IS NULL
        JOIN beneficiary b ON b.id=ca.beneficiary_id WHERE ca.fuel_card_id=$1 AND ca.ends_at IS NULL AND ca.is_primary LIMIT 1`,[card.rows[0].id]):{rows:[]};
      if(!vehicle.rows[0]&&currentAssignment.rows[0]?.id) vehicle={rows:[currentAssignment.rows[0]]} as any;
      const isOffPark=String(row.vehicle??card.rows[0]?.official_registration??'').toUpperCase().replace(/[\s-]/g,'')==='HORSPARC';
      const beneficiaryName=(row.beneficiary??currentAssignment.rows[0]?.beneficiary_name??card.rows[0]?.holder_name??vehicle.rows[0]?.driver_full_name??vehicle.rows[0]?.driver_name??'').trim();
      const companyId=vehicle.rows[0]?.company_id??card.rows[0]?.company_id;
      // Le véhicule est la source de vérité pour la société. Une carte Total
      // créée auparavant sous DELTA ne doit pas bloquer une transaction DCD/DC.
      if(card.rows[0]&&vehicle.rows[0]&&card.rows[0].company_id!==companyId) {
        await client.query(`UPDATE fuel_card SET company_id=$2,updated_at=now() WHERE id=$1`,[card.rows[0].id,companyId]);
        card.rows[0].company_id=companyId;
      }
      const issue=!companyId||(!vehicle.rows[0]&&!isOffPark)?'UNKNOWN_VEHICLE':!beneficiaryName?'MISSING_BENEFICIARY':null;
      if (issue) {
        await client.query(`INSERT INTO transaction_review(import_batch_id,source_row_number,issue_type,card_number,vehicle_registration,
          beneficiary_name,transaction_date,station,product,quantity_liters,amount_incl_tax,fuel_card_id,previous_mileage,reported_mileage,authorization_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [batch.rows[0].id,index+1,issue,row.cardNumber,row.vehicle??null,beneficiaryName||null,row.date,row.station??null,row.product??null,row.liters,row.amount,card.rows[0]?.id??null,row.previousMileage??null,row.mileage??null,row.authorizationCode??null]); review++; continue;
      }
      if(!card.rows[0]) {
        card=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,card_category)
          VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,0,'ACTIVE','PERSONALIZED')
          ON CONFLICT(card_number_hmac) DO UPDATE SET updated_at=now() RETURNING id,company_id`,[companyId,row.cardNumber,process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key']);
      }
      const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Transactions importées') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[companyId]);
      const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3)
        ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[companyId,department.rows[0].id,beneficiaryName]);
      const assignment=await client.query(`SELECT id,beneficiary_id,vehicle_id FROM card_assignment WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1 FOR UPDATE`,[card.rows[0].id]);
      if(assignment.rows[0]) await client.query(`UPDATE card_assignment SET beneficiary_id=$2,vehicle_id=$3,
        workflow_status='APPROVED_ZIN',reviewed_by=$4,reviewed_at=now() WHERE id=$1`,[assignment.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,actor.sub]);
      else await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at)
        VALUES($1,$2,$3,'APPROVED_ZIN',$4,$4,now())`,[card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,actor.sub]);
      const external=row.authorizationCode?.trim()?`TOTAL:${row.authorizationCode.trim()}`:`${dto.filename}:${index+1}:${cardKey}:${row.date}`;
      const inserted=await client.query(`INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,station,product,
        quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'TOTAL_EXCEL',$10,$11,$12,$13,$14)
        ON CONFLICT(external_transaction_id,source) DO UPDATE SET
          fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id,vehicle_id=excluded.vehicle_id,
          transaction_date=excluded.transaction_date,station=excluded.station,product=excluded.product,
          quantity_liters=excluded.quantity_liters,amount_incl_tax=excluded.amount_incl_tax,
          import_batch_id=excluded.import_batch_id,source_row_number=excluded.source_row_number,
          previous_mileage=excluded.previous_mileage,reported_mileage=excluded.reported_mileage,
          authorization_code=excluded.authorization_code,deleted_at=null,deleted_by=null
        WHERE fuel_transaction.deleted_at IS NOT NULL RETURNING id`,[external,card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,row.date,row.station??null,row.product??null,row.liters,row.amount,batch.rows[0].id,index+1,row.previousMileage??null,row.mileage??null,row.authorizationCode??null]);
      if(inserted.rowCount){
        imported++;
        const monthUsage=await client.query(`SELECT coalesce(sum(amount_incl_tax),0)::float AS consumed FROM fuel_transaction
          WHERE fuel_card_id=$1 AND deleted_at IS NULL AND transaction_date>=date_trunc('month',$2::timestamptz)
          AND transaction_date<date_trunc('month',$2::timestamptz)+interval '1 month'`,[card.rows[0].id,row.date]);
        const limit=await client.query(`SELECT monthly_limit,masked_card_number,responsible_user_id FROM fuel_card WHERE id=$1`,[card.rows[0].id]);
        if(Number(limit.rows[0].monthly_limit)>0&&Number(monthUsage.rows[0].consumed)>Number(limit.rows[0].monthly_limit)){
          const anomaly=await client.query(`INSERT INTO anomaly(fuel_card_id,anomaly_type,severity,status,description,assigned_to,metadata)
            VALUES($1,'MONTHLY_LIMIT_EXCEEDED','HIGH','OPEN',$2,$3,$4)
            ON CONFLICT(fuel_card_id,anomaly_type) WHERE status='OPEN' AND anomaly_type='MONTHLY_LIMIT_EXCEEDED'
            DO UPDATE SET description=excluded.description,metadata=excluded.metadata,created_at=now() RETURNING id`,[card.rows[0].id,
            `La carte ${limit.rows[0].masked_card_number} dépasse son plafond mensuel : ${Number(monthUsage.rows[0].consumed).toFixed(3)} / ${Number(limit.rows[0].monthly_limit).toFixed(3)} DT`,limit.rows[0].responsible_user_id,
            {consumed:Number(monthUsage.rows[0].consumed),limit:Number(limit.rows[0].monthly_limit),transactionId:inserted.rows[0].id}]);
          await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
            SELECT id,'Dépassement de plafond',$2,'CRITICAL','anomalies','anomaly',$3 FROM app_user
            WHERE active AND (id=$1 OR role::text=ANY($4::text[]))`,[limit.rows[0].responsible_user_id,`La carte ${limit.rows[0].masked_card_number} a dépassé son plafond mensuel`,anomaly.rows[0].id,['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN']]);
        }
      } else duplicates++;
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
        VALUES($1,$2,'HIGH','OPEN',$3,$4)`,[row.fuel_card_id,row.issue_type,row.issue_type==='UNKNOWN_CARD'?`Carte ${row.card_number} inconnue de DeltaCarburant ayant effectué une transaction de ${row.amount_incl_tax}`:row.issue_type==='MISSING_BENEFICIARY'?`Aucun bénéficiaire identifié pour le véhicule ${row.vehicle_registration}`:`Véhicule ${row.vehicle_registration} externe utilisant la carte ${row.card_number}`,actor.sub]);
    } else {
      const vehicleKey=(row.vehicle_registration??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const vehicle=vehicleKey?await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name
        FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL AND d.active
        WHERE regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g')=$1
        AND v.active AND v.deleted_at IS NULL LIMIT 1`,[vehicleKey]):{rows:[]};
      if(!vehicle.rows[0]) throw new BadRequestException(`Le véhicule ${row.vehicle_registration??''} est introuvable dans le référentiel.`);
      const companyId=vehicle.rows[0].company_id;
      const cardKey=String(row.card_number).replace(/\D/g,'');
      let card=await client.query(`SELECT id,company_id FROM fuel_card WHERE deleted_at IS NULL
        AND regexp_replace(masked_card_number,'[^0-9]','','g')=$1 LIMIT 1 FOR UPDATE`,[cardKey]);
      if(card.rows[0]&&card.rows[0].company_id!==companyId)
        throw new BadRequestException('Cette carte existe déjà dans une autre société. Contactez l’administrateur.');
      if(!card.rows[0]) card=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,card_category)
        VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,0,'ACTIVE','PERSONALIZED')
        ON CONFLICT(card_number_hmac) DO UPDATE SET updated_at=now()
        RETURNING id,company_id`,[companyId,row.card_number,process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key']);
      const beneficiaryName=(row.beneficiary_name??vehicle.rows[0].driver_full_name??vehicle.rows[0].driver_name??`Conducteur ${row.vehicle_registration}`).trim();
      const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Transactions importées')
        ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[companyId]);
      const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3)
        ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[companyId,department.rows[0].id,beneficiaryName]);
      const assignment=await client.query(`SELECT id FROM card_assignment
        WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1 FOR UPDATE`,[card.rows[0].id]);
      if(assignment.rows[0]) await client.query(`UPDATE card_assignment SET beneficiary_id=$2,vehicle_id=$3,
        workflow_status='APPROVED_ZIN',reviewed_by=$4,reviewed_at=now() WHERE id=$1`,[assignment.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0].id,actor.sub]);
      else await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at)
        VALUES($1,$2,$3,'APPROVED_ZIN',$4,$4,now())`,[card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0].id,actor.sub]);
      await client.query(`INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,station,product,quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'TOTAL_EXCEL',$10,$11,$12,$13,$14)
        ON CONFLICT(external_transaction_id,source) DO NOTHING`,[row.authorization_code?`TOTAL:${row.authorization_code}`:`review:${row.id}`,card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0].id,row.transaction_date,row.station,row.product,row.quantity_liters,row.amount_incl_tax,row.import_batch_id,row.source_row_number,row.previous_mileage,row.reported_mileage,row.authorization_code]);
    }
    const result=await client.query(`UPDATE transaction_review SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'transaction_review',$3,$4)`,[actor.email,dto.decision,id,{reason:dto.reason}]); return result.rows[0];
  }); }
  async allocate(id: string, dto: Allocation, actor: Actor) { return this.db.transaction(async client => {
    const transaction = await client.query(`SELECT ft.amount_incl_tax,ft.quantity_liters,fc.responsible_user_id,
      fc.company_id FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.id=$1 AND ft.deleted_at IS NULL FOR UPDATE OF ft,fc`, [id]);
    const source = transaction.rows[0];
    if (!source) throw new NotFoundException('Transaction introuvable');
    if (source.responsible_user_id !== actor.sub) throw new NotFoundException('Cette carte ne relève pas de ce responsable');
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) throw new BadRequestException('Le montant à répartir doit être positif');
    const allocationTotal = await client.query(`SELECT coalesce(sum(allocated_amount),0) AS allocated
      FROM transaction_allocation WHERE fuel_transaction_id=$1 AND workflow_status IN('PENDING','APPROVED')`, [id]);
    if (Number(allocationTotal.rows[0].allocated)+dto.amount > Number(source.amount_incl_tax)) throw new BadRequestException('La répartition dépasse le montant de la transaction Total');
    let beneficiaryId=dto.beneficiaryId,vehicleId=dto.vehicleId;
    if(!beneficiaryId&&dto.beneficiary){const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Hors parc') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[source.company_id]);const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[source.company_id,department.rows[0].id,dto.beneficiary.trim()]);beneficiaryId=beneficiary.rows[0].id;}
    if(!vehicleId&&dto.vehicle){const key=dto.vehicle.toUpperCase().replace(/[^A-Z0-9]/g,'');const vehicle=await client.query(`SELECT id FROM vehicle WHERE company_id=$1 AND regexp_replace(upper(coalesce(registration_normalized::text,registration_display)),'[^A-Z0-9]','','g')=$2 AND active AND deleted_at IS NULL`,[source.company_id,key]);vehicleId=vehicle.rows[0]?.id;}
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
    const reviews = await client.query(`UPDATE transaction_review SET status='REJECTED',decided_by=$1,decided_at=now(),
      decision_reason='Suppression des transactions par Zin' WHERE status='PENDING'`, [actor.sub]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
      VALUES($1,'BATCH_SOFT_DELETE','fuel_transaction','ALL',$2)`, [actor.email,{count:result.rowCount,clearedReviews:reviews.rowCount}]);
    return { success: true, deleted: result.rowCount, clearedReviews: reviews.rowCount };
  }); }
}
