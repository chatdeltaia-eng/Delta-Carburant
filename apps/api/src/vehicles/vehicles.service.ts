import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Vehicle = { registration:string; brand?:string; model?:string; active?:boolean;companyId?:string };
type Actor = { sub:string; email:string; companyId?:string };
@Injectable()
export class VehiclesService {
  constructor(private readonly db:DatabaseService) {}
  list(companyId:string,actor:{sub:string;role:string}){ const own=actor.role==='NAJIB_ASSIGNER'; return this.db.query(`SELECT v.id,v.registration_display AS registration,v.brand,v.model,v.active,v.company_id AS "companyId",
    v.fleet_number AS "fleetNumber",v.vehicle_type AS "vehicleType",v.first_registration_date AS "firstRegistrationDate",v.driver_name AS driver,v.notes,c.code AS company,
    coalesce((SELECT max(mr.mileage) FROM mileage_reading mr WHERE mr.vehicle_id=v.id AND mr.status='VALIDATED'),0)::float AS "lastMileage",
    v.updated_at AS "updatedAt" FROM vehicle v JOIN company c ON c.id=v.company_id WHERE v.deleted_at IS NULL
    AND ($1::boolean=false OR EXISTS(SELECT 1 FROM fuel_card fc LEFT JOIN card_assignment ca ON ca.fuel_card_id=fc.id AND ca.ends_at IS NULL
      WHERE fc.responsible_user_id=$2 AND fc.deleted_at IS NULL AND (ca.vehicle_id=v.id OR fc.company_id=v.company_id)))
    AND ($3='' OR v.company_id=$3::uuid) ORDER BY c.code,v.registration_display`,[own,actor.sub,companyId]); }
  async create(dto:Vehicle,actor:Actor){ const companyId=dto.companyId??actor.companyId;if(!companyId) throw new BadRequestException('Société obligatoire'); const [row]=await this.db.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,brand,model,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,company_id AS "companyId",registration_display AS registration,brand,model,active`,[companyId,this.normalize(dto.registration),dto.registration.trim(),dto.brand??null,dto.model??null,dto.active??true]);const reconciliation=await this.reconcileTotalCards(row.id,companyId,dto.registration,actor.sub);await this.audit(actor.email,'CREATE',row.id,{...row,reconciliation});return {...row,reconciliation}; }
  async update(id:string,dto:Vehicle,actor:Actor){
    const [current]=await this.db.query<{company_id:string}>('SELECT company_id FROM vehicle WHERE id=$1 AND deleted_at IS NULL',[id]);
    if(!current) throw new NotFoundException('Véhicule introuvable');
    const companyId=dto.companyId??current.company_id;
    const [company]=await this.db.query('SELECT id FROM company WHERE id=$1 AND active',[companyId]);
    if(!company) throw new BadRequestException('Société introuvable ou inactive');
    const [row]=await this.db.query(`UPDATE vehicle SET company_id=$7,registration_normalized=$2,registration_display=$3,brand=$4,model=$5,active=$6 WHERE id=$1 AND deleted_at IS NULL RETURNING id,company_id AS "companyId",registration_display AS registration,brand,model,active`,[id,this.normalize(dto.registration),dto.registration.trim(),dto.brand??null,dto.model??null,dto.active??true,companyId]);
    const reconciliation=await this.reconcileTotalCards(id,companyId,dto.registration,actor.sub);
    await this.audit(actor.email,'UPDATE',id,{...row,reconciliation}); return {...row,reconciliation};
  }
  async remove(id:string,actor:Actor){ const [row]=await this.db.query('UPDATE vehicle SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id',[id,actor.sub]); if(!row) throw new NotFoundException('Véhicule introuvable'); await this.audit(actor.email,'SOFT_DELETE',id,{deleted:true}); return {success:true}; }
  private normalize(value:string){ return value.toUpperCase().replace(/[^A-Z0-9]/g,''); }
  private registrationKeys(value:string){const normalized=this.normalize(value);const match=normalized.match(/^(\d+)TU(\d+)$/);return match?[normalized,`${match[2]}TU${match[1]}`]:[normalized];}
  private reconcileTotalCards(vehicleId:string,companyId:string,registration:string,actorId:string){return this.db.transaction(async client=>{
    const keys=this.registrationKeys(registration);
    const cards=await client.query(`SELECT id,masked_card_number,holder_name FROM fuel_card
      WHERE deleted_at IS NULL AND official_registration IS NOT NULL
      AND regexp_replace(upper(official_registration),'[^A-Z0-9]','','g')=ANY($1::text[]) FOR UPDATE`,[keys]);
    let transactionCount=0;
    for(const card of cards.rows){
      await client.query('UPDATE fuel_card SET company_id=$2,updated_at=now() WHERE id=$1',[card.id,companyId]);
      const holder=String(card.holder_name??'').trim()||`Titulaire ${registration.trim().toUpperCase()}`;
      const department=await client.query(`INSERT INTO department(company_id,name) VALUES($1,'Cartes Total') ON CONFLICT(company_id,name) DO UPDATE SET name=excluded.name RETURNING id`,[companyId]);
      const beneficiary=await client.query(`INSERT INTO beneficiary(company_id,department_id,display_name) VALUES($1,$2,$3) ON CONFLICT(company_id,display_name) DO UPDATE SET active=true RETURNING id`,[companyId,department.rows[0].id,holder]);
      const assignment=await client.query(`SELECT id FROM card_assignment WHERE fuel_card_id=$1 AND ends_at IS NULL AND is_primary LIMIT 1 FOR UPDATE`,[card.id]);
      if(assignment.rows[0]) await client.query(`UPDATE card_assignment SET beneficiary_id=$2,vehicle_id=$3,workflow_status='APPROVED_ZIN',reviewed_by=$4,reviewed_at=now() WHERE id=$1`,[assignment.rows[0].id,beneficiary.rows[0].id,vehicleId,actorId]);
      else await client.query(`INSERT INTO card_assignment(fuel_card_id,beneficiary_id,vehicle_id,workflow_status,requested_by,reviewed_by,reviewed_at) VALUES($1,$2,$3,'APPROVED_ZIN',$4,$4,now())`,[card.id,beneficiary.rows[0].id,vehicleId,actorId]);
      const linked=await client.query(`UPDATE fuel_transaction SET vehicle_id=$2,beneficiary_id=$3 WHERE fuel_card_id=$1 AND deleted_at IS NULL RETURNING id`,[card.id,vehicleId,beneficiary.rows[0].id]);
      transactionCount+=linked.rowCount??0;
    }
    return {matched:cards.rowCount??0,transactions:transactionCount,cards:cards.rows.map(card=>({number:card.masked_card_number,holder:card.holder_name}))};
  });}
  private audit(actor:string,action:string,id:string,values:unknown){ return this.db.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'vehicle',$3,$4)`,[actor,action,id,values]); }
}
