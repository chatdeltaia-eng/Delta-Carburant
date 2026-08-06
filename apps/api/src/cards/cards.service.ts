import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

type UpdateCard = { status?: string; monthlyLimit?: number; thresholdAlertEnabled?: boolean };
type CreateCard = { cardNumber: string; monthlyLimit: number; beneficiaryId?: string; vehicleId?: string; cardCategory?: 'PERSONALIZED'|'OFF_PARK' };
@Injectable()
export class CardsService {
  constructor(private readonly db: DatabaseService) {}
  async create(dto: CreateCard, actorId: string, actor: string) {
    if (dto.vehicleId && !dto.beneficiaryId) throw new BadRequestException('Un véhicule doit être lié à un bénéficiaire');
    return this.db.transaction(async client => {
      const context = await client.query(`SELECT u.company_id,
        b.company_id AS beneficiary_company,v.company_id AS vehicle_company
        FROM app_user u LEFT JOIN beneficiary b ON b.id=$2 LEFT JOIN vehicle v ON v.id=$3
        WHERE u.id=$1`, [actorId,dto.beneficiaryId ?? null,dto.vehicleId ?? null]);
      const row = context.rows[0];
      if (!row?.company_id) throw new BadRequestException('Société utilisateur introuvable');
      if (dto.beneficiaryId && !row.beneficiary_company) throw new BadRequestException('Bénéficiaire introuvable');
      if (dto.vehicleId && !row.vehicle_company) throw new BadRequestException('Véhicule introuvable');
      if ((row.beneficiary_company && row.beneficiary_company !== row.company_id) || (row.vehicle_company && row.vehicle_company !== row.company_id))
        throw new BadRequestException('La carte, le bénéficiaire et le véhicule doivent appartenir à la même société');
      const number = dto.cardNumber.trim();
      let responsibleUserId: string | null = null;
      if (dto.cardCategory === 'OFF_PARK') {
        const responsible = await client.query(`SELECT id FROM app_user WHERE company_id=$1 AND role='NAJIB_ASSIGNER' AND active LIMIT 1`, [row.company_id]);
        if (!responsible.rows[0]) throw new BadRequestException('Aucun responsable Najib actif pour cette société');
        responsibleUserId = responsible.rows[0].id;
      }
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
  async list(page: number, search: string, status: string, actor: { sub: string; role: string }) {
    const limit = 20, offset = (page - 1) * limit;
    const term = `%${search.trim()}%`;
    const where = `WHERE ($1='' OR masked_card_number ILIKE $2 OR beneficiary ILIKE $2 OR registration ILIKE $2)
      AND ($3='' OR status::text=$3)
      AND ($6::boolean=false OR (card_category='OFF_PARK' AND responsible_user_id=$7))`;
    const items = await this.db.query(`SELECT v.*,
      coalesce((SELECT sum(ft.amount_incl_tax) FROM fuel_transaction ft
        WHERE ft.fuel_card_id=v.id AND ft.deleted_at IS NULL),0) AS consumed_amount,
      CASE WHEN v.monthly_limit > 0 THEN least(100,round(100 * coalesce((SELECT sum(ft.amount_incl_tax)
        FROM fuel_transaction ft WHERE ft.fuel_card_id=v.id AND ft.deleted_at IS NULL),0) / v.monthly_limit)) ELSE 0 END AS consumption_rate
      FROM v_fuel_card_list v ${where}
      ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [search.trim(), term, status, limit, offset, actor.role==='NAJIB_ASSIGNER', actor.sub]);
    const [count] = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM v_fuel_card_list ${where}`,
      [search.trim(), term, status, limit, offset, actor.role==='NAJIB_ASSIGNER', actor.sub]);
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
  async replace(id: string, replacementId: string, reason: string, actorId: string, actor: string) {
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
        opposition_reason=$3, opposed_at=coalesce(opposed_at,now()), opposed_by=$4 WHERE id=$1`, [id,replacementId,reason,actorId]);
      await client.query(`UPDATE fuel_card SET old_card_id=$2 WHERE id=$1`, [replacementId,id]);
      const assignment = await client.query(`SELECT beneficiary_id,vehicle_id FROM card_assignment
        WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1`, [id]);
      if (assignment.rows[0]) {
        await client.query(`UPDATE card_assignment SET ends_at=now() WHERE fuel_card_id=$1 AND ends_at IS NULL`, [id]);
        await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [replacementId,assignment.rows[0].beneficiary_id,assignment.rows[0].vehicle_id]);
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'REPLACE','fuel_card',$2,$3)`, [actor,id,{replacementId,reason}]);
      return { success:true, oldCardId:id, replacementCardId:replacementId };
    });
  }
  async update(id: string, change: UpdateCard, actor: string) {
    return this.db.transaction(async client => {
      const before = await client.query('SELECT id,status,monthly_limit,threshold_alert_enabled,version FROM fuel_card WHERE id=$1 FOR UPDATE', [id]);
      if (!before.rows[0]) throw new NotFoundException('Carte introuvable');
      const current = before.rows[0];
      const result = await client.query(`UPDATE fuel_card SET status=coalesce($2::card_status,status),
        monthly_limit=coalesce($3,monthly_limit), threshold_alert_enabled=coalesce($4,threshold_alert_enabled)
        WHERE id=$1 RETURNING id,status,monthly_limit AS "monthlyLimit",threshold_alert_enabled AS "thresholdAlertEnabled",version,updated_at AS "updatedAt"`,
        [id, change.status ?? null, change.monthlyLimit ?? null, change.thresholdAlertEnabled ?? null]);
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,old_values,new_values)
        VALUES ($1,'UPDATE','fuel_card',$2,$3,$4)`, [actor, id, current, result.rows[0]]);
      return result.rows[0];
    });
  }
  async remove(id: string, actorId: string, actor: string) {
    return this.db.transaction(async client => {
      const before = await client.query(`SELECT status,replacement_card_id FROM fuel_card WHERE id=$1 AND deleted_at IS NULL`, [id]);
      if (!before.rows[0]) throw new NotFoundException('Carte introuvable');
      if (['STOLEN','LOST','OPPOSED'].includes(before.rows[0].status) && !before.rows[0].replacement_card_id)
        throw new BadRequestException('Créez et liez la carte remplaçante avant d’archiver cette carte');
      const result = await client.query(`UPDATE fuel_card SET deleted_at=now(),deleted_by=$2
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id, actorId]);
      if (!result.rows[0]) throw new NotFoundException('Carte introuvable');
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES ($1,'SOFT_DELETE','fuel_card',$2,$3)`, [actor, id, { deleted: true }]);
      return { success: true };
    });
  }
}
