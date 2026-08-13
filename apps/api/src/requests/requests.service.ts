import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';

type Actor = { sub: string; email?: string; role?: string; companyId?: string };
type CreateRequest = { requestType: 'NEW_CARD'|'LIMIT_CHANGE'|'CARD_FUNDING'|'CUSTODY_CHANGE'; requestedCardStatus?:'SAFE'|'DISTRIBUTED'; fuelCardId?: string; sourceCardId?:string; beneficiary: string; department: string; vehicle: string; requestedLimit: number; reason: string };
@Injectable()
export class RequestsService {
  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}
  list(actor: Actor) {
    const ownOnly = actor.role === 'NAJIB_ASSIGNER';
    return this.db.query(`SELECT cr.id,cr.request_number AS "requestNumber",CASE WHEN cr.request_type='REACTIVATION' THEN 'CARD_FUNDING' ELSE cr.request_type::text END AS "requestType",cr.status,cr.requested_limit AS "requestedLimit",
      cr.reason,cr.decision_reason AS "decisionReason",cr.created_at AS "createdAt",cr.updated_at AS "updatedAt",cr.decision_date AS "decisionDate",cr.receipt_number AS "receiptNumber",cr.receipt_issued_at AS "receiptIssuedAt",
      b.display_name AS beneficiary,d.name AS department,v.registration_display AS vehicle,
      fc.masked_card_number AS "cardNumber",source.masked_card_number AS "sourceCardNumber",fc.monthly_limit AS "currentLimit", requester.role::text AS "requestedByRole",requester.display_name AS "requestedByName",
      approver.role::text AS "decisionByRole",approver.display_name AS "decisionByName",cr.requested_card_status AS "requestedCardStatus",
      (cr.zin_approved_at IS NOT NULL) AS "zinApproved",(cr.dg_approved_at IS NOT NULL) AS "dgApproved", latest.action AS "cardAction",
      latest.new_values->>'status' AS "cardStatusAction",latest.created_at AS "cardActionAt",
      action_user.role::text AS "cardActionByRole"
      FROM card_request cr JOIN beneficiary b ON b.id=cr.beneficiary_id
      LEFT JOIN department d ON d.id=b.department_id LEFT JOIN vehicle v ON v.id=cr.vehicle_id
      LEFT JOIN fuel_card fc ON fc.id=cr.fuel_card_id
      LEFT JOIN fuel_card source ON source.id=cr.source_card_id
      LEFT JOIN app_user requester ON requester.id=cr.requested_by
      LEFT JOIN app_user approver ON approver.id=cr.approved_by
      LEFT JOIN LATERAL (SELECT al.action,al.actor,al.new_values,al.created_at FROM audit_log al
        WHERE al.entity_type='fuel_card' AND al.entity_id=cr.fuel_card_id::text
        ORDER BY al.created_at DESC LIMIT 1) latest ON true
      LEFT JOIN app_user action_user ON lower(action_user.email::text)=lower(latest.actor)
      WHERE cr.archived_at IS NULL AND ($1::boolean=false OR cr.requested_by=$2) ORDER BY cr.created_at DESC`, [ownOnly, actor.sub]);
  }
  async archive(id: string, actor: Actor) {
    const row = await this.db.transaction(async client => {
      const result = await client.query(`UPDATE card_request SET archived_at=now(),archived_by=$2,updated_at=now()
        WHERE id=$1 AND archived_at IS NULL AND status IN ('APPROVED','REJECTED','CANCELLED')
        RETURNING id,request_number AS "requestNumber",archived_at AS "archivedAt"`, [id, actor.sub]);
      if (!result.rows[0]) throw new BadRequestException('Seule une demande déjà traitée peut être archivée');
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'ARCHIVE','card_request',$2,$3)`, [actor.email ?? actor.sub,id,{archivedAt:result.rows[0].archivedAt}]);
      return result.rows[0];
    });
    return row;
  }
  async create(dto: CreateRequest, actor: Actor) {
    if (dto.requestType === 'LIMIT_CHANGE' && !dto.fuelCardId) throw new BadRequestException('La carte concernée est obligatoire');
    if (dto.requestType === 'NEW_CARD' && !dto.fuelCardId) throw new BadRequestException('Choisissez une carte disponible en coffre');
    if (dto.requestType === 'CARD_FUNDING' && !dto.fuelCardId) throw new BadRequestException('Choisissez une carte disponible en coffre à alimenter');
    if (dto.requestType === 'CUSTODY_CHANGE' && (!dto.fuelCardId || !dto.requestedCardStatus)) throw new BadRequestException('La carte et son nouvel état sont obligatoires');
    const number = `D-${new Date().getFullYear()}-${Date.now().toString().slice(-7)}`;
    const row = await this.db.transaction(async client => {
      let companyId = actor.companyId;
      if (!companyId) {
        const company = await client.query('SELECT id FROM company WHERE active ORDER BY created_at LIMIT 1');
        companyId = company.rows[0]?.id;
      }
      if (!companyId) throw new BadRequestException('Aucune société active n’est configurée');
      const department = await client.query(`INSERT INTO department(company_id,name) VALUES($1,$2)
        ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`, [companyId,dto.department.trim()]);
      const beneficiary = await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name)
        VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET department_id=excluded.department_id,active=true
        RETURNING id`, [companyId,department.rows[0].id,dto.beneficiary.trim()]);
      const registration = dto.vehicle.trim();
      const normalized = registration.toUpperCase().replace(/[^A-Z0-9]/g,'');
      const vehicle = await client.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display)
        VALUES($1,$2,$3) ON CONFLICT(company_id,registration_normalized) DO UPDATE SET active=true
        RETURNING id`, [companyId,normalized,registration]);
      let fuelCardId: string | null = null;
      if (['NEW_CARD','CARD_FUNDING'].includes(dto.requestType)) {
        const exhausted=await client.query(`SELECT fc.masked_card_number FROM fuel_card fc WHERE fc.responsible_user_id=$1
          AND fc.deleted_at IS NULL AND fc.status NOT IN('SAFE','RETURNED') AND fc.monthly_limit>0
          AND 100*coalesce((SELECT sum(ft.amount_incl_tax) FROM fuel_transaction ft WHERE ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL AND ft.transaction_date>=date_trunc('month',current_date)),0)/fc.monthly_limit>=100`,[actor.sub]);
        if(exhausted.rows.length)throw new BadRequestException(`Restituez d’abord à Zin la ou les cartes ayant atteint 100 % : ${exhausted.rows.map(card=>card.masked_card_number).join(', ')}`);
      }
      if (dto.requestType === 'NEW_CARD') {
        const safe=await client.query(`SELECT id FROM fuel_card WHERE id=$1 AND status='SAFE' AND responsible_user_id IS NULL AND deleted_at IS NULL`,[dto.fuelCardId]);
        if(!safe.rows[0])throw new BadRequestException('Cette carte n’est plus disponible dans le coffre');
        fuelCardId=safe.rows[0].id;
      } else if (dto.requestType === 'LIMIT_CHANGE') {
        const card = await client.query(`SELECT id,monthly_limit FROM fuel_card WHERE id=$1
          AND responsible_user_id=$2 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.fuelCardId,actor.sub]);
        if (!card.rows[0]) throw new BadRequestException('Cette carte active n’est pas disponible pour ce responsable');
        if (dto.requestedLimit <= Number(card.rows[0].monthly_limit)) throw new BadRequestException('Le nouveau plafond doit être supérieur au plafond actuel');
        fuelCardId = card.rows[0].id;
      } else if(dto.requestType==='CARD_FUNDING') {
        const target=await client.query(`SELECT id FROM fuel_card WHERE id=$1 AND status='SAFE' AND responsible_user_id IS NULL AND deleted_at IS NULL`,[dto.fuelCardId]);
        if(!target.rows[0])throw new BadRequestException('La carte à alimenter doit être une carte disponible en coffre');
        fuelCardId=target.rows[0].id;
      } else if(dto.requestType==='CUSTODY_CHANGE') {
        const card=await client.query(`SELECT id,status,responsible_user_id FROM fuel_card WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[dto.fuelCardId]);
        if(!card.rows[0])throw new BadRequestException('Carte introuvable');
        if(dto.requestedCardStatus==='SAFE'&&card.rows[0].responsible_user_id!==actor.sub)throw new BadRequestException('Seule une carte sous votre responsabilité peut être remise en coffre');
        if(dto.requestedCardStatus==='DISTRIBUTED'&&card.rows[0].status!=='SAFE')throw new BadRequestException('Seule une carte en coffre peut être demandée pour distribution');
        fuelCardId=card.rows[0].id;
      }
      const inserted = await client.query(`INSERT INTO card_request(request_number,request_type,status,requested_by,
        beneficiary_id,vehicle_id,fuel_card_id,source_card_id,reason,requested_limit,requested_card_status) VALUES($1,$2,'SUBMITTED',$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id,request_number AS "requestNumber",status`,
        [number,dto.requestType==='CARD_FUNDING'?'REACTIVATION':dto.requestType==='CUSTODY_CHANGE'?'ASSIGNMENT_CHANGE':dto.requestType,actor.sub,beneficiary.rows[0].id,vehicle.rows[0].id,fuelCardId,dto.sourceCardId??null,dto.reason,dto.requestedLimit,dto.requestedCardStatus??null]);
      return inserted.rows[0];
    });
    await this.notifications.notifyRoles(['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'], dto.requestType === 'LIMIT_CHANGE' ? 'Demande d’augmentation de plafond' : dto.requestType==='CARD_FUNDING'?'Demande d’alimentation de carte':dto.requestType==='CUSTODY_CHANGE'?'Demande de changement coffre / distribution':'Nouvelle demande de carte', `${number} attend la double validation Zin et DG`, 'requests', 'card_request', row.id);
    return row;
  }
  async cancel(id: string, actor: Actor) {
    const row = await this.db.transaction(async client => {
      const result = await client.query(`SELECT cr.id,cr.request_number,cr.status,cr.requested_by,u.display_name FROM card_request cr JOIN app_user u ON u.id=cr.requested_by
        WHERE cr.id=$1 FOR UPDATE OF cr`, [id]);
      const request = result.rows[0];
      if (!request || request.requested_by !== actor.sub) {
        throw new NotFoundException('Demande introuvable');
      }
      if (!['SUBMITTED','UNDER_REVIEW'].includes(request.status)) {
        throw new BadRequestException('Seule une demande en attente peut être annulée');
      }
      const updated = await client.query(`UPDATE card_request SET status='CANCELLED'::request_status,
        decision_date=now(),decision_reason='Annulée par le responsable hors parc' WHERE id=$1
        RETURNING id,request_number AS "requestNumber",status,decision_reason AS "decisionReason"`, [id]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'CANCELLED','card_request',$2,$3)`, [actor.email ?? actor.sub,id,{reason:'Annulée par le demandeur'}]);
      return {...updated.rows[0],display_name:request.display_name};
    });
    await this.notifications.notifyRoles(['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],
      'Demande annulée', `${row.requestNumber} a été annulée par ${row.display_name}`, 'requests', 'card_request', row.id);
    return row;
  }
  async decide(id: string, dto: { decision: 'APPROVED'|'REJECTED'; reason?: string; cardNumber?: string }, actor: Actor) {
    if (dto.decision === 'REJECTED' && !dto.reason?.trim()) throw new BadRequestException('Le motif du refus est obligatoire');
    const row = await this.db.transaction(async client => {
      const requestResult = await client.query(`SELECT cr.*,b.company_id,fc.masked_card_number FROM card_request cr
        JOIN beneficiary b ON b.id=cr.beneficiary_id LEFT JOIN fuel_card fc ON fc.id=cr.fuel_card_id WHERE cr.id=$1 FOR UPDATE OF cr`, [id]);
      const request = requestResult.rows[0];
      if (!request || !['SUBMITTED','UNDER_REVIEW'].includes(request.status)) throw new NotFoundException('Demande introuvable ou déjà traitée');
      let fuelCardId: string | null = request.fuel_card_id;
      const doubleApproval=['ASSIGNMENT_CHANGE','REACTIVATION'].includes(request.request_type);
      if(doubleApproval&&dto.decision==='APPROVED'){
        if(request.request_type==='ASSIGNMENT_CHANGE'&&request.requested_card_status==='SAFE'&&actor.role==='SUPER_ADMIN')throw new BadRequestException('La restitution exige les validations personnelles de Zin et de la DG');
        if(actor.role==='ZIN_FINANCE'){
          if(request.zin_approved_at)throw new BadRequestException('Zin a déjà validé cette demande');
          await client.query(`UPDATE card_request SET zin_approved_by=$2,zin_approved_at=now(),status='UNDER_REVIEW' WHERE id=$1`,[id,actor.sub]);
          request.zin_approved_at=new Date();
        }else if(actor.role==='DIRECTION_GENERAL'){
          if(request.dg_approved_at)throw new BadRequestException('La DG a déjà validé cette demande');
          await client.query(`UPDATE card_request SET dg_approved_by=$2,dg_approved_at=now(),status='UNDER_REVIEW' WHERE id=$1`,[id,actor.sub]);
          request.dg_approved_at=new Date();
        }else{
          await client.query(`UPDATE card_request SET zin_approved_by=$2,zin_approved_at=now(),dg_approved_by=$2,dg_approved_at=now() WHERE id=$1`,[id,actor.sub]);
          request.zin_approved_at=request.dg_approved_at=new Date();
        }
        if(!request.zin_approved_at||!request.dg_approved_at){
          await this.notifications.notifyRoles(request.zin_approved_at?['DIRECTION_GENERAL']:['ZIN_FINANCE'],'Deuxième validation requise',`${request.request_number} attend encore votre autorisation`,'requests','card_request',id);
          return {id,status:'UNDER_REVIEW',fuelCardId,pendingSecondApproval:true};
        }
      }
      if (dto.decision === 'APPROVED' && request.request_type === 'NEW_CARD') {
        const assigned=await client.query(`UPDATE fuel_card SET monthly_limit=$2,status='DISTRIBUTED',card_category='OFF_PARK',responsible_user_id=$3 WHERE id=$1 AND status='SAFE' AND responsible_user_id IS NULL RETURNING id`,[request.fuel_card_id,request.requested_limit,request.requested_by]);
        if(!assigned.rows[0])throw new BadRequestException('La carte choisie n’est plus disponible en coffre');
        fuelCardId=assigned.rows[0].id;
        await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,
          requested_by,reviewed_by,reviewed_at) VALUES($1,$2,$3,'APPROVED_ZIN',$4,$5,now())`,
          [fuelCardId,request.beneficiary_id,request.vehicle_id,request.requested_by,actor.sub]);
      } else if (dto.decision === 'APPROVED' && request.request_type === 'LIMIT_CHANGE') {
        const changed = await client.query(`UPDATE fuel_card SET monthly_limit=$2 WHERE id=$1 AND deleted_at IS NULL
          RETURNING id,masked_card_number`, [request.fuel_card_id,request.requested_limit]);
        if (!changed.rows[0]) throw new BadRequestException('La carte concernée n’est plus disponible');
        await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
          VALUES($1,'LIMIT_CHANGE','fuel_card',$2,$3)`, [actor.email ?? actor.sub,request.fuel_card_id,{monthlyLimit:request.requested_limit}]);
      } else if(dto.decision==='APPROVED'&&request.request_type==='REACTIVATION') {
        const funded=await client.query(`UPDATE fuel_card SET monthly_limit=$2,status='DISTRIBUTED',card_category='OFF_PARK',responsible_user_id=$3 WHERE id=$1 AND status='SAFE' AND responsible_user_id IS NULL AND deleted_at IS NULL RETURNING masked_card_number`,[request.fuel_card_id,request.requested_limit,request.requested_by]);
        if(!funded.rows[0])throw new BadRequestException('La carte à alimenter n’est plus disponible');
        await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at) VALUES($1,$2,$3,'APPROVED_ZIN',$4,$5,now())`,[request.fuel_card_id,request.beneficiary_id,request.vehicle_id,request.requested_by,actor.sub]);
        await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'CARD_FUNDING','fuel_card',$2,$3)`,[actor.email??actor.sub,request.fuel_card_id,{amount:request.requested_limit,sourceCardId:request.source_card_id}]);
      } else if(dto.decision==='APPROVED'&&request.request_type==='ASSIGNMENT_CHANGE') {
        if(request.requested_card_status==='SAFE'){
          const usage=await client.query(`SELECT fc.monthly_limit,fc.masked_card_number,coalesce(sum(ft.amount_incl_tax),0) AS consumed,
            coalesce(sum(ft.quantity_liters),0) AS liters,count(ft.id)::int AS transaction_count,
            100*coalesce(sum(ft.amount_incl_tax),0)/nullif(fc.monthly_limit,0) AS rate
            FROM fuel_card fc LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL
              AND ft.transaction_date>=date_trunc('month',current_date) AND ft.transaction_date<date_trunc('month',current_date)+interval '1 month'
            WHERE fc.id=$1 GROUP BY fc.id`,[request.fuel_card_id]);
          const rate=Number(usage.rows[0]?.rate??0);if(rate<100)throw new BadRequestException(`La carte ${usage.rows[0]?.masked_card_number} ne peut être restituée qu’après utilisation de 100 % de son plafond (${rate.toFixed(1)} % actuellement)`);
          await client.query(`UPDATE fuel_card SET status='SAFE',responsible_user_id=NULL WHERE id=$1`,[request.fuel_card_id]);
          await client.query(`UPDATE card_assignment SET ends_at=now() WHERE fuel_card_id=$1 AND ends_at IS NULL`,[request.fuel_card_id]);
          const zinReceiver=request.zin_approved_by??(actor.role==='ZIN_FINANCE'?actor.sub:null);if(!zinReceiver)throw new BadRequestException('La réception de la carte doit être validée par Zin');
          const receiptValues=[`RES-${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${request.request_number.replace(/\D/g,'').slice(-10)}`,id,request.fuel_card_id,request.requested_by,zinReceiver,rate];
          await client.query(`INSERT INTO card_return_receipt(receipt_number,card_request_id,fuel_card_id,returned_by,received_by,consumption_rate,consumption_month)
            VALUES($1,$2,$3,$4,$5,least(100,$6::numeric),date_trunc('month',current_date)::date)
            ON CONFLICT(card_request_id) DO UPDATE SET received_by=excluded.received_by`,receiptValues);
          // Les colonnes de preuve ont été ajoutées après le workflow initial.
          // Les remplir séparément garde la validation compatible pendant un
          // déploiement progressif où l'API et la migration ne démarrent pas au
          // même instant.
          const proofColumns=await client.query(`SELECT count(*)::int AS count FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='card_return_receipt'
              AND column_name=ANY($1::text[])`,[['monthly_limit','consumed_amount','consumed_liters','transaction_count']]);
          if(Number(proofColumns.rows[0]?.count)===4){
            await client.query(`UPDATE card_return_receipt SET monthly_limit=$2,consumed_amount=$3,consumed_liters=$4,transaction_count=$5
              WHERE card_request_id=$1`,[id,Number(usage.rows[0]?.monthly_limit??0),Number(usage.rows[0]?.consumed??0),Number(usage.rows[0]?.liters??0),Number(usage.rows[0]?.transaction_count??0)]);
          }
        }else{
          await client.query(`UPDATE fuel_card SET status='DISTRIBUTED',responsible_user_id=$2,card_category='OFF_PARK' WHERE id=$1`,[request.fuel_card_id,request.requested_by]);
        }
        await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'CUSTODY_CHANGE','fuel_card',$2,$3)`,[actor.email??actor.sub,request.fuel_card_id,{status:request.requested_card_status,responsibleUserId:request.requested_card_status==='DISTRIBUTED'?request.requested_by:null}]);
      }
      const receiptNumber=dto.decision==='APPROVED'?`RC-${new Date().getFullYear()}-${request.request_number.replace(/\D/g,'').slice(-10)}`:null;
      const updated = await client.query(`UPDATE card_request SET status=$2::request_status,approved_by=$3,
        decision_date=now(),decision_reason=$4,fuel_card_id=coalesce($5,fuel_card_id),receipt_number=$6,receipt_issued_at=CASE WHEN $6 IS NULL THEN NULL ELSE now() END WHERE id=$1
        RETURNING id,status,fuel_card_id AS "fuelCardId",decision_reason AS "decisionReason",receipt_number AS "receiptNumber",receipt_issued_at AS "receiptIssuedAt"`,
        [id,dto.decision,actor.sub,dto.reason ?? null,fuelCardId,receiptNumber]);
      const author = actor.role === 'ZIN_FINANCE' ? 'Zin' : actor.role === 'DIRECTION_GENERAL' ? 'la Direction Générale' : 'le Super Admin';
      await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id)
        VALUES($1,$2,$3,$4,'card_request',$5)`, [request.requested_by,
        dto.decision === 'APPROVED' ? (request.request_type === 'LIMIT_CHANGE' ? 'Augmentation de plafond validée' : request.request_type==='REACTIVATION'?'Alimentation de carte validée':'Carte créée et demande validée') : 'Demande refusée',
        dto.decision === 'APPROVED' ? (request.request_type === 'LIMIT_CHANGE' ? `Le plafond de votre carte a été porté à ${request.requested_limit} par ${author}` : request.request_type==='REACTIVATION'?`Votre carte a été alimentée à hauteur de ${request.requested_limit} par ${author}`:`La carte ${request.masked_card_number} est active et affectée par ${author}`) : `${dto.reason} — décision par ${author}`,
        dto.decision === 'APPROVED' ? 'cards' : 'requests',id]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,$2,'card_request',$3,$4)`, [actor.email ?? actor.sub,dto.decision,id,{fuelCardId,cardNumber:dto.cardNumber,reason:dto.reason}]);
      return updated.rows[0];
    });
    return row;
  }
}
