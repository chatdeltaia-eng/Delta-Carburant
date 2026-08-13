import { BadRequestException,Injectable,NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor={sub:string;email:string;role:string};
@Injectable()
export class MileageService {
 constructor(private readonly db:DatabaseService){}
 list(actor:Actor){const own=actor.role==='NAJIB_ASSIGNER';return this.db.query(`SELECT mr.id,mr.vehicle_id AS "vehicleId",v.registration_display AS vehicle,
   v.driver_name AS driver,c.code AS company,mr.week_start AS week,mr.mileage,mr.previous_mileage AS "previousMileage",
   mr.expected_mileage AS "expectedMileage",mr.detected_distance AS "detectedDistance",mr.anomaly,mr.status,
   coalesce((SELECT sum(ft.quantity_liters) FROM fuel_transaction ft WHERE ft.vehicle_id=mr.vehicle_id AND ft.deleted_at IS NULL
     AND ft.transaction_date>coalesce((SELECT max(previous.reading_date) FROM mileage_reading previous WHERE previous.vehicle_id=mr.vehicle_id
       AND previous.status='VALIDATED' AND previous.reading_date<mr.reading_date),'1970-01-01') AND ft.transaction_date<=mr.reading_date),0)::float AS "periodLiters",
   CASE WHEN mr.mileage>coalesce(mr.previous_mileage,0) THEN round((100*coalesce((SELECT sum(ft.quantity_liters) FROM fuel_transaction ft
     WHERE ft.vehicle_id=mr.vehicle_id AND ft.deleted_at IS NULL AND ft.transaction_date>coalesce((SELECT max(previous.reading_date)
       FROM mileage_reading previous WHERE previous.vehicle_id=mr.vehicle_id AND previous.status='VALIDATED' AND previous.reading_date<mr.reading_date),'1970-01-01')
       AND ft.transaction_date<=mr.reading_date),0)/(mr.mileage-mr.previous_mileage))::numeric,2)::float ELSE null END AS "litersPer100Km",
   mr.reference_liters_per_100km::float AS "referenceLitersPer100Km",mr.estimated_distance::float AS "estimatedDistance",
   mr.estimated_mileage::float AS "estimatedMileage",mr.reconciliation_message AS "reconciliationMessage",
   mr.rejection_reason AS "rejectionReason",mr.created_at AS "createdAt",u.display_name AS responsible,
   reviewer.display_name AS reviewer FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id JOIN company c ON c.id=v.company_id
   LEFT JOIN app_user u ON u.id=mr.created_by LEFT JOIN app_user reviewer ON reviewer.id=mr.validated_by
   WHERE ($1::boolean=false OR mr.created_by=$2) ORDER BY mr.week_start DESC,mr.created_at DESC`,[own,actor.sub]);}
 async create(dto:{vehicleId:string;mileage:number;note?:string},actor:Actor){return this.db.transaction(async client=>{
   const zin=actor.role==='ZIN_FINANCE';
   const allowed=await client.query(`SELECT v.id,v.registration_display FROM vehicle v JOIN company c ON c.id=v.company_id
     WHERE v.id=$1 AND v.deleted_at IS NULL AND v.active AND c.code='DC'
     AND ($3::boolean OR v.managed_by=$2 OR EXISTS(SELECT 1 FROM transaction_allocation ta WHERE ta.vehicle_id=v.id AND ta.allocated_by=$2))`,[dto.vehicleId,actor.sub,zin]);
   if(!allowed.rows[0]) throw new NotFoundException(zin?'Véhicule actif introuvable dans le parc DC':'Ce véhicule ne fait pas partie de votre périmètre hors parc');
   const last=await client.query(`SELECT mileage,created_at FROM mileage_reading WHERE vehicle_id=$1 AND status='VALIDATED' ORDER BY reading_date DESC LIMIT 1`,[dto.vehicleId]);
   const previous=Number(last.rows[0]?.mileage??0),since=last.rows[0]?.created_at??'1970-01-01';
   const fuel=await client.query(`SELECT coalesce(sum(ft.quantity_liters),0)::float AS liters FROM fuel_transaction ft
     WHERE ft.vehicle_id=$1 AND ft.deleted_at IS NULL AND ft.transaction_date>$2`,[dto.vehicleId,since]);
   const detected=Math.max(0,Number(dto.mileage)-previous);
   if(dto.mileage<previous) throw new BadRequestException(`Le kilométrage ne peut pas être inférieur au dernier relevé (${previous})`);
   const liters=Number(fuel.rows[0].liters),litersPer100Km=detected>0?100*liters/detected:null;
   const history=await client.query(`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY calculated_liters_per_100km)::float AS rate FROM mileage_reading WHERE vehicle_id=$1 AND status='VALIDATED' AND calculated_liters_per_100km BETWEEN 2 AND 60`,[dto.vehicleId]);
   const referenceRate=Number(history.rows[0]?.rate??0)||null;
   const estimatedDistance=referenceRate&&liters>0?100*liters/referenceRate:null;
   const expected=estimatedDistance!==null?previous+estimatedDistance:null;
   const deviation=estimatedDistance&&estimatedDistance>0?Math.abs(detected-estimatedDistance)/estimatedDistance:0;
   const anomaly=previous>0&&(detected>10000||(liters>0&&detected===0)||(litersPer100Km!==null&&litersPer100Km>40)||(referenceRate!==null&&deviation>0.35));
   const reconciliation=referenceRate===null?`${liters.toFixed(3)} L consommés pour ${detected.toFixed(1)} km déclarés. Historique insuffisant pour estimer le kilométrage correct.`:`${liters.toFixed(3)} L consommés · référence ${referenceRate.toFixed(2)} L/100 km · distance estimée ${estimatedDistance!.toFixed(1)} km · kilométrage estimé ${expected!.toFixed(1)} km`;
   const result=await client.query(`INSERT INTO mileage_reading(vehicle_id,reading_date,mileage,status,source,created_by,week_start,
     previous_mileage,expected_mileage,detected_distance,anomaly,period_liters,reference_liters_per_100km,calculated_liters_per_100km,estimated_distance,estimated_mileage,reconciliation_message) VALUES($1,now(),$2,'PENDING','WEEKLY',$3,date_trunc('week',current_date)::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
     [dto.vehicleId,dto.mileage,actor.sub,previous,expected??dto.mileage,detected,anomaly,liters,referenceRate,litersPer100Km,estimatedDistance,expected,reconciliation]);
   if(zin&&!anomaly) await client.query(`UPDATE mileage_reading SET status='VALIDATED',source='MANUAL_ZIN',validated_by=$2,validated_at=now(),decision_reason=$3 WHERE id=$1`,[result.rows[0].id,actor.sub,dto.note??'Saisie directe Zin Finance']);
   if(anomaly) await client.query(`INSERT INTO anomaly(vehicle_id,anomaly_type,severity,status,description,assigned_to)
     VALUES($1,'MILEAGE_MISMATCH','HIGH','OPEN',$2,$3)`,[dto.vehicleId,`Relevé déclaré ${dto.mileage} km. ${reconciliation}`,actor.sub]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
     SELECT id,$2,$3,$4,'mileage','mileage_reading',$5 FROM app_user WHERE active AND role::text=ANY($1::text[])`,
     [zin?['DIRECTION_GENERAL','SUPER_ADMIN']:['ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'],anomaly?'Anomalie kilométrique à vérifier':zin?'Kilométrage ajouté par Zin':'Nouveau relevé kilométrique',`${allowed.rows[0].registration_display} : ${dto.mileage} km${anomaly?` · ${reconciliation}`:''}`,anomaly?'HIGH':'INFO',result.rows[0].id]);
   return {...result.rows[0],status:zin&&!anomaly?'VALIDATED':'PENDING',expectedMileage:expected??dto.mileage,detectedDistance:detected,periodLiters:liters,litersPer100Km,referenceLitersPer100Km:referenceRate,estimatedDistance,estimatedMileage:expected,reconciliationMessage:reconciliation,anomaly};
 });}
 async decide(id:string,dto:{decision:'VALIDATED'|'REJECTED';reason?:string},actor:Actor){if(dto.decision==='REJECTED'&&!dto.reason?.trim())throw new BadRequestException('Le motif du refus est obligatoire');
  return this.db.transaction(async client=>{const current=await client.query(`SELECT mr.*,v.registration_display FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id WHERE mr.id=$1 AND mr.status='PENDING' FOR UPDATE OF mr`,[id]);
   if(!current.rows[0])throw new NotFoundException('Relevé introuvable ou déjà traité');
   const row=current.rows[0];const result=await client.query(`UPDATE mileage_reading SET status=$2,validated_by=$3,validated_at=now(),rejection_reason=$4,decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id) VALUES($1,$2,$3,$4,'mileage','mileage_reading',$5)`,
    [row.created_by,dto.decision==='VALIDATED'?'Kilométrage validé':'Kilométrage refusé',`${row.registration_display} : ${row.mileage} km — ${dto.reason??'validé'}`,dto.decision==='VALIDATED'?'INFO':'WARNING',id]);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'mileage_reading',$3,$4)`,[actor.email,dto.decision,id,{reason:dto.reason}]);return result.rows[0];});}
}
