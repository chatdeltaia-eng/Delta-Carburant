import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor = { sub: string; email: string };
type Correction = { station?: string; liters?: number; amount?: number; reason: string };
type Allocation = { beneficiaryId: string; vehicleId: string; amount: number; liters?: number; note?: string };
@Injectable()
export class TransactionsService {
  constructor(private readonly db: DatabaseService) {}
  list(actor: { sub: string; role: string }) { return this.db.query(`SELECT ft.id,ft.transaction_date AS date,fc.masked_card_number AS card,
    ft.station,ft.product,ft.quantity_liters AS liters,ft.amount_incl_tax AS amount,tib.source_filename AS file,
    b.display_name AS beneficiary,v.registration_display AS vehicle,ft.corrected_at AS "correctedAt",
    fc.card_category AS "cardCategory",fc.monthly_limit AS "monthlyLimit",
    coalesce(sum(ta.allocated_amount),0) AS "allocatedAmount",
    ft.amount_incl_tax-coalesce(sum(ta.allocated_amount),0) AS "remainingAmount",
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',detail.id,'beneficiary',detail.display_name,'vehicle',detail.registration_display,
      'amount',detail.allocated_amount,'liters',detail.allocated_liters,'note',detail.note,
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
  async allocate(id: string, dto: Allocation, actor: Actor) { return this.db.transaction(async client => {
    const transaction = await client.query(`SELECT ft.amount_incl_tax,ft.quantity_liters,fc.responsible_user_id,
      fc.company_id FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.id=$1 AND ft.deleted_at IS NULL AND fc.card_category='OFF_PARK' FOR UPDATE OF ft,fc`, [id]);
    const source = transaction.rows[0];
    if (!source) throw new NotFoundException('Transaction hors parc introuvable');
    if (source.responsible_user_id !== actor.sub) throw new NotFoundException('Cette carte hors parc ne relève pas de Najib');
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) throw new BadRequestException('Le montant à répartir doit être positif');
    const allocationTotal = await client.query(`SELECT coalesce(sum(allocated_amount),0) AS allocated
      FROM transaction_allocation WHERE fuel_transaction_id=$1`, [id]);
    if (Number(allocationTotal.rows[0].allocated)+dto.amount > Number(source.amount_incl_tax)) throw new BadRequestException('La répartition dépasse le montant de la transaction Total');
    const targets = await client.query(`SELECT b.company_id AS beneficiary_company,v.company_id AS vehicle_company
      FROM beneficiary b,vehicle v WHERE b.id=$1 AND v.id=$2`, [dto.beneficiaryId,dto.vehicleId]);
    if (!targets.rows[0] || targets.rows[0].beneficiary_company !== source.company_id || targets.rows[0].vehicle_company !== source.company_id)
      throw new BadRequestException('Le bénéficiaire et le véhicule doivent appartenir à la société de la carte');
    const result = await client.query(`INSERT INTO transaction_allocation(fuel_transaction_id,beneficiary_id,vehicle_id,
      allocated_amount,allocated_liters,note,allocated_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id,dto.beneficiaryId,dto.vehicleId,dto.amount,dto.liters??null,dto.note??null,actor.sub]);
    await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
      VALUES($1,'ALLOCATE','fuel_transaction',$2,$3)`, [actor.email,id,result.rows[0]]);
    return {
      ...result.rows[0],
      originalAmount: Number(source.amount_incl_tax),
      allocatedAmount: Number(allocationTotal.rows[0].allocated)+dto.amount,
      remainingAmount: Number(source.amount_incl_tax)-Number(allocationTotal.rows[0].allocated)-dto.amount,
    };
  }); }
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
