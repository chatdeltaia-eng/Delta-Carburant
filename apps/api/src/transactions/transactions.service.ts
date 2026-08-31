import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
type Actor = { sub: string; email: string };
type Correction = { station?: string; liters?: number; amount?: number; reason: string };
type Allocation = { driverId?: string; beneficiaryName: string; vehicleId: string; amount: number; mileage: number; liters?: number; note?: string };
type ImportRow = { date:string; cardNumber:string; vehicle?:string; beneficiary?:string; station:string; product:string; liters:number; amount:number; previousMileage?:number; mileage?:number; authorizationCode?:string; externalId?:string };
@Injectable()
export class TransactionsService {
  constructor(private readonly db: DatabaseService) {}
  private cardLast4(value:string) {
    const digits=String(value??'').replace(/\D/g,'');
    return digits.length>=4?digits.slice(-4):'';
  }
  private async archiveCompletedMonths() {
    await this.db.query(`UPDATE fuel_transaction SET archived_at=now()
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND transaction_date<date_trunc('month',current_date)`);
  }
  private canonicalFuelProduct(value:string) {
    const key=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(['GASOIL','GO','DIESEL'].includes(key)) return 'GASOIL ORDINAIRE';
    if(['GASOILSS','GASOIL50','GOSSO'].includes(key)) return 'GASOIL SANS SOUFRE (GASOIL 50)';
    if(['SUPERSP','SSP','ESSENCE','ESSENCESANSPLOMB'].includes(key)) return 'ESSENCE SANS PLOMB';
    if(['GASEXC','GASSEXC','GASOILEXC','GOSSEXC','GASOILSSEXC','GASOIL50EXC','GASOILPOWER'].includes(key)) return 'GASOIL PREMIUM / POWER';
    if(['SSPEXC','SUPERSPEXC','SUPEREXC','ESSENCEEXC','ESSENCEPOWER'].includes(key)) return 'ESSENCE PREMIUM / POWER';
    return value.trim().toUpperCase();
  }
  private registrationKeys(value:string) {
    const normalized=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const match=normalized.match(/^(\d+)TU(\d+)$/);
    return match?[normalized,`${match[2]}TU${match[1]}`]:[normalized];
  }
  private isVehicleRegistration(value:string) {
    const normalized=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    return /^\d{1,4}(?:TU|TN)\d{1,4}$/.test(normalized);
  }
  private transactionFingerprint(row: ImportRow, cardKey: string) {
    const normalized = [
      cardKey,
      row.externalId?.trim().toUpperCase() ?? '',
      new Date(row.date).toISOString(),
      row.authorizationCode?.trim().toUpperCase() ?? '',
      row.station.trim().toUpperCase().replace(/\s+/g, ' '),
      row.product.trim().toUpperCase().replace(/\s+/g, ' '),
      Number(row.liters).toFixed(3),
      Number(row.amount).toFixed(3),
      String(row.vehicle ?? '').trim().toUpperCase().replace(/\s+/g, ' '),
    ].join('|');
    return createHash('sha256').update(normalized).digest('hex');
  }
  async list(actor: { sub: string; role: string },companyId='') {
    await this.archiveCompletedMonths();
    const transactions = await this.db.query(`SELECT ft.id,ft.transaction_date AS date,fc.masked_card_number AS card,
    c.code AS "companyCode",c.id AS "companyId",ft.station,ft.product,ft.quantity_liters AS liters,ft.amount_incl_tax AS amount,ft.unit_price AS "appliedPrice",
    ft.expected_amount AS "expectedAmount",ft.billing_difference AS "billingDifference",ft.validation_status AS "billingStatus",
    ft.billing_checked_at AS "billingCheckedAt",tib.source_filename AS file,
    b.display_name AS beneficiary,v.registration_display AS vehicle,coalesce(d.full_name,v.driver_name) AS driver,
    ft.previous_mileage AS "previousMileage",ft.reported_mileage AS mileage,ft.corrected_at AS "correctedAt",
    fc.card_category AS "cardCategory",fc.monthly_limit AS "monthlyLimit",
    obs.observation,obs.created_at AS "observationAt",obs.author AS "observationBy",
    coalesce(sum(ta.allocated_amount) FILTER(WHERE ta.workflow_status IN ('PENDING','APPROVED')),0) AS "allocatedAmount",
    ft.amount_incl_tax-coalesce(sum(ta.allocated_amount) FILTER(WHERE ta.workflow_status IN ('PENDING','APPROVED')),0) AS "remainingAmount",
    (array_agg(ta.id) FILTER(WHERE ta.workflow_status='PENDING'))[1] AS "pendingAllocationId",
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',detail.id,'beneficiary',coalesce(dr.full_name,db.display_name),'driverId',detail.driver_id,
      'vehicle',dv.registration_display,'mileage',detail.reported_mileage,
      'amount',detail.allocated_amount,'liters',detail.allocated_liters,'note',detail.note,'status',detail.workflow_status,
      'allocatedAt',detail.allocated_at) ORDER BY detail.allocated_at)
      FROM transaction_allocation detail
      JOIN beneficiary db ON db.id=detail.beneficiary_id
      LEFT JOIN driver dr ON dr.id=detail.driver_id
      JOIN vehicle dv ON dv.id=detail.vehicle_id
      WHERE detail.fuel_transaction_id=ft.id),'[]'::jsonb) AS allocations
    FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id JOIN company c ON c.id=fc.company_id
    LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id
    LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL
    LEFT JOIN transaction_import_batch tib ON tib.id=ft.import_batch_id
    LEFT JOIN transaction_allocation ta ON ta.fuel_transaction_id=ft.id
    LEFT JOIN LATERAL (SELECT tro.observation,tro.created_at,au.display_name AS author FROM transaction_observation tro
      JOIN app_user au ON au.id=tro.author_id WHERE tro.fuel_transaction_id=ft.id ORDER BY tro.created_at DESC LIMIT 1) obs ON true
    WHERE ft.deleted_at IS NULL AND ft.archived_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)
      AND ($3='' OR fc.company_id=$3::uuid)
    GROUP BY ft.id,fc.id,c.id,tib.source_filename,b.display_name,v.registration_display,d.full_name,v.driver_name,obs.observation,obs.created_at,obs.author
    ORDER BY ft.transaction_date DESC`, [actor.role==='NAJIB_ASSIGNER',actor.sub,companyId]);
    if (actor.role === 'NAJIB_ASSIGNER') {
      const pending = await this.db.query(`SELECT ('review:'||tr.id::text) AS id,tr.transaction_date AS date,
        tr.card_number AS card,fc.company_id AS "companyId",c.code AS "companyCode",tr.station,tr.product,tr.quantity_liters AS liters,tr.amount_incl_tax AS amount,
        tib.source_filename AS file,tr.beneficiary_name AS beneficiary,tr.vehicle_registration AS vehicle,
        null::timestamptz AS "correctedAt",fc.card_category AS "cardCategory",fc.monthly_limit AS "monthlyLimit",
        0::numeric AS "allocatedAmount",tr.amount_incl_tax AS "remainingAmount",null::uuid AS "pendingAllocationId",
        '[]'::jsonb AS allocations,tr.id AS "reviewId",tr.issue_type AS "reviewIssue",tr.status AS "reviewStatus"
        FROM transaction_review tr
        JOIN transaction_import_batch tib ON tib.id=tr.import_batch_id
        JOIN fuel_card fc ON fc.id=tr.fuel_card_id
        JOIN company c ON c.id=fc.company_id
        WHERE tr.status='PENDING' AND fc.responsible_user_id=$1 AND ($2='' OR fc.company_id=$2::uuid)
        ORDER BY tr.transaction_date DESC`, [actor.sub,companyId]);
      return [...pending,...transactions].sort((a:any,b:any)=>new Date(b.date).getTime()-new Date(a.date).getTime());
    }
    const pending = await this.db.query(`SELECT ('review:'||tr.id::text) AS id,tr.transaction_date AS date,
      tr.card_number AS card,coalesce(tr.company_id,fc.company_id) AS "companyId",c.code AS "companyCode",tr.station,tr.product,tr.quantity_liters AS liters,tr.amount_incl_tax AS amount,
      tib.source_filename AS file,tr.beneficiary_name AS beneficiary,tr.vehicle_registration AS vehicle,
      null::timestamptz AS "correctedAt",null::text AS "cardCategory",null::numeric AS "monthlyLimit",
      0::numeric AS "allocatedAmount",tr.amount_incl_tax AS "remainingAmount",null::uuid AS "pendingAllocationId",
      '[]'::jsonb AS allocations,tr.id AS "reviewId",tr.issue_type AS "reviewIssue",tr.status AS "reviewStatus"
      FROM transaction_review tr JOIN transaction_import_batch tib ON tib.id=tr.import_batch_id
      LEFT JOIN fuel_card fc ON fc.id=tr.fuel_card_id
      LEFT JOIN company c ON c.id=coalesce(tr.company_id,fc.company_id)
      WHERE tr.status='PENDING' AND ($1='' OR coalesce(tr.company_id,fc.company_id)=$1::uuid)
      ORDER BY tr.transaction_date DESC`,[companyId]);
    return [...pending,...transactions].sort((a:any,b:any)=>new Date(b.date).getTime()-new Date(a.date).getTime());
  }
  reviews(companyId='') { return this.db.query(`SELECT id,issue_type AS "issueType",status,
    right(regexp_replace(card_number,'[^0-9]','','g'),4) AS "cardNumber",
    vehicle_registration AS vehicle,beneficiary_name AS beneficiary,transaction_date AS date,station,product,quantity_liters AS liters,
    amount_incl_tax AS amount,created_at AS "createdAt" FROM transaction_review
    WHERE status='PENDING' AND ($1='' OR company_id=$1::uuid) ORDER BY created_at DESC`,[companyId]); }
  imports(companyId=''){return this.db.query(`SELECT tib.id,tib.source_filename AS filename,tib.imported_at AS "importedAt",tib.total_rows AS "totalRows",
    tib.imported_rows AS "importedRows",tib.duplicate_rows AS "duplicateRows",tib.rejected_rows AS "rejectedRows",tib.status,
    tib.reverted_at AS "revertedAt",tib.revert_reason AS "revertReason",u.display_name AS "importedBy",
    count(ft.id) FILTER(WHERE ft.deleted_at IS NULL)::int AS "activeTransactions"
    FROM transaction_import_batch tib LEFT JOIN app_user u ON u.id=tib.imported_by
    LEFT JOIN fuel_transaction ft ON ft.import_batch_id=tib.id
    WHERE ($1='' OR EXISTS(SELECT 1 FROM fuel_transaction scoped_ft JOIN fuel_card scoped_fc ON scoped_fc.id=scoped_ft.fuel_card_id
      WHERE scoped_ft.import_batch_id=tib.id AND scoped_fc.company_id=$1::uuid)
      OR EXISTS(SELECT 1 FROM transaction_review scoped_tr WHERE scoped_tr.import_batch_id=tib.id AND scoped_tr.company_id=$1::uuid))
    GROUP BY tib.id,u.display_name ORDER BY tib.imported_at DESC LIMIT 100`,[companyId]);}
  async revertImport(id:string,reason:string,actor:Actor){return this.db.transaction(async client=>{
    const batch=await client.query(`SELECT id,status,source_filename FROM transaction_import_batch WHERE id=$1 FOR UPDATE`,[id]);
    if(!batch.rows[0])throw new NotFoundException('Import introuvable');
    if(batch.rows[0].status==='REVERTED')throw new BadRequestException('Cet import est déjà annulé');
    const removed=await client.query(`UPDATE fuel_transaction SET deleted_at=now() WHERE import_batch_id=$1 AND deleted_at IS NULL RETURNING id`,[id]);
    await client.query(`UPDATE anomaly SET status='DISMISSED',resolved_at=now(),resolution=$2 WHERE fuel_transaction_id=ANY($1::uuid[]) AND status IN('OPEN','IN_REVIEW')`,[removed.rows.map((row:{id:string})=>row.id),`Import annulé : ${reason.trim()}`]);
    await client.query(`UPDATE transaction_import_batch SET status='REVERTED',reverted_at=now(),reverted_by=$2,revert_reason=$3 WHERE id=$1`,[id,actor.sub,reason.trim()]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'REVERT_IMPORT','transaction_import_batch',$2,$3)`,[actor.email,id,{reason:reason.trim(),transactions:removed.rowCount,filename:batch.rows[0].source_filename}]);
    return {id,reverted:true,transactions:removed.rowCount};
  });}
  async observe(id:string,observation:string,actor:{sub:string;email:string;role:string}){return this.db.transaction(async client=>{
    const found=await client.query(`SELECT ft.id,fc.masked_card_number FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.id=$1 AND ft.deleted_at IS NULL AND ($3<>'NAJIB_ASSIGNER' OR fc.responsible_user_id=$2)`,[id,actor.sub,actor.role]);
    if(!found.rows[0])throw new NotFoundException('Transaction introuvable dans votre périmètre');
    const created=await client.query(`INSERT INTO transaction_observation(fuel_transaction_id,author_id,observation) VALUES($1,$2,$3)
      RETURNING id,created_at AS "createdAt"`,[id,actor.sub,observation.trim()]);
    await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
      SELECT id,'Observation sur une transaction',$1,'WARNING','transactions','fuel_transaction',$2 FROM app_user
      WHERE active AND role IN('DIRECTION_GENERAL','SUPER_ADMIN')`,[`${found.rows[0].masked_card_number} — ${observation.trim()}`,id]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'OBSERVATION','fuel_transaction',$2,$3)`,[actor.email,id,{observation}]);
    return {...created.rows[0],observation:observation.trim()};
  });}
  async import(dto:{filename:string;rows:ImportRow[];replaceFrom?:string;companyId?:string},actor:Actor) { return this.db.transaction(async client => {
    if (!dto.rows.length) throw new BadRequestException('Le fichier ne contient aucune transaction');
    const batch = await client.query(`INSERT INTO transaction_import_batch(source_filename,source_sha256,imported_by,total_rows)
      VALUES($1,encode(digest($2 || clock_timestamp()::text,'sha256'),'hex'),$3,$4) RETURNING id`,[dto.filename,dto.filename,actor.sub,dto.rows.length]);
    let replaced=0;
    if(dto.replaceFrom){
      if(!dto.companyId) throw new BadRequestException('Société Total absente : remplacement des transactions annulé.');
      const archived=await client.query(`UPDATE fuel_transaction ft SET deleted_at=now(),deleted_by=$2
        FROM fuel_card fc WHERE ft.fuel_card_id=fc.id AND fc.company_id=$3::uuid
        AND ft.deleted_at IS NULL AND ft.transaction_date >= $1::date RETURNING ft.id`,[dto.replaceFrom,actor.sub,dto.companyId]);
      replaced=archived.rowCount??0;
      await client.query(`UPDATE transaction_review SET status='REJECTED',decided_by=$2,decided_at=now(),
        decision_reason='Remplacée par le nouvel instantané Total'
        WHERE status='PENDING' AND transaction_date >= $1::date
          AND (company_id=$3::uuid OR fuel_card_id IN (SELECT id FROM fuel_card WHERE company_id=$3::uuid))`,[dto.replaceFrom,actor.sub,dto.companyId]);
    }
    let imported=0,review=0,duplicates=0,verified=0,mismatches=0,unpriced=0;
    const rebuildResult=dto.companyId?await client.query<{pending:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM company c JOIN audit_log rebuild ON rebuild.entity_id='TOTAL_MOBILITY_CARDS:DC'
        AND rebuild.action='ARCHIVE_DC_CARDS_FOR_TOTAL_REEXTRACTION'
      WHERE c.id=$1::uuid AND c.code='DC' AND NOT EXISTS(
        SELECT 1 FROM audit_log imported WHERE imported.action='IMPORT_TOTAL_CARD_STATUSES'
          AND imported.new_values->>'company'='DC' AND imported.created_at>rebuild.created_at
          AND coalesce((imported.new_values->>'extracted')::int,0)=40
          AND coalesce((imported.new_values->>'limitsExtracted')::int,0)=40)
    ) pending`,[dto.companyId]):undefined;
    const officialCardRebuildPending=Boolean(rebuildResult?.rows[0]?.pending);
    for (let index=0;index<dto.rows.length;index++) {
      const row=dto.rows[index], cardKey=this.cardLast4(row.cardNumber);
      if (!cardKey) throw new BadRequestException(
        `Numéro du mode de paiement absent à la ligne ${index+2}. Import annulé : aucune consommation n'a été regroupée sur une carte inconnue.`,
      );
      row.station=String(row.station??'').trim();
      row.product=String(row.product??'').trim();
      if(!row.product) throw new BadRequestException(`Nom de produit absent à la ligne ${index+2}. Import annulé.`);
      if(!row.station) throw new BadRequestException(`Nom de la station absent à la ligne ${index+2}. Import annulé.`);
      let card=await client.query(`SELECT fc.id,fc.company_id,fc.masked_card_number,fc.official_card_number,fc.official_registration,fc.holder_name,fc.card_category,fc.reference_vehicle_id,fc.status,fc.responsible_user_id,
        (SELECT max(rr.returned_at) FROM card_return_receipt rr WHERE rr.fuel_card_id=fc.id) AS last_returned_at
        FROM fuel_card fc WHERE fc.deleted_at IS NULL AND ($2::uuid IS NULL OR fc.company_id=$2::uuid)
          AND (right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4)=$1
            OR right(regexp_replace(coalesce(fc.total_payment_number,''),'[^0-9]','','g'),4)=$1
            OR right(regexp_replace(coalesce(fc.official_card_number,''),'[^0-9]','','g'),4)=$1)
        ORDER BY
          (right(regexp_replace(coalesce(fc.total_payment_number,''),'[^0-9]','','g'),4)=$1) DESC,
          (nullif(trim(fc.holder_name),'') IS NOT NULL) DESC,
          (fc.reference_vehicle_id IS NOT NULL) DESC,
          (fc.status='ACTIVE') DESC,
          fc.updated_at DESC NULLS LAST,fc.created_at,fc.id
        LIMIT 1`,[cardKey,dto.companyId??null]);
      // Le journal de transactions Total est aussi une source officielle. Si
      // la carte manque du referentiel local mais que sa societe et son
      // vehicule sont identifies sans ambiguite, la creer immediatement au
      // lieu de bloquer sa consommation dans les controles manuels.
      if(!card.rows[0]&&!officialCardRebuildPending&&dto.companyId&&String(row.vehicle??'').trim()){
        const registrationKey=String(row.vehicle).toUpperCase().replace(/[^A-Z0-9]/g,'');
        const matchingVehicle=await client.query(`SELECT id,registration_display FROM vehicle
          WHERE company_id=$1::uuid AND active AND deleted_at IS NULL
            AND regexp_replace(upper(coalesce(registration_normalized::text,registration_display)),'[^A-Z0-9]','','g')=ANY($2::text[])
          ORDER BY updated_at DESC NULLS LAST,id LIMIT 1`,[dto.companyId,this.registrationKeys(registrationKey)]);
        if(matchingVehicle.rows[0]){
          card=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,
              monthly_limit,status,card_category,official_card_number,total_payment_number,official_registration,reference_vehicle_id)
            VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,0,'TO_ASSIGN','PERSONALIZED',$2,$2,$5,$6)
            ON CONFLICT(company_id,card_number_hmac) DO UPDATE SET deleted_at=NULL,official_registration=excluded.official_registration,
              reference_vehicle_id=excluded.reference_vehicle_id,updated_at=now()
            RETURNING id,company_id,masked_card_number,official_card_number,official_registration,holder_name,card_category,
              reference_vehicle_id,status,responsible_user_id`,[dto.companyId,cardKey,
              process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key',
              matchingVehicle.rows[0].registration_display,matchingVehicle.rows[0].id]);
        }
      }
      const fingerprint=this.transactionFingerprint(row,cardKey);
      if(!card.rows[0]) {
        const existingReview=await client.query(`SELECT id FROM transaction_review
          WHERE status='PENDING' AND company_id IS NOT DISTINCT FROM $7::uuid AND regexp_replace(card_number,'[^0-9]','','g')=$1::text AND transaction_date=$2::timestamptz AND upper(coalesce(station,''))=upper($3::text)
          AND upper(coalesce(product,''))=upper($4::text) AND quantity_liters=$5::numeric AND amount_incl_tax=$6::numeric LIMIT 1`,
        [cardKey,row.date,row.station,row.product,row.liters,row.amount,dto.companyId??null]);
        if(existingReview.rows[0]) { duplicates++; continue; }
        await client.query(`INSERT INTO transaction_review(import_batch_id,source_row_number,issue_type,card_number,vehicle_registration,
          beneficiary_name,transaction_date,station,product,quantity_liters,amount_incl_tax,previous_mileage,reported_mileage,authorization_code,company_id)
          VALUES($1,$2,'UNKNOWN_CARD',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [batch.rows[0].id,index+1,row.cardNumber,row.vehicle??null,row.beneficiary??null,row.date,row.station,row.product,row.liters,row.amount,row.previousMileage??null,row.mileage??null,row.authorizationCode??null,dto.companyId??null]);
        review++;
        continue;
      }
      // Le statut courant (coffre, suspendue, à affecter...) ne change pas
      // l'identité d'une carte. Dès que le suffixe est unique dans la société,
      // sa consommation Total doit être rattachée à cette carte. Les contrôles
      // de statut restent un workflow de gestion de carte séparé.
      // Certaines sociétés Total (notamment DCD) laissent la plaque vide dans
      // le rapport des transactions alors qu'elle existe dans le référentiel
      // de la carte. Cette valeur officielle est la source de repli fiable.
      const transactionVehicle=String(row.vehicle??'').trim();
      const officialVehicle=String(card.rows[0]?.official_registration??'').trim();
      const resolvedVehicle=/^(?:HORS\s*PARC|)$/i.test(transactionVehicle)
        ? officialVehicle : transactionVehicle;
      const vehicleKey=resolvedVehicle.toUpperCase().replace(/[^A-Z0-9]/g,'');
      const vehicleKeys=this.registrationKeys(vehicleKey);
      const unavailableVehicle=vehicleKey ? await client.query(`SELECT id FROM vehicle
        WHERE regexp_replace(upper(coalesce(registration_normalized::text,registration_display)),'[^A-Z0-9]','','g')=ANY($1::text[])
        AND ($2::uuid IS NULL OR company_id=$2::uuid)
        AND (NOT active OR deleted_at IS NOT NULL) LIMIT 1`,[vehicleKeys,dto.companyId??null]) : {rows:[]};
      let vehicle=vehicleKey ? await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name
        FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL AND d.active
        WHERE regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g')=ANY($1::text[])
        AND ($5::uuid IS NULL OR v.company_id=$5::uuid)
        AND v.active AND v.deleted_at IS NULL
        ORDER BY CASE WHEN v.company_id=$3::uuid THEN 0 ELSE 1 END,
          CASE WHEN regexp_replace(upper(coalesce(d.full_name,v.driver_name,'')),'[^A-Z0-9]','','g')=$4::text THEN 0 ELSE 1 END,
          CASE WHEN regexp_replace(upper(v.registration_display),'[^A-Z0-9]','','g')=$2::text THEN 0 ELSE 1 END LIMIT 1`,
        [vehicleKeys,vehicleKey,card.rows[0]?.company_id??null,String(row.beneficiary??card.rows[0]?.holder_name??'').toUpperCase().replace(/[^A-Z0-9]/g,''),dto.companyId??null]) : {rows:[]};
      const currentAssignment=card.rows[0]?await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name,
        ca.beneficiary_id,coalesce(b.display_name,fc.holder_name) AS beneficiary_name
        FROM fuel_card fc
        LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL AND ca.is_primary
        JOIN vehicle v ON v.id=coalesce(fc.reference_vehicle_id,ca.vehicle_id)
        LEFT JOIN driver d ON d.id=v.driver_id AND d.active AND d.deleted_at IS NULL
        LEFT JOIN beneficiary b ON b.id=ca.beneficiary_id
        WHERE fc.id=$1 AND v.company_id=fc.company_id
          AND v.active AND v.deleted_at IS NULL LIMIT 1`,[card.rows[0].id]):{rows:[]};
      // Une carte du référentiel possède déjà son affectation officielle. Elle
      // prime sur une plaque absente, mal espacée ou descriptive dans le fichier
      // Total (par exemple "C4").
      if(currentAssignment.rows[0]?.id) vehicle={rows:[currentAssignment.rows[0]]} as any;
      // Une vraie plaque Total absente du référentiel devient immédiatement un
      // véhicule de la société de la carte. Les libellés descriptifs comme
      // HORS PARC ou C4 restent exclus et suivent leur workflow dédié.
      if(!vehicle.rows[0]&&this.isVehicleRegistration(vehicleKey)){
        vehicle=await client.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,
          active,driver_name,total_mobility_status,total_mobility_checked_at,total_mobility_raw)
          VALUES($1::uuid,$2::text,$3::text,true,nullif($4::text,''),'DETECTED_FROM_TRANSACTION',now(),$5::jsonb)
          ON CONFLICT(company_id,registration_normalized) DO UPDATE SET
            registration_display=excluded.registration_display,active=true,deleted_at=NULL,deleted_by=NULL,
            driver_name=coalesce(nullif(excluded.driver_name,''),vehicle.driver_name),
            total_mobility_status='DETECTED_FROM_TRANSACTION',total_mobility_checked_at=now(),
            total_mobility_raw=excluded.total_mobility_raw,updated_at=now()
          RETURNING id,company_id,driver_name,null::text AS driver_full_name,registration_display`,
          [card.rows[0].company_id,vehicleKey,resolvedVehicle.toUpperCase(),String(row.beneficiary??'').trim(),
            {source:'TOTAL_TRANSACTION',cardNumber:cardKey,transactionDate:row.date}]);
      }
      const isOffPark=card.rows[0]?.card_category==='OFF_PARK' ||
        String(row.vehicle??card.rows[0]?.official_registration??'').toUpperCase().replace(/[\s-]/g,'')==='HORSPARC';
      // Le titulaire du référentiel prime sur le libellé libre de l'export.
      // Une redistribution (ex. carte Najib D-Max vers Malek Poseur) est créée
      // ensuite dans transaction_allocation et ne modifie jamais la carte.
      const beneficiaryName=(currentAssignment.rows[0]?.beneficiary_name??card.rows[0]?.holder_name??row.beneficiary??vehicle.rows[0]?.driver_full_name??vehicle.rows[0]?.driver_name??`Carte ${card.rows[0].masked_card_number}`).trim();
      // La société de la carte Total est la source d'autorité. Un véhicule
      // provenant d'une ancienne affectation erronée ne doit jamais déplacer
      // la transaction (et son kilométrage) vers une autre société.
      const companyId=dto.companyId??card.rows[0]?.company_id??vehicle.rows[0]?.company_id;
      if(vehicle.rows[0]&&companyId&&vehicle.rows[0].company_id!==companyId) vehicle={rows:[]} as any;
      // Les imports Total ciblés sont strictement isolés par société. Le
      // déplacement automatique d'une carte entre sociétés est réservé aux
      // imports manuels historiques sans companyId explicite.
      if(!dto.companyId&&card.rows[0]&&vehicle.rows[0]&&card.rows[0].company_id!==companyId) {
        await client.query(`UPDATE fuel_card SET company_id=$2,updated_at=now() WHERE id=$1`,[card.rows[0].id,companyId]);
        card.rows[0].company_id=companyId;
      }
      // Une carte connue doit toujours recevoir sa consommation. L'absence ou
      // l'indisponibilité du véhicule est une anomalie de gestion distincte :
      // elle ne remet pas l'opération Total en attente et ne laisse donc plus
      // le cumul de la carte à zéro.
      const issue=!companyId?'UNKNOWN_VEHICLE':null;
      if (issue) {
        await client.query(`INSERT INTO transaction_review(import_batch_id,source_row_number,issue_type,card_number,vehicle_registration,
          beneficiary_name,transaction_date,station,product,quantity_liters,amount_incl_tax,fuel_card_id,previous_mileage,reported_mileage,authorization_code,company_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [batch.rows[0].id,index+1,issue,row.cardNumber,row.vehicle??null,beneficiaryName||null,row.date,row.station??null,row.product??null,row.liters,row.amount,card.rows[0]?.id??null,row.previousMileage??null,row.mileage??null,row.authorizationCode??null,dto.companyId??companyId]); review++; continue;
      }
      const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Transactions importées') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[companyId]);
      const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3)
        ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[companyId,department.rows[0].id,beneficiaryName]);
      // L'import enregistre une consommation mais ne distribue pas une carte
      // en coffre et ne remplace pas son affectation de référence.
      if(!card.rows[0].reference_vehicle_id&&vehicle.rows[0]?.id) {
        const assignment=await client.query(`SELECT id FROM card_assignment WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1 FOR UPDATE`,[card.rows[0].id]);
        if(assignment.rows[0]) await client.query(`UPDATE card_assignment SET beneficiary_id=$2,vehicle_id=$3,
          workflow_status='APPROVED_ZIN',reviewed_by=$4,reviewed_at=now() WHERE id=$1`,[assignment.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,actor.sub]);
        else await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at)
          VALUES($1,$2,$3,'APPROVED_ZIN',$4,$4,now())`,[card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,actor.sub]);
      }
      const semanticDuplicate=await client.query(`SELECT id FROM fuel_transaction
        WHERE fuel_card_id=$1::uuid AND transaction_date=$2::timestamptz AND upper(coalesce(station,''))=upper($3::text)
          AND upper(coalesce(product,''))=upper($4::text) AND quantity_liters=$5::numeric AND amount_incl_tax=$6::numeric
          AND vehicle_id IS NOT DISTINCT FROM $7::uuid AND deleted_at IS NULL
          AND ($8::text IS NULL OR authorization_code=$8) LIMIT 1`,
      [card.rows[0].id,row.date,row.station,row.product,row.liters,row.amount,vehicle.rows[0]?.id??null,row.authorizationCode?.trim()||null]);
      if(semanticDuplicate.rows[0]) { duplicates++; continue; }
      // L'identifiant ne dépend jamais du nom du fichier ni du numéro de ligne.
      // Réimporter le même export (ou un export qui chevauche une période déjà
      // importée) retrouve donc exactement la même transaction.
      const external=`TOTAL:FP:${fingerprint}`;
      const inserted=await client.query(`INSERT INTO fuel_transaction(external_transaction_id,fuel_card_id,beneficiary_id,vehicle_id,transaction_date,station,product,
        quantity_liters,amount_incl_tax,source,import_batch_id,source_row_number,previous_mileage,reported_mileage,authorization_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'TOTAL_EXCEL',$10,$11,$12,$13,$14)
        ON CONFLICT(external_transaction_id,source) DO UPDATE SET
          fuel_card_id=excluded.fuel_card_id,beneficiary_id=excluded.beneficiary_id,vehicle_id=excluded.vehicle_id,
          transaction_date=excluded.transaction_date,station=excluded.station,product=excluded.product,
          quantity_liters=excluded.quantity_liters,amount_incl_tax=excluded.amount_incl_tax,
          import_batch_id=excluded.import_batch_id,source_row_number=excluded.source_row_number,
          previous_mileage=excluded.previous_mileage,reported_mileage=excluded.reported_mileage,
          authorization_code=excluded.authorization_code,deleted_at=null,deleted_by=null
        RETURNING id`,[external,card.rows[0].id,beneficiary.rows[0].id,vehicle.rows[0]?.id??null,row.date,row.station??null,row.product??null,row.liters,row.amount,batch.rows[0].id,index+1,row.previousMileage??null,row.mileage??null,row.authorizationCode??null]);
      if(inserted.rowCount){
        imported++;
        if(!vehicle.rows[0]&&!isOffPark){
          const anomalyType=unavailableVehicle.rows[0]?'UNAVAILABLE_VEHICLE':'UNKNOWN_VEHICLE';
          await client.query(`INSERT INTO anomaly(fuel_transaction_id,fuel_card_id,anomaly_type,severity,status,description,assigned_to,metadata)
            SELECT $1::uuid,$2::uuid,$3::text,'HIGH','OPEN',$4::text,$5::uuid,$6::jsonb
            WHERE NOT EXISTS(SELECT 1 FROM anomaly WHERE fuel_transaction_id=$1 AND anomaly_type=$3 AND status IN('OPEN','IN_REVIEW'))`,
            [inserted.rows[0].id,card.rows[0].id,anomalyType,
              `La consommation est affectée à la carte ${card.rows[0].masked_card_number}, mais le véhicule ${row.vehicle??'non renseigné'} doit être vérifié.`,
              card.rows[0].responsible_user_id??actor.sub,{vehicle:row.vehicle??null,cardPaymentNumber:cardKey}]);
        }
        if(vehicle.rows[0]?.id&&row.mileage!=null){
          const known=await client.query(`SELECT greatest(
            coalesce((SELECT max(mr.mileage) FROM mileage_reading mr WHERE mr.vehicle_id=$1
              AND mr.status='VALIDATED' AND mr.reading_date<$2),0),
            coalesce((SELECT max(ft.reported_mileage) FROM fuel_transaction ft WHERE ft.vehicle_id=$1
              AND ft.id<>$3 AND ft.deleted_at IS NULL AND ft.transaction_date<$2),0)
          )::float AS mileage`,[vehicle.rows[0].id,row.date,inserted.rows[0].id]);
          const previous=Math.max(Number(row.previousMileage??0),Number(known.rows[0]?.mileage??0));
          const reported=Number(row.mileage),liters=Number(row.liters);
          const rates=await client.query(`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY rate)::float AS rate FROM (
            SELECT 100*quantity_liters/(reported_mileage-previous_mileage) AS rate FROM fuel_transaction
            WHERE vehicle_id=$1 AND id<>$2 AND deleted_at IS NULL AND previous_mileage IS NOT NULL
              AND reported_mileage>previous_mileage AND 100*quantity_liters/(reported_mileage-previous_mileage) BETWEEN 2 AND 40) history`,[vehicle.rows[0].id,inserted.rows[0].id]);
          const reference=Number(rates.rows[0]?.rate??0)||10;
          const estimated=previous+100*liters/reference;
          const minimum=previous+100*liters/(reference*1.35),maximum=previous+100*liters/(reference*.65);
          const regressed=reported<previous;
          const implausible=previous>0&&liters>0&&(reported<minimum||reported>maximum);
          if(regressed||implausible){
            await client.query(`INSERT INTO anomaly(fuel_transaction_id,fuel_card_id,vehicle_id,anomaly_type,severity,status,description,assigned_to,metadata)
              SELECT $1::uuid,$2::uuid,$3::uuid,'MILEAGE_MISMATCH','HIGH','OPEN',$4::text,$5::uuid,$6::jsonb
              WHERE NOT EXISTS(SELECT 1 FROM anomaly WHERE fuel_transaction_id=$1 AND anomaly_type='MILEAGE_MISMATCH' AND status IN('OPEN','IN_REVIEW'))`,
              [inserted.rows[0].id,card.rows[0].id,vehicle.rows[0].id,
                regressed
                  ?`Kilométrage Total en régression : ${reported} km, dernier kilométrage connu ${previous} km.`
                  :`Kilométrage Total incohérent : ${reported} km, plage estimée ${minimum.toFixed(0)}–${maximum.toFixed(0)} km selon ${liters.toFixed(3)} L.`,
                card.rows[0].responsible_user_id??actor.sub,{reported,previous,estimated,minimum,maximum,liters}]);
          }else{
            await client.query(`UPDATE vehicle SET total_mobility_mileage=greatest(coalesce(total_mobility_mileage,0),$2),
              total_mobility_checked_at=now(),updated_at=now() WHERE id=$1`,[vehicle.rows[0].id,reported]);
            await client.query(`INSERT INTO mileage_reading(vehicle_id,beneficiary_id,reading_date,mileage,status,source,
              created_by,validated_by,validated_at,previous_mileage,expected_mileage,detected_distance,anomaly,
              period_liters,reference_liters_per_100km,estimated_distance,estimated_mileage,reconciliation_message)
              VALUES($1::uuid,$2::uuid,$3::timestamptz,$4::numeric,'VALIDATED','TOTAL_MOBILITY',$5::uuid,$5::uuid,now(),
                $6::numeric,$4::numeric,greatest(0::numeric,$4::numeric-$6::numeric),false,
                $7::numeric,$8::numeric,$9::numeric,$10::numeric,$11::text) ON CONFLICT DO NOTHING`,
              [vehicle.rows[0].id,beneficiary.rows[0].id,row.date,reported,actor.sub,previous,liters,reference,
                100*liters/reference,estimated,`Kilométrage ${reported} km validé depuis la transaction Total.`]);
            await client.query(`UPDATE anomaly SET status='RESOLVED',resolved_at=now(),resolution='Kilométrage Total cohérent validé'
              WHERE vehicle_id=$1 AND anomaly_type='MILEAGE_MISMATCH' AND status IN('OPEN','IN_REVIEW')
                AND fuel_transaction_id<>$2`,[vehicle.rows[0].id,inserted.rows[0].id]);
          }
          if((regressed||implausible)&&card.rows[0].responsible_user_id){
            await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
              SELECT $1,'Kilométrage véhicule à vérifier',$2,'HIGH','mileage','fuel_transaction',$3
              WHERE NOT EXISTS(SELECT 1 FROM notification WHERE user_id=$1 AND entity_type='fuel_transaction' AND entity_id=$3 AND title='Kilométrage véhicule à vérifier')`,
              [card.rows[0].responsible_user_id,`${vehicle.rows[0].registration_display??row.vehicle??'Véhicule'} : ${reported} km extraits, dernier KM ${previous}, estimation ${estimated.toFixed(0)} km (plage ${minimum.toFixed(0)}–${maximum.toFixed(0)}) selon ${liters.toFixed(3)} L. Kilométrage non conforme : veuillez contacter le chauffeur du véhicule.`,inserted.rows[0].id]);
          }
        }
        const canonicalProduct=this.canonicalFuelProduct(row.product);
        const applicablePrice=await client.query(`SELECT new_price,effective_date FROM fuel_price
          WHERE company_id=$1 AND upper(product)=upper($2) AND effective_date<=$3::date
          ORDER BY effective_date DESC,created_at DESC LIMIT 1`,[companyId,canonicalProduct,row.date]);
        if(applicablePrice.rows[0]){
          const unitPrice=Number(applicablePrice.rows[0].new_price);
          const expected=Math.round(Number(row.liters)*unitPrice*1000)/1000;
          const difference=Math.round((Number(row.amount)-expected)*1000)/1000;
          const tolerance=Math.max(.05,expected*.005);
          const billingStatus=Math.abs(difference)<=tolerance?'BILLING_OK':'BILLING_MISMATCH';
          await client.query(`UPDATE fuel_transaction SET unit_price=$2,expected_amount=$3,billing_difference=$4,
            validation_status=$5,billing_checked_at=now() WHERE id=$1`,[inserted.rows[0].id,unitPrice,expected,difference,billingStatus]);
          if(billingStatus==='BILLING_OK') verified++;
          else {
            mismatches++;
            const anomaly=await client.query(`INSERT INTO anomaly(fuel_transaction_id,fuel_card_id,vehicle_id,anomaly_type,severity,status,description,assigned_to)
              VALUES($1,$2,$3,'FUEL_BILLING_MISMATCH','HIGH','OPEN',$4,$5) RETURNING id`,[inserted.rows[0].id,card.rows[0].id,vehicle.rows[0]?.id??null,
              `Facturation Total incohérente : ${Number(row.liters).toFixed(3)} L × ${unitPrice.toFixed(3)} TND = ${expected.toFixed(3)} TND, montant facturé ${Number(row.amount).toFixed(3)} TND (écart ${difference.toFixed(3)} TND)`,actor.sub]);
            await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
              SELECT id,'Écart de facturation carburant',$1,'CRITICAL','anomalies','anomaly',$2 FROM app_user
              WHERE active AND role IN('ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN')`,[`${row.product} · carte ${row.cardNumber} · écart ${difference.toFixed(3)} TND`,anomaly.rows[0].id]);
          }
        } else {
          unpriced++;
          await client.query(`UPDATE fuel_transaction SET validation_status='PRICE_UNAVAILABLE',billing_checked_at=now() WHERE id=$1`,[inserted.rows[0].id]);
        }
        const monthUsage=await client.query(`SELECT coalesce(sum(amount_incl_tax),0)::float AS consumed FROM fuel_transaction
          WHERE fuel_card_id=$1 AND deleted_at IS NULL AND transaction_date>=date_trunc('month',$2::timestamptz)
          AND transaction_date<date_trunc('month',$2::timestamptz)+interval '1 month'`,[card.rows[0].id,row.date]);
        const limit=await client.query(`SELECT monthly_limit,masked_card_number,responsible_user_id FROM fuel_card WHERE id=$1`,[card.rows[0].id]);
        const usageRate=Number(limit.rows[0].monthly_limit)>0?100*Number(monthUsage.rows[0].consumed)/Number(limit.rows[0].monthly_limit):0;
        if(usageRate>=60&&limit.rows[0].responsible_user_id){
          await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
            SELECT $1,'Carte consommée à 60 %',$2,'WARNING','requests','fuel_card',$3
            WHERE NOT EXISTS(SELECT 1 FROM notification WHERE user_id=$1 AND title='Carte consommée à 60 %'
              AND entity_id=$3 AND created_at>=date_trunc('month',$4::timestamptz))`,[limit.rows[0].responsible_user_id,
            `La carte ${limit.rows[0].masked_card_number} a consommé ${usageRate.toFixed(1)} % de son plafond. Faites prochainement une demande d’alimentation pour éviter sa suspension.`,card.rows[0].id,row.date]);
        }
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
        } else {
          await client.query(`UPDATE anomaly SET status='RESOLVED',resolved_at=now(),
            resolution='Consommation mensuelle inférieure ou égale à 100 % du plafond'
            WHERE fuel_card_id=$1 AND anomaly_type='MONTHLY_LIMIT_EXCEEDED' AND status IN('OPEN','IN_REVIEW')`,[card.rows[0].id]);
        }
      } else duplicates++;
    }
    await client.query(`UPDATE transaction_import_batch SET imported_rows=$2,duplicate_rows=$3,rejected_rows=$4,
      status=CASE WHEN $4>0 THEN 'PARTIAL' ELSE 'COMPLETED' END,
      metadata=jsonb_build_object('verified',$5::int,'mismatches',$6::int,'unpriced',$7::int,'products',$8::int,'stations',$9::int)
      WHERE id=$1`,[batch.rows[0].id,imported,duplicates,review,verified,mismatches,unpriced,
      new Set(dto.rows.map(row=>row.product.toUpperCase())).size,new Set(dto.rows.map(row=>row.station.toUpperCase())).size]);
    if(review) await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
      SELECT id,'Transactions inconnues détectées',$2,'WARNING','anomalies','transaction_import_batch',$3 FROM app_user
      WHERE active AND role::text=ANY($1::text[])`,[['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],`${review} transaction(s) nécessitent la vérification d’une carte ou d’un véhicule`,batch.rows[0].id]);
    return {batchId:batch.rows[0].id,imported,duplicates,replaced,pendingReview:review,verified,mismatches,unpriced,
      products:new Set(dto.rows.map(row=>row.product.toUpperCase())).size,
      stations:new Set(dto.rows.map(row=>row.station.toUpperCase())).size};
  }); }
  async review(id:string,dto:{decision:'ACCEPTED'|'REJECTED';reason?:string;fuelCardId?:string;vehicleId?:string;newVehicleRegistration?:string;newVehicleType?:string;newVehicleCompanyId?:string;beneficiaryName?:string},actor:Actor) { return this.db.transaction(async client => {
    const found=await client.query(`SELECT * FROM transaction_review WHERE id=$1 AND status='PENDING' FOR UPDATE`,[id]);
    const row=found.rows[0]; if(!row) throw new NotFoundException('Contrôle introuvable ou déjà traité');
    if(dto.decision==='REJECTED') {
      await client.query(`INSERT INTO anomaly(fuel_card_id,anomaly_type,severity,status,description,assigned_to)
        VALUES($1,$2,'HIGH','OPEN',$3,$4)`,[row.fuel_card_id,row.issue_type,
          row.issue_type==='UNKNOWN_CARD'?`Carte ${row.card_number} absente de la base ayant effectué une transaction de ${row.amount_incl_tax}`:
          row.issue_type==='UNAVAILABLE_CARD'?`Carte ${row.card_number} indisponible ayant effectué une transaction de ${row.amount_incl_tax}`:
          row.issue_type==='MISSING_BENEFICIARY'?`Aucun bénéficiaire identifié pour le véhicule ${row.vehicle_registration}`:
          row.issue_type==='UNAVAILABLE_VEHICLE'?`Véhicule ${row.vehicle_registration} indisponible ayant effectué une transaction avec la carte ${row.card_number}`:
          `Véhicule ${row.vehicle_registration} absent de la base utilisant la carte ${row.card_number}`,actor.sub]);
    } else {
      const requestedRegistration=String(dto.newVehicleRegistration??row.vehicle_registration??'').trim();
      const vehicleKey=requestedRegistration.toUpperCase().replace(/[^A-Z0-9]/g,'');
      let vehicle=dto.vehicleId?await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name,v.registration_display
        FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL AND d.active
        WHERE v.id=$1 AND v.active AND v.deleted_at IS NULL`,[dto.vehicleId]):vehicleKey?await client.query(`SELECT v.id,v.company_id,v.driver_name,d.full_name AS driver_full_name,v.registration_display
        FROM vehicle v LEFT JOIN driver d ON d.id=v.driver_id AND d.deleted_at IS NULL AND d.active
        WHERE regexp_replace(upper(coalesce(v.registration_normalized::text,v.registration_display)),'[^A-Z0-9]','','g')=ANY($1::text[])
        AND v.active AND v.deleted_at IS NULL LIMIT 1`,[this.registrationKeys(vehicleKey)]):{rows:[]};
      if(!vehicle.rows[0]&&dto.newVehicleRegistration){
        if(['HORSPARC','C4','CITROENC4'].includes(vehicleKey))
          throw new BadRequestException('HORS PARC et CITROEN C4 ne sont pas des immatriculations. Saisissez une vraie plaque.');
        if(!dto.newVehicleCompanyId||!dto.newVehicleType?.trim())
          throw new BadRequestException('La société et le type du nouveau véhicule sont obligatoires.');
        const company=await client.query('SELECT id FROM company WHERE id=$1 AND active',[dto.newVehicleCompanyId]);
        if(!company.rows[0])throw new BadRequestException('Société introuvable ou inactive.');
        vehicle=await client.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,vehicle_type,model,driver_name,active)
          VALUES($1,$2,$3,$4,$4,$5,true)
          ON CONFLICT(company_id,registration_normalized) DO UPDATE SET active=true,vehicle_type=excluded.vehicle_type,
            driver_name=coalesce(nullif(excluded.driver_name,''),vehicle.driver_name),updated_at=now()
          RETURNING id,company_id,driver_name,null::text AS driver_full_name,registration_display`,
          [dto.newVehicleCompanyId,vehicleKey,dto.newVehicleRegistration.trim(),dto.newVehicleType.trim(),dto.beneficiaryName?.trim()??null]);
      }
      if(!vehicle.rows[0]) throw new BadRequestException('Sélectionnez un véhicule existant pour enregistrer cette transaction.');
      const companyId=vehicle.rows[0].company_id;
      const cardKey=this.cardLast4(String(row.card_number));
      if(!cardKey)throw new BadRequestException('Le moyen de paiement doit contenir au moins 4 chiffres.');
      let card=dto.fuelCardId?await client.query(`SELECT id,company_id,holder_name FROM fuel_card
        WHERE id=$1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,[dto.fuelCardId]):await client.query(`SELECT id,company_id,holder_name FROM fuel_card WHERE deleted_at IS NULL
          AND company_id=$2
          AND (right(regexp_replace(masked_card_number,'[^0-9]','','g'),4)=$1
            OR right(regexp_replace(coalesce(total_payment_number,''),'[^0-9]','','g'),4)=$1
            OR right(regexp_replace(coalesce(official_card_number,''),'[^0-9]','','g'),4)=$1)
          AND 1=(SELECT count(*) FROM fuel_card matching_card
            WHERE matching_card.deleted_at IS NULL AND matching_card.company_id=$2
              AND (right(regexp_replace(matching_card.masked_card_number,'[^0-9]','','g'),4)=$1
                OR right(regexp_replace(coalesce(matching_card.total_payment_number,''),'[^0-9]','','g'),4)=$1
                OR right(regexp_replace(coalesce(matching_card.official_card_number,''),'[^0-9]','','g'),4)=$1))
        LIMIT 1 FOR UPDATE`,[cardKey,companyId]);
      if(!card.rows[0]) card=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,monthly_limit,status,card_category)
        VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,0,'ACTIVE','PERSONALIZED')
        ON CONFLICT(company_id,card_number_hmac) DO UPDATE SET updated_at=now()
        RETURNING id,company_id`,[companyId,row.card_number,process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key']);
      // Le choix manuel de Zin devient la nouvelle reference pour les imports
      // suivants : carte, plaque et societe restent synchronisees.
      await client.query(`UPDATE fuel_card SET company_id=$2,official_registration=$3,
        card_category='PERSONALIZED',updated_at=now() WHERE id=$1`,[card.rows[0].id,companyId,vehicle.rows[0].registration_display]);
      const beneficiaryName=(dto.beneficiaryName??row.beneficiary_name??card.rows[0].holder_name??vehicle.rows[0].driver_full_name??vehicle.rows[0].driver_name??`Conducteur ${vehicle.rows[0].registration_display}`).trim();
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
      fc.company_id,fc.card_category FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.id=$1 AND ft.deleted_at IS NULL FOR UPDATE OF ft,fc`, [id]);
    const source = transaction.rows[0];
    if (!source) throw new NotFoundException('Transaction introuvable');
    if (source.card_category !== 'OFF_PARK' && source.responsible_user_id !== actor.sub)
      throw new NotFoundException('Cette transaction ne relève pas du workflow hors parc');
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) throw new BadRequestException('Le montant à répartir doit être positif');
    const allocationTotal = await client.query(`SELECT coalesce(sum(allocated_amount),0) AS allocated
      FROM transaction_allocation WHERE fuel_transaction_id=$1 AND workflow_status IN('PENDING','APPROVED')`, [id]);
    if (Number(allocationTotal.rows[0].allocated)+dto.amount > Number(source.amount_incl_tax)) throw new BadRequestException('La répartition dépasse le montant de la transaction Total');
    const target = await client.query(`SELECT v.id AS vehicle_id,v.company_id AS vehicle_company,v.registration_display
      FROM vehicle v WHERE v.id=$1 AND v.active AND v.deleted_at IS NULL
      AND (v.managed_by=$2 OR EXISTS(SELECT 1 FROM transaction_allocation own WHERE own.vehicle_id=v.id AND own.allocated_by=$2))`,[dto.vehicleId,actor.sub]);
    if(!target.rows[0])throw new BadRequestException('Sélectionnez un véhicule du parc de Najib');
    if(target.rows[0].vehicle_company!==source.company_id)
      throw new BadRequestException('Le véhicule doit appartenir à DC');
    const beneficiaryName=dto.beneficiaryName?.trim();
    if(!beneficiaryName)throw new BadRequestException('Le nom du bénéficiaire est obligatoire');
    const lastMileage=await client.query(`SELECT coalesce(max(mileage),0)::float AS mileage FROM mileage_reading
      WHERE vehicle_id=$1 AND status IN ('PENDING','VALIDATED')`,[dto.vehicleId]);
    if(!Number.isFinite(dto.mileage)||dto.mileage<Number(lastMileage.rows[0].mileage))
      throw new BadRequestException(`Le kilométrage réel doit être supérieur ou égal au dernier relevé (${Number(lastMileage.rows[0].mileage)} km)`);
    const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Sous-traitants poseurs') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[source.company_id]);
    const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET active=true,department_id=excluded.department_id RETURNING id`,[source.company_id,department.rows[0].id,beneficiaryName]);
    const result = await client.query(`INSERT INTO transaction_allocation(fuel_transaction_id,beneficiary_id,vehicle_id,driver_id,
      allocated_amount,allocated_liters,reported_mileage,note,allocated_by,workflow_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') RETURNING *`,
      [id,beneficiary.rows[0].id,dto.vehicleId,dto.driverId??null,dto.amount,dto.liters??null,dto.mileage,dto.note??null,actor.sub]);
    await client.query(`INSERT INTO mileage_reading(vehicle_id,beneficiary_id,reading_date,mileage,status,source,created_by,
      week_start,previous_mileage,expected_mileage,detected_distance,anomaly) VALUES($1,$2,now(),$3,'PENDING','TRANSACTION_ALLOCATION',$4,date_trunc('week',current_date)::date,$5,$3,0,false)`,
      [dto.vehicleId,beneficiary.rows[0].id,dto.mileage,actor.sub,Number(lastMileage.rows[0].mileage)]);
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
  async archive(id:string,actor:Actor){return this.db.transaction(async client=>{
    const result=await client.query(`UPDATE fuel_transaction SET archived_at=coalesce(archived_at,now()),archived_by=coalesce(archived_by,$2)
      WHERE id=$1 AND deleted_at IS NULL RETURNING id,archived_at`,[id,actor.sub]);
    if(!result.rows[0])throw new NotFoundException('Transaction introuvable');
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
      VALUES($1,'ARCHIVE','fuel_transaction',$2,$3)`,[actor.email,id,{archivedAt:result.rows[0].archived_at}]);
    return result.rows[0];
  });}
  async removeAll(actor: Actor) { return this.db.transaction(async client => {
    const result = await client.query('UPDATE fuel_transaction SET deleted_at=now(),deleted_by=$1 WHERE deleted_at IS NULL', [actor.sub]);
    const reviews = await client.query(`UPDATE transaction_review SET status='REJECTED',decided_by=$1,decided_at=now(),
      decision_reason='Suppression des transactions par Zin' WHERE status='PENDING'`, [actor.sub]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
      VALUES($1,'BATCH_SOFT_DELETE','fuel_transaction','ALL',$2)`, [actor.email,{count:result.rowCount,clearedReviews:reviews.rowCount}]);
    return { success: true, deleted: result.rowCount, clearedReviews: reviews.rowCount };
  }); }
}
