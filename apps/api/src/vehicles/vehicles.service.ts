import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Vehicle = { registration:string; brand?:string; model?:string; active?:boolean };
type Actor = { sub:string; email:string; companyId?:string };
@Injectable()
export class VehiclesService {
  constructor(private readonly db:DatabaseService) {}
  list(actor:{sub:string;role:string}){ const own=actor.role==='NAJIB_ASSIGNER'; return this.db.query(`SELECT v.id,v.registration_display AS registration,v.brand,v.model,v.active,
    v.fleet_number AS "fleetNumber",v.vehicle_type AS "vehicleType",v.first_registration_date AS "firstRegistrationDate",v.driver_name AS driver,v.notes,c.code AS company,
    coalesce((SELECT max(mr.mileage) FROM mileage_reading mr WHERE mr.vehicle_id=v.id AND mr.status='VALIDATED'),0)::float AS "lastMileage",
    v.updated_at AS "updatedAt" FROM vehicle v JOIN company c ON c.id=v.company_id WHERE v.deleted_at IS NULL
    AND ($1::boolean=false OR v.company_id IN(SELECT fc.company_id FROM fuel_card fc
      WHERE fc.card_category='OFF_PARK' AND fc.responsible_user_id=$2 AND fc.deleted_at IS NULL))
    ORDER BY c.code,v.registration_display`,[own,actor.sub]); }
  create(dto:Vehicle,actor:Actor){ if(!actor.companyId) throw new BadRequestException('Société utilisateur manquante'); return this.db.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,brand,model,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,registration_display AS registration,brand,model,active`,[actor.companyId,this.normalize(dto.registration),dto.registration.trim(),dto.brand??null,dto.model??null,dto.active??true]).then(rows=>rows[0]); }
  async update(id:string,dto:Vehicle,actor:Actor){ const [row]=await this.db.query(`UPDATE vehicle SET registration_normalized=$2,registration_display=$3,brand=$4,model=$5,active=$6 WHERE id=$1 AND deleted_at IS NULL RETURNING id,registration_display AS registration,brand,model,active`,[id,this.normalize(dto.registration),dto.registration.trim(),dto.brand??null,dto.model??null,dto.active??true]); if(!row) throw new NotFoundException('Véhicule introuvable'); await this.audit(actor.email,'UPDATE',id,row); return row; }
  async remove(id:string,actor:Actor){ const [row]=await this.db.query('UPDATE vehicle SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id',[id,actor.sub]); if(!row) throw new NotFoundException('Véhicule introuvable'); await this.audit(actor.email,'SOFT_DELETE',id,{deleted:true}); return {success:true}; }
  private normalize(value:string){ return value.toUpperCase().replace(/[^A-Z0-9]/g,''); }
  private audit(actor:string,action:string,id:string,values:unknown){ return this.db.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'vehicle',$3,$4)`,[actor,action,id,values]); }
}
