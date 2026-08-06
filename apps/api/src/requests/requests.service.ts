import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';

type Actor = { sub: string; email?: string; role?: string; companyId?: string };
type CreateRequest = { requestType: 'NEW_CARD'|'LIMIT_CHANGE'; fuelCardId?: string; beneficiary: string; department: string; vehicle: string; requestedLimit: number; reason: string };
@Injectable()
export class RequestsService {
  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}
  list(actor: Actor) {
    const ownOnly = actor.role === 'NAJIB_ASSIGNER';
    return this.db.query(`SELECT cr.id,cr.request_number AS "requestNumber",cr.request_type AS "requestType",cr.status,cr.requested_limit AS "requestedLimit",
      cr.reason,cr.decision_reason AS "decisionReason",cr.created_at AS "createdAt",cr.decision_date AS "decisionDate",
      b.display_name AS beneficiary,d.name AS department,v.registration_display AS vehicle,
      fc.masked_card_number AS "cardNumber",fc.monthly_limit AS "currentLimit", requester.role::text AS "requestedByRole",
      approver.role::text AS "decisionByRole", latest.action AS "cardAction",
      latest.new_values->>'status' AS "cardStatusAction",latest.created_at AS "cardActionAt",
      action_user.role::text AS "cardActionByRole"
      FROM card_request cr JOIN beneficiary b ON b.id=cr.beneficiary_id
      LEFT JOIN department d ON d.id=b.department_id LEFT JOIN vehicle v ON v.id=cr.vehicle_id
      LEFT JOIN fuel_card fc ON fc.id=cr.fuel_card_id
      LEFT JOIN app_user requester ON requester.id=cr.requested_by
      LEFT JOIN app_user approver ON approver.id=cr.approved_by
      LEFT JOIN LATERAL (SELECT al.action,al.actor,al.new_values,al.created_at FROM audit_log al
        WHERE al.entity_type='fuel_card' AND al.entity_id=cr.fuel_card_id::text
        ORDER BY al.created_at DESC LIMIT 1) latest ON true
      LEFT JOIN app_user action_user ON lower(action_user.email::text)=lower(latest.actor)
      WHERE ($1::boolean=false OR cr.requested_by=$2) ORDER BY cr.created_at DESC`, [ownOnly, actor.sub]);
  }
  async create(dto: CreateRequest, actor: Actor) {
    if (dto.requestType === 'LIMIT_CHANGE' && !dto.fuelCardId) throw new BadRequestException('La carte concernée est obligatoire');
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
      if (dto.requestType === 'LIMIT_CHANGE') {
        const card = await client.query(`SELECT id,monthly_limit FROM fuel_card WHERE id=$1 AND company_id=$2
          AND responsible_user_id=$3 AND status='ACTIVE' AND deleted_at IS NULL`, [dto.fuelCardId,companyId,actor.sub]);
        if (!card.rows[0]) throw new BadRequestException('Cette carte active n’est pas disponible pour Najib');
        if (dto.requestedLimit <= Number(card.rows[0].monthly_limit)) throw new BadRequestException('Le nouveau plafond doit être supérieur au plafond actuel');
        fuelCardId = card.rows[0].id;
      }
      const inserted = await client.query(`INSERT INTO card_request(request_number,request_type,status,requested_by,
        beneficiary_id,vehicle_id,fuel_card_id,reason,requested_limit) VALUES($1,$2,'SUBMITTED',$3,$4,$5,$6,$7,$8)
        RETURNING id,request_number AS "requestNumber",status`,
        [number,dto.requestType,actor.sub,beneficiary.rows[0].id,vehicle.rows[0].id,fuelCardId,dto.reason,dto.requestedLimit]);
      return inserted.rows[0];
    });
    await this.notifications.notifyRoles(['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'], dto.requestType === 'LIMIT_CHANGE' ? 'Demande d’augmentation de plafond' : 'Nouvelle demande de carte', `${number} attend votre traitement`, 'requests', 'card_request', row.id);
    return row;
  }
  async cancel(id: string, actor: Actor) {
    const row = await this.db.transaction(async client => {
      const result = await client.query(`SELECT id,request_number,status,requested_by FROM card_request
        WHERE id=$1 FOR UPDATE`, [id]);
      const request = result.rows[0];
      if (!request || request.requested_by !== actor.sub) {
        throw new NotFoundException('Demande introuvable');
      }
      if (!['SUBMITTED','UNDER_REVIEW'].includes(request.status)) {
        throw new BadRequestException('Seule une demande en attente peut être annulée');
      }
      const updated = await client.query(`UPDATE card_request SET status='CANCELLED'::request_status,
        decision_date=now(),decision_reason='Annulée par Najib' WHERE id=$1
        RETURNING id,request_number AS "requestNumber",status,decision_reason AS "decisionReason"`, [id]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'CANCELLED','card_request',$2,$3)`, [actor.email ?? actor.sub,id,{reason:'Annulée par le demandeur'}]);
      return updated.rows[0];
    });
    await this.notifications.notifyRoles(['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],
      'Demande annulée', `${row.requestNumber} a été annulée par Najib`, 'requests', 'card_request', row.id);
    return row;
  }
  async decide(id: string, dto: { decision: 'APPROVED'|'REJECTED'; reason?: string; cardNumber?: string }, actor: Actor) {
    if (dto.decision === 'REJECTED' && !dto.reason?.trim()) throw new BadRequestException('Le motif du refus est obligatoire');
    const row = await this.db.transaction(async client => {
      const requestResult = await client.query(`SELECT cr.*,b.company_id FROM card_request cr
        JOIN beneficiary b ON b.id=cr.beneficiary_id WHERE cr.id=$1 FOR UPDATE`, [id]);
      const request = requestResult.rows[0];
      if (!request || !['SUBMITTED','UNDER_REVIEW'].includes(request.status)) throw new NotFoundException('Demande introuvable ou déjà traitée');
      if (dto.decision === 'APPROVED' && request.request_type === 'NEW_CARD' && !dto.cardNumber?.trim()) throw new BadRequestException('Le numéro de la carte attribuée est obligatoire');
      let fuelCardId: string | null = request.fuel_card_id;
      if (dto.decision === 'APPROVED' && request.request_type === 'NEW_CARD') {
        const number = dto.cardNumber!.trim();
        const inserted = await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,
          masked_card_number,monthly_limit,status,card_category,responsible_user_id) VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),
          hmac($2,$4,'sha256'),$2,$5,'ACTIVE','OFF_PARK',$6) RETURNING id`, [request.company_id, number,
          process.env.CARD_ENCRYPTION_KEY ?? 'delta-development-card-key', process.env.CARD_HMAC_KEY ?? 'delta-development-hmac-key', request.requested_limit ?? 0, request.requested_by]);
        fuelCardId = inserted.rows[0].id;
        await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,
          requested_by,reviewed_by,reviewed_at) VALUES($1,$2,$3,'APPROVED_ZIN',$4,$5,now())`,
          [fuelCardId,request.beneficiary_id,request.vehicle_id,request.requested_by,actor.sub]);
      } else if (dto.decision === 'APPROVED' && request.request_type === 'LIMIT_CHANGE') {
        const changed = await client.query(`UPDATE fuel_card SET monthly_limit=$2 WHERE id=$1 AND deleted_at IS NULL
          RETURNING id,masked_card_number`, [request.fuel_card_id,request.requested_limit]);
        if (!changed.rows[0]) throw new BadRequestException('La carte concernée n’est plus disponible');
        await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
          VALUES($1,'LIMIT_CHANGE','fuel_card',$2,$3)`, [actor.email ?? actor.sub,request.fuel_card_id,{monthlyLimit:request.requested_limit}]);
      }
      const updated = await client.query(`UPDATE card_request SET status=$2::request_status,approved_by=$3,
        decision_date=now(),decision_reason=$4,fuel_card_id=coalesce($5,fuel_card_id) WHERE id=$1
        RETURNING id,status,fuel_card_id AS "fuelCardId",decision_reason AS "decisionReason"`,
        [id,dto.decision,actor.sub,dto.reason ?? null,fuelCardId]);
      const author = actor.role === 'ZIN_FINANCE' ? 'Zin' : actor.role === 'DIRECTION_GENERAL' ? 'la Direction Générale' : 'le Super Admin';
      await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id)
        VALUES($1,$2,$3,$4,'card_request',$5)`, [request.requested_by,
        dto.decision === 'APPROVED' ? (request.request_type === 'LIMIT_CHANGE' ? 'Augmentation de plafond validée' : 'Carte créée et demande validée') : 'Demande refusée',
        dto.decision === 'APPROVED' ? (request.request_type === 'LIMIT_CHANGE' ? `Le plafond de votre carte a été porté à ${request.requested_limit} par ${author}` : `La carte ${dto.cardNumber} est active et affectée par ${author}`) : `${dto.reason} — décision par ${author}`,
        dto.decision === 'APPROVED' ? 'cards' : 'requests',id]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,$2,'card_request',$3,$4)`, [actor.email ?? actor.sub,dto.decision,id,{fuelCardId,cardNumber:dto.cardNumber,reason:dto.reason}]);
      return updated.rows[0];
    });
    return row;
  }
}
