import { BadRequestException,Injectable,NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor={sub:string;email:string;role:string};
@Injectable()
export class MileageService {
 constructor(private readonly db:DatabaseService){}
 list(actor:Actor){const own=actor.role==='NAJIB_ASSIGNER';return this.db.query(`SELECT mr.id,mr.vehicle_id AS "vehicleId",v.registration_display AS vehicle,
   v.driver_name AS driver,c.code AS company,mr.week_start AS week,mr.mileage,mr.previous_mileage AS "previousMileage",
   mr.expected_mileage AS "expectedMileage",mr.detected_distance AS "detectedDistance",mr.anomaly,mr.status,
   mr.rejection_reason AS "rejectionReason",mr.created_at AS "createdAt",u.display_name AS responsible,
   reviewer.display_name AS reviewer FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id JOIN company c ON c.id=v.company_id
   LEFT JOIN app_user u ON u.id=mr.created_by LEFT JOIN app_user reviewer ON reviewer.id=mr.validated_by
   WHERE ($1::boolean=false OR mr.created_by=$2) ORDER BY mr.week_start DESC,mr.created_at DESC`,[own,actor.sub]);}
 async create(dto:{vehicleId:string;mileage:number;note?:string},actor:Actor){return this.db.transaction(async client=>{
   const allowed=await client.query(`SELECT v.id,v.registration_display FROM vehicle v WHERE v.id=$1 AND v.deleted_at IS NULL AND v.active
     AND EXISTS(SELECT 1 FROM card_assignment ca JOIN fuel_card fc ON fc.id=ca.fuel_card_id WHERE ca.vehicle_id=v.id AND ca.ends_at IS NULL
       AND fc.card_category='OFF_PARK' AND fc.responsible_user_id=$2 AND fc.deleted_at IS NULL)`,[dto.vehicleId,actor.sub]);
   if(!allowed.rows[0]) throw new NotFoundException('Ce véhicule ne fait pas partie de votre périmètre hors parc');
   const last=await client.query(`SELECT mileage,created_at FROM mileage_reading WHERE vehicle_id=$1 AND status='VALIDATED' ORDER BY reading_date DESC LIMIT 1`,[dto.vehicleId]);
   const previous=Number(last.rows[0]?.mileage??0),since=last.rows[0]?.created_at??'1970-01-01';
   const distance=await client.query(`SELECT coalesce(sum(coalesce(ft.distance_traveled,ft.quantity_liters)),0)::float AS distance
     FROM fuel_transaction ft WHERE ft.vehicle_id=$1 AND ft.deleted_at IS NULL AND ft.transaction_date>$2`,[dto.vehicleId,since]);
   const detected=Number(distance.rows[0].distance),expected=previous+detected;
   if(dto.mileage<previous) throw new BadRequestException(`Le kilométrage ne peut pas être inférieur au dernier relevé (${previous})`);
   const anomaly=previous>0&&Math.abs(dto.mileage-expected)>1;
   const result=await client.query(`INSERT INTO mileage_reading(vehicle_id,reading_date,mileage,status,source,created_by,week_start,
     previous_mileage,expected_mileage,detected_distance,anomaly) VALUES($1,now(),$2,'PENDING','WEEKLY',$3,date_trunc('week',current_date)::date,$4,$5,$6,$7) RETURNING *`,
     [dto.vehicleId,dto.mileage,actor.sub,previous,expected,detected,anomaly]);
   if(anomaly) await client.query(`INSERT INTO anomaly(vehicle_id,anomaly_type,severity,status,description,assigned_to)
     VALUES($1,'MILEAGE_MISMATCH','HIGH','OPEN',$2,$3)`,[dto.vehicleId,`Kilométrage saisi ${dto.mileage}; kilométrage attendu ${expected} d’après ${detected} km détectés`,actor.sub]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
     SELECT id,$2,$3,$4,'mileage','mileage_reading',$5 FROM app_user WHERE active AND role::text=ANY($1::text[])`,
     [['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],anomaly?'Anomalie kilométrique à vérifier':'Nouveau relevé kilométrique',`${allowed.rows[0].registration_display} : ${dto.mileage} km${anomaly?` (attendu ${expected})`:''}`,anomaly?'HIGH':'INFO',result.rows[0].id]);
   return {...result.rows[0],expectedMileage:expected,detectedDistance:detected,anomaly};
 });}
 async decide(id:string,dto:{decision:'VALIDATED'|'REJECTED';reason?:string},actor:Actor){if(dto.decision==='REJECTED'&&!dto.reason?.trim())throw new BadRequestException('Le motif du refus est obligatoire');
  return this.db.transaction(async client=>{const current=await client.query(`SELECT mr.*,v.registration_display FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id WHERE mr.id=$1 AND mr.status='PENDING' FOR UPDATE OF mr`,[id]);
   if(!current.rows[0])throw new NotFoundException('Relevé introuvable ou déjà traité');
   const row=current.rows[0];const result=await client.query(`UPDATE mileage_reading SET status=$2,validated_by=$3,validated_at=now(),rejection_reason=$4,decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id) VALUES($1,$2,$3,$4,'mileage','mileage_reading',$5)`,
    [row.created_by,dto.decision==='VALIDATED'?'Kilométrage validé':'Kilométrage refusé',`${row.registration_display} : ${row.mileage} km — ${dto.reason??'validé'}`,dto.decision==='VALIDATED'?'INFO':'WARNING',id]);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'mileage_reading',$3,$4)`,[actor.email,dto.decision,id,{reason:dto.reason}]);return result.rows[0];});}
}
