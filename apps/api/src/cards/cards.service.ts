import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

type UpdateCard = { status?: string; financeStatus?: string; monthlyLimit?: number; thresholdAlertEnabled?: boolean };
type CreateCard = { cardNumber: string; monthlyLimit: number; beneficiaryId?: string; vehicleId?: string; cardCategory?: 'PERSONALIZED'|'OFF_PARK';responsibleUserId?:string;companyId?:string };
type Actor = { sub: string; email: string; role: string };
@Injectable()
export class CardsService {
  constructor(private readonly db: DatabaseService) {}
  responsibles(companyId=''){return this.db.query(`SELECT u.id,u.display_name AS name,u.email,u.company_id AS "companyId",c.code AS company
    FROM app_user u LEFT JOIN company c ON c.id=u.company_id WHERE u.active AND u.role='NAJIB_ASSIGNER'
    AND ($1='' OR u.company_id=$1::uuid) ORDER BY c.code,u.display_name`,[companyId]);}
  companies(){return this.db.query(`SELECT id,code,name FROM company WHERE active ORDER BY code`);}
  async assignResponsible(id:string,responsibleUserId:string,actor:Actor){return this.db.transaction(async client=>{
    const responsible=await client.query(`SELECT id,display_name FROM app_user WHERE id=$1 AND active AND role='NAJIB_ASSIGNER'`,[responsibleUserId]);
    if(!responsible.rows[0])throw new BadRequestException('Responsable hors parc introuvable');
    const card=await client.query(`UPDATE fuel_card SET responsible_user_id=$2,card_category='OFF_PARK' WHERE id=$1 AND deleted_at IS NULL RETURNING id,masked_card_number`,[id,responsibleUserId]);
    if(!card.rows[0])throw new NotFoundException('Carte introuvable');
    await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) VALUES($1,'Carte hors parc attribuée',$2,'cards','fuel_card',$3)`,[responsibleUserId,`La carte ${card.rows[0].masked_card_number} vous a été attribuée`,id]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'ASSIGN_RESPONSIBLE','fuel_card',$2,$3)`,[actor.email,id,{responsibleUserId}]);return card.rows[0];});}
  async assignVehicle(id:string,dto:{beneficiary:string;vehicleId:string},actor:Actor){return this.db.transaction(async client=>{
    const card=await client.query(`SELECT id,company_id,masked_card_number FROM fuel_card WHERE id=$1 AND responsible_user_id=$2 AND deleted_at IS NULL FOR UPDATE`,[id,actor.sub]);if(!card.rows[0])throw new NotFoundException('Carte non attribuée à ce responsable');
    const vehicle=await client.query(`SELECT id,company_id,registration_display FROM vehicle WHERE id=$1 AND active AND deleted_at IS NULL`,[dto.vehicleId]);if(!vehicle.rows[0]||vehicle.rows[0].company_id!==card.rows[0].company_id)throw new BadRequestException('Le véhicule doit appartenir à la société de la carte');
    const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Hors parc') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[card.rows[0].company_id]);
    const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[card.rows[0].company_id,department.rows[0].id,dto.beneficiary.trim()]);
    await client.query(`UPDATE card_assignment SET ends_at=now() WHERE fuel_card_id=$1 AND ends_at IS NULL`,[id]);await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by) VALUES($1,$2,$3,'PENDING_ZIN',$4)`,[id,beneficiary.rows[0].id,dto.vehicleId,actor.sub]);await client.query(`UPDATE fuel_card SET status='ASSIGNED' WHERE id=$1`,[id]);
    await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) SELECT id,'Nouvelle affectation hors parc',$2,'cards','fuel_card',$3 FROM app_user WHERE active AND role::text=ANY($1::text[])`,[['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],`${card.rows[0].masked_card_number} → ${vehicle.rows[0].registration_display}`,id]);return {id,status:'ASSIGNED'};});}
  private author(role: string) {
    return role === 'ZIN_FINANCE' ? 'Zin' : role === 'DIRECTION_GENERAL' ? 'la Direction Générale' : role === 'NAJIB_ASSIGNER' ? 'le responsable hors parc' : 'le Super Admin';
  }
  private async notifyCompany(client: import('pg').PoolClient, companyId: string, actor: Actor,
    title: string, message: string, cardId: string, severity = 'INFO') {
    await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
      SELECT u.id,$3,$4,$5,'cards','fuel_card',$6 FROM app_user u
      WHERE u.active AND (u.company_id=$1 OR u.id=(SELECT responsible_user_id FROM fuel_card WHERE id=$6)) AND u.id<>$2
        AND u.role IN ('NAJIB_ASSIGNER','ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN')`,
      [companyId, actor.sub, title, message, severity, cardId]);
  }
  async create(dto: CreateCard, actorId: string, actor: string) {
    if (dto.vehicleId && !dto.beneficiaryId) throw new BadRequestException('Un véhicule doit être lié à un bénéficiaire');
    return this.db.transaction(async client => {
      const context = await client.query(`SELECT coalesce(selected.id,u.company_id) AS company_id,
        b.company_id AS beneficiary_company,v.company_id AS vehicle_company
        FROM app_user u LEFT JOIN beneficiary b ON b.id=$2 LEFT JOIN vehicle v ON v.id=$3 LEFT JOIN company selected ON selected.id=$4 AND selected.active
        WHERE u.id=$1`, [actorId,dto.beneficiaryId ?? null,dto.vehicleId ?? null,dto.companyId??null]);
      const row = context.rows[0];
      if (!row?.company_id) throw new BadRequestException('Société utilisateur introuvable');
      if (dto.beneficiaryId && !row.beneficiary_company) throw new BadRequestException('Bénéficiaire introuvable');
      if (dto.vehicleId && !row.vehicle_company) throw new BadRequestException('Véhicule introuvable');
      if ((row.beneficiary_company && row.beneficiary_company !== row.company_id) || (row.vehicle_company && row.vehicle_company !== row.company_id))
        throw new BadRequestException('La carte, le bénéficiaire et le véhicule doivent appartenir à la même société');
      const number = dto.cardNumber.trim();
      const responsible = await client.query(`SELECT id,company_id FROM app_user WHERE id=$1 AND role='NAJIB_ASSIGNER' AND active`, [dto.responsibleUserId??null]);
      if (!responsible.rows[0]) throw new BadRequestException('Le responsable de la carte est obligatoire');
      const responsibleUserId: string = responsible.rows[0].id;
      const inserted = await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,
        masked_card_number,monthly_limit,status,card_category,responsible_user_id) VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),
        hmac($2,$4,'sha256'),$2,$5,$6,$7,$8) RETURNING id`, [row.company_id,number,
        process.env.CARD_ENCRYPTION_KEY ?? 'delta-development-card-key',process.env.CARD_HMAC_KEY ?? 'delta-development-hmac-key',
        dto.monthlyLimit,dto.beneficiaryId ? 'ACTIVE' : 'TO_ASSIGN',dto.cardCategory ?? 'PERSONALIZED',responsibleUserId]);
      const cardId = inserted.rows[0].id;
      if (dto.beneficiaryId) await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,
        workflow_status,requested_by,reviewed_by,reviewed_at) VALUES($1,$2,$3,'APPROVED_ZIN',$4,$4,now())`,
        [cardId,dto.beneficiaryId,dto.vehicleId ?? null,actorId]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'CREATE','fuel_card',$2,$3)`, [actor,cardId,{beneficiaryId:dto.beneficiaryId,vehicleId:dto.vehicleId}]);
      const result = await client.query('SELECT * FROM v_fuel_card_list WHERE id=$1',[cardId]);
      return result.rows[0];
    });
  }
  async list(page: number, search: string, status: string, companyId:string, actor: { sub: string; role: string }) {
    const limit = 200, offset = (page - 1) * limit;
    const term = `%${search.trim()}%`;
    const where = `WHERE ($1='' OR masked_card_number ILIKE $2 OR beneficiary ILIKE $2 OR registration ILIKE $2)
      AND ($3='' OR status::text=$3)
      AND ($6::boolean=false OR responsible_user_id=$7) AND ($8='' OR company_id=$8::uuid)`;
    const items = await this.db.query(`SELECT v.*,
      coalesce((SELECT sum(ft.amount_incl_tax) FROM fuel_transaction ft
        WHERE ft.fuel_card_id=v.id AND ft.deleted_at IS NULL
          AND ft.transaction_date>=date_trunc('month',current_date)),0) AS consumed_amount,
      CASE WHEN v.monthly_limit > 0 THEN least(100,round(100 * coalesce((SELECT sum(ft.amount_incl_tax)
        FROM fuel_transaction ft WHERE ft.fuel_card_id=v.id AND ft.deleted_at IS NULL
          AND ft.transaction_date>=date_trunc('month',current_date)),0) / v.monthly_limit)) ELSE 0 END AS consumption_rate
      FROM v_fuel_card_list v ${where}
      ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [search.trim(), term, status, limit, offset, actor.role==='NAJIB_ASSIGNER', actor.sub,companyId]);
    const countWhere = `WHERE ($1='' OR masked_card_number ILIKE $2 OR beneficiary ILIKE $2 OR registration ILIKE $2)
      AND ($3='' OR status::text=$3)
      AND ($4::boolean=false OR responsible_user_id=$5) AND ($6='' OR company_id=$6::uuid)`;
    const [count] = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM v_fuel_card_list ${countWhere}`,
      [search.trim(), term, status, actor.role==='NAJIB_ASSIGNER', actor.sub,companyId]);
    return { items, total: count.total, page, pageSize: limit };
  }
  async details(id: string) {
    const rows = await this.db.query(`SELECT lc.*, fc.opposition_reason, fc.opposed_at,
      old.masked_card_number AS "oldCard", replacement.masked_card_number AS "replacementCard"
      FROM v_card_lifecycle lc JOIN fuel_card fc ON fc.id=lc.card_id
      LEFT JOIN fuel_card old ON old.id=fc.old_card_id
      LEFT JOIN fuel_card replacement ON replacement.id=fc.replacement_card_id
      WHERE lc.card_id=$1`, [id]);
    if (!rows[0]) throw new NotFoundException('Carte introuvable');
    return rows[0];
  }
  async replace(id: string, replacementId: string, reason: string, actor: Actor) {
    return this.db.transaction(async client => {
      const old = await client.query('SELECT * FROM fuel_card WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
      const replacement = await client.query('SELECT * FROM fuel_card WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [replacementId]);
      if (!old.rows[0] || !replacement.rows[0]) throw new NotFoundException('Carte source ou remplaçante introuvable');
      if (id === replacementId) throw new BadRequestException('Une carte ne peut pas se remplacer elle-même');
      if (old.rows[0].card_category === 'OFF_PARK') {
        const usage = await client.query(`SELECT coalesce(sum(amount_incl_tax),0) AS consumed
          FROM fuel_transaction WHERE fuel_card_id=$1 AND deleted_at IS NULL`, [id]);
        if (Number(usage.rows[0].consumed) < Number(old.rows[0].monthly_limit))
          throw new BadRequestException('La carte hors parc précédente doit atteindre 100 % de son plafond avant activation de la remplaçante');
      }
      await client.query(`UPDATE fuel_card SET status='REPLACED', replacement_card_id=$2,
        opposition_reason=$3, opposed_at=coalesce(opposed_at,now()), opposed_by=$4 WHERE id=$1`, [id,replacementId,reason,actor.sub]);
      await client.query(`UPDATE fuel_card SET old_card_id=$2 WHERE id=$1`, [replacementId,id]);
      const assignment = await client.query(`SELECT beneficiary_id,vehicle_id FROM card_assignment
        WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1`, [id]);
      if (assignment.rows[0]) {
        await client.query(`UPDATE card_assignment SET ends_at=now() WHERE fuel_card_id=$1 AND ends_at IS NULL`, [id]);
        await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [replacementId,assignment.rows[0].beneficiary_id,assignment.rows[0].vehicle_id]);
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'REPLACE','fuel_card',$2,$3)`, [actor.email,id,{replacementId,reason}]);
      await this.notifyCompany(client, old.rows[0].company_id, actor, 'Carte remplacée',
        `La carte ${old.rows[0].masked_card_number} a été remplacée par ${replacement.rows[0].masked_card_number} par ${this.author(actor.role)}.`, id, 'WARNING');
      return { success:true, oldCardId:id, replacementCardId:replacementId };
    });
  }
  async update(id: string, change: UpdateCard, actor: { sub: string; email: string; role: string }) {
    return this.db.transaction(async client => {
      const before = await client.query(`SELECT fc.id,fc.status,fc.monthly_limit,fc.threshold_alert_enabled,fc.version,
        fc.company_id,fc.responsible_user_id,fc.masked_card_number,
        (SELECT CASE ca.workflow_status WHEN 'APPROVED_ZIN' THEN 'CONFIRMED' WHEN 'REJECTED_ZIN' THEN 'REJECTED' ELSE 'PENDING' END
          FROM card_assignment ca WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL ORDER BY ca.starts_at DESC LIMIT 1) AS finance_status
        FROM fuel_card fc WHERE fc.id=$1 FOR UPDATE`, [id]);
      if (!before.rows[0]) throw new NotFoundException('Carte introuvable');
      const current = before.rows[0];
      const result = await client.query(`UPDATE fuel_card SET status=coalesce($2::card_status,status),
        monthly_limit=coalesce($3,monthly_limit), threshold_alert_enabled=coalesce($4,threshold_alert_enabled) WHERE id=$1
        RETURNING id,status,monthly_limit AS "monthlyLimit",
        threshold_alert_enabled AS "thresholdAlertEnabled",version,updated_at AS "updatedAt"`,
        [id, change.status ?? null, change.monthlyLimit ?? null, change.thresholdAlertEnabled ?? null]);
      if (change.financeStatus) {
        const workflow = change.financeStatus === 'CONFIRMED' ? 'APPROVED_ZIN' : change.financeStatus === 'REJECTED' ? 'REJECTED_ZIN' : 'PENDING_ZIN';
        await client.query(`UPDATE card_assignment SET workflow_status=$2,reviewed_by=$3,reviewed_at=now()
          WHERE fuel_card_id=$1 AND ends_at IS NULL`, [id, workflow, actor.sub]);
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,old_values,new_values)
        VALUES ($1,'UPDATE','fuel_card',$2,$3,$4)`, [actor.email, id, current, result.rows[0]]);
      if (change.status && change.status !== current.status) {
        const actionLabel: Record<string, string> = {
          SUSPENDED: 'bloquée', ACTIVE: 'débloquée et réactivée', DISTRIBUTED: 'marquée comme distribuée', OPPOSED: 'mise en opposition',
          LOST: 'déclarée perdue', STOLEN: 'déclarée volée', REPLACED: 'remplacée',
        };
        const label = actionLabel[change.status] ?? `passée au statut ${change.status}`;
        await this.notifyCompany(client, current.company_id, actor,
          change.status === 'SUSPENDED' ? 'Carte bloquée' : change.status === 'ACTIVE' ? 'Carte débloquée' : 'État de carte modifié',
          `La carte ${current.masked_card_number} a été ${label} par ${this.author(actor.role)}.`, id,
          ['SUSPENDED','OPPOSED','LOST','STOLEN'].includes(change.status) ? 'WARNING' : 'INFO');
      } else if (change.financeStatus && change.financeStatus !== current.finance_status) {
        const accepted = change.financeStatus === 'CONFIRMED';
        await this.notifyCompany(client, current.company_id, actor,
          accepted ? 'Affectation validée' : 'Affectation refusée',
          `L’affectation de la carte ${current.masked_card_number} a été ${accepted ? 'validée' : 'refusée'} par ${this.author(actor.role)}.`,
          id, accepted ? 'INFO' : 'WARNING');
      }
      return result.rows[0];
    });
  }
  async remove(id: string, actor: Actor) {
    return this.db.transaction(async client => {
      const before = await client.query(`SELECT status,replacement_card_id,company_id,masked_card_number FROM fuel_card WHERE id=$1 AND deleted_at IS NULL`, [id]);
      if (!before.rows[0]) throw new NotFoundException('Carte introuvable');
      if (['STOLEN','LOST','OPPOSED'].includes(before.rows[0].status) && !before.rows[0].replacement_card_id)
        throw new BadRequestException('Créez et liez la carte remplaçante avant d’archiver cette carte');
      const result = await client.query(`UPDATE fuel_card SET deleted_at=now(),deleted_by=$2
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id, actor.sub]);
      if (!result.rows[0]) throw new NotFoundException('Carte introuvable');
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES ($1,'SOFT_DELETE','fuel_card',$2,$3)`, [actor.email, id, { deleted: true }]);
      await this.notifyCompany(client, before.rows[0].company_id, actor, 'Carte archivée',
        `La carte ${before.rows[0].masked_card_number} a été archivée par ${this.author(actor.role)}. Elle n’est désormais plus disponible.`, id, 'WARNING');
      return { success: true };
    });
  }
}
