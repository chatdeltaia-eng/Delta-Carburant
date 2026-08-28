import { BadRequestException,Injectable,NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor={sub:string;email:string;role:string};
@Injectable()
export class MileageService {
 constructor(private readonly db:DatabaseService){}
 list(actor:Actor,companyId=''){const own=actor.role==='NAJIB_ASSIGNER';return this.db.query(`SELECT mr.id::text,mr.vehicle_id AS "vehicleId",v.registration_display AS vehicle,
   v.driver_name AS driver,c.code AS company,v.brand,v.model,v.vehicle_type AS "vehicleType",v.first_registration_date AS "firstRegistrationDate",
   mr.week_start AS week,mr.mileage,mr.previous_mileage AS "previousMileage",
   mr.expected_mileage AS "expectedMileage",mr.detected_distance AS "detectedDistance",mr.anomaly,mr.status::text AS status,
   coalesce((SELECT sum(ft.quantity_liters) FROM fuel_transaction ft WHERE ft.vehicle_id=mr.vehicle_id AND ft.deleted_at IS NULL
     AND ft.transaction_date>coalesce((SELECT max(previous.reading_date) FROM mileage_reading previous WHERE previous.vehicle_id=mr.vehicle_id
       AND previous.status='VALIDATED' AND previous.reading_date<mr.reading_date),'1970-01-01') AND ft.transaction_date<=mr.reading_date),0)::float AS "periodLiters",
   CASE WHEN mr.mileage>coalesce(mr.previous_mileage,0) THEN round((100*coalesce((SELECT sum(ft.quantity_liters) FROM fuel_transaction ft
     WHERE ft.vehicle_id=mr.vehicle_id AND ft.deleted_at IS NULL AND ft.transaction_date>coalesce((SELECT max(previous.reading_date)
       FROM mileage_reading previous WHERE previous.vehicle_id=mr.vehicle_id AND previous.status='VALIDATED' AND previous.reading_date<mr.reading_date),'1970-01-01')
       AND ft.transaction_date<=mr.reading_date),0)/(mr.mileage-mr.previous_mileage))::numeric,2)::float ELSE null END AS "litersPer100Km",
   mr.reference_liters_per_100km::float AS "referenceLitersPer100Km",mr.estimated_distance::float AS "estimatedDistance",
   mr.estimated_mileage::float AS "estimatedMileage",mr.reconciliation_message AS "reconciliationMessage",
   coalesce((SELECT jsonb_agg(jsonb_build_object(
     'id',ft.id,'date',ft.transaction_date,'card',fc.masked_card_number,'station',ft.station,'product',ft.product,
     'liters',ft.quantity_liters,'amount',ft.amount_incl_tax,'beneficiary',coalesce(b.display_name,fc.holder_name,'—'))
     ORDER BY ft.transaction_date,ft.created_at)
     FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id
     WHERE ft.vehicle_id=mr.vehicle_id AND ft.deleted_at IS NULL
       AND ft.transaction_date>coalesce((SELECT max(previous.reading_date) FROM mileage_reading previous
         WHERE previous.vehicle_id=mr.vehicle_id AND previous.status='VALIDATED' AND previous.reading_date<mr.reading_date),'1970-01-01')
       AND ft.transaction_date<=mr.reading_date),'[]'::jsonb) AS transactions,
   mr.rejection_reason AS "rejectionReason",mr.created_at AS "createdAt",u.display_name AS responsible,
   reviewer.display_name AS reviewer FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id JOIN company c ON c.id=v.company_id
   LEFT JOIN app_user u ON u.id=mr.created_by LEFT JOIN app_user reviewer ON reviewer.id=mr.validated_by
   WHERE ($1::boolean=false OR mr.created_by=$2) AND ($3='' OR v.company_id=$3::uuid)

   UNION ALL

   SELECT 'transaction:'||ft.id::text AS id,ft.vehicle_id AS "vehicleId",v.registration_display AS vehicle,
   v.driver_name AS driver,c.code AS company,v.brand,v.model,v.vehicle_type AS "vehicleType",v.first_registration_date AS "firstRegistrationDate",
   ft.transaction_date::date AS week,ft.reported_mileage::float AS mileage,
   coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)::float AS "previousMileage",
   ft.reported_mileage::float AS "expectedMileage",
   greatest(0,ft.reported_mileage-coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0))::float AS "detectedDistance",
   CASE
     WHEN ft.reported_mileage<coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0) THEN true
     WHEN ft.quantity_liters>0 AND ft.reported_mileage=coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0) THEN true
     WHEN ft.reported_mileage>coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)
       AND (100*ft.quantity_liters/(ft.reported_mileage-coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0))) NOT BETWEEN 2 AND 40 THEN true
     ELSE false
   END AS anomaly,'VALIDATED'::text AS status,ft.quantity_liters::float AS "periodLiters",
   CASE WHEN ft.reported_mileage>coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)
     THEN round((100*ft.quantity_liters/(ft.reported_mileage-coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)))::numeric,2)::float
     ELSE null END AS "litersPer100Km",
   10::float AS "referenceLitersPer100Km",(10*ft.quantity_liters)::float AS "estimatedDistance",
   (coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)+10*ft.quantity_liters)::float AS "estimatedMileage",
   CASE
     WHEN ft.reported_mileage<coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)
       THEN 'Anomalie : le kilométrage actuel est inférieur au kilométrage précédent.'
     WHEN ft.quantity_liters>0 AND ft.reported_mileage=coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)
       THEN 'Anomalie : carburant consommé sans distance parcourue entre les deux kilométrages.'
     WHEN ft.reported_mileage>coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)
       AND (100*ft.quantity_liters/(ft.reported_mileage-coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0))) NOT BETWEEN 2 AND 40
       THEN 'Anomalie : consommation calculée hors de la plage de contrôle (2 à 40 L/100 km).'
     ELSE concat('Kilométrage contrôlé. Estimation initiale : ',round((coalesce(ft.previous_mileage,lag(ft.reported_mileage) OVER(PARTITION BY ft.vehicle_id ORDER BY ft.transaction_date,ft.created_at),0)+10*ft.quantity_liters)::numeric,0),' km selon une référence de 10 L/100 km.')
   END::text AS "reconciliationMessage",
   jsonb_build_array(jsonb_build_object(
     'id',ft.id,'date',ft.transaction_date,'card',fc.masked_card_number,'station',ft.station,'product',ft.product,
     'liters',ft.quantity_liters,'amount',ft.amount_incl_tax,'beneficiary',coalesce(b.display_name,fc.holder_name,'—'))
   ) AS transactions,
   null::text AS "rejectionReason",ft.created_at AS "createdAt",coalesce(b.display_name,fc.holder_name,'Total Mobility') AS responsible,
   'Import Total'::text AS reviewer
   FROM fuel_transaction ft
   JOIN vehicle v ON v.id=ft.vehicle_id
   JOIN company c ON c.id=v.company_id
   JOIN fuel_card fc ON fc.id=ft.fuel_card_id
   LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id
   WHERE ft.deleted_at IS NULL AND ft.reported_mileage IS NOT NULL AND ($3='' OR v.company_id=$3::uuid)
     AND ($1::boolean=false OR fc.responsible_user_id=$2)
     AND NOT EXISTS(SELECT 1 FROM mileage_reading existing WHERE existing.vehicle_id=ft.vehicle_id
       AND existing.mileage=ft.reported_mileage AND existing.reading_date::date=ft.transaction_date::date)
   ORDER BY week DESC,"createdAt" DESC`,[own,actor.sub,companyId]);}
 async create(dto:{vehicleId:string;mileage:number;note?:string},actor:Actor){return this.db.transaction(async client=>{
   const zin=actor.role==='ZIN_FINANCE';
   const allowed=await client.query(`SELECT v.id,v.registration_display,c.code AS company FROM vehicle v JOIN company c ON c.id=v.company_id
     WHERE v.id=$1 AND v.deleted_at IS NULL AND v.active AND c.active
     AND ($3::boolean OR v.managed_by=$2 OR EXISTS(SELECT 1 FROM transaction_allocation ta WHERE ta.vehicle_id=v.id AND ta.allocated_by=$2))`,[dto.vehicleId,actor.sub,zin]);
   if(!allowed.rows[0]) throw new NotFoundException(zin?'Véhicule actif introuvable dans la société sélectionnée':'Ce véhicule ne fait pas partie de votre périmètre société');
   const last=await client.query(`SELECT mileage,reading_date FROM mileage_reading WHERE vehicle_id=$1 AND status='VALIDATED' ORDER BY reading_date DESC LIMIT 1`,[dto.vehicleId]);
   const previous=Number(last.rows[0]?.mileage??0),since=last.rows[0]?.reading_date??'1970-01-01';
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
 async correctTransaction(id:string,dto:{mileage:number;note?:string},actor:Actor){return this.db.transaction(async client=>{
   const current=await client.query(`SELECT ft.id,ft.vehicle_id,ft.previous_mileage,ft.reported_mileage,ft.quantity_liters,
     v.registration_display,fc.responsible_user_id FROM fuel_transaction ft
     JOIN fuel_card fc ON fc.id=ft.fuel_card_id JOIN vehicle v ON v.id=ft.vehicle_id
     WHERE ft.id=$1 AND ft.deleted_at IS NULL FOR UPDATE OF ft`,[id]);
   const row=current.rows[0];
   if(!row)throw new NotFoundException('Transaction ou véhicule introuvable');
   if(actor.role==='NAJIB_ASSIGNER'&&row.responsible_user_id!==actor.sub)throw new NotFoundException('Cette carte ne fait pas partie de votre périmètre');
   const previous=Number(row.previous_mileage??0);
   if(dto.mileage<previous)throw new BadRequestException(`Le nouveau kilométrage doit être supérieur ou égal au précédent (${previous} km)`);
   const history=await client.query(`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY rate)::float AS rate FROM (
     SELECT 100*quantity_liters/(reported_mileage-previous_mileage) AS rate FROM fuel_transaction
     WHERE vehicle_id=$1 AND id<>$2 AND deleted_at IS NULL AND previous_mileage IS NOT NULL
       AND reported_mileage>previous_mileage AND 100*quantity_liters/(reported_mileage-previous_mileage) BETWEEN 2 AND 40) h`,[row.vehicle_id,id]);
   const reference=Number(history.rows[0]?.rate??0)||10;
   const estimated=previous+100*Number(row.quantity_liters)/reference;
   const minimum=previous+100*Number(row.quantity_liters)/(reference*1.35);
   const maximum=previous+100*Number(row.quantity_liters)/(reference*.65);
   const anomaly=dto.mileage<minimum||dto.mileage>maximum;
   await client.query(`UPDATE fuel_transaction SET reported_mileage=$2,corrected_at=now(),corrected_by=$3,
     correction_reason=$4 WHERE id=$1`,[id,dto.mileage,actor.sub,dto.note??'Kilométrage confirmé après contact avec le chauffeur']);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'CORRECT_TRANSACTION_MILEAGE','fuel_transaction',$2,$3)`,
     [actor.email,id,{previousMileage:previous,oldMileage:row.reported_mileage,mileage:dto.mileage,estimatedMileage:estimated,minimumMileage:minimum,maximumMileage:maximum,anomaly,note:dto.note}]);
   if(anomaly&&row.responsible_user_id)await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
     VALUES($1,'Kilométrage véhicule non conforme',$2,'HIGH','mileage','fuel_transaction',$3)`,[row.responsible_user_id,
       `${row.registration_display} : ${dto.mileage} km saisis. Valeur attendue entre ${minimum.toFixed(0)} et ${maximum.toFixed(0)} km selon ${Number(row.quantity_liters).toFixed(3)} L consommés. Veuillez contacter le chauffeur du véhicule.`,id]);
   return {id,mileage:dto.mileage,previousMileage:previous,referenceLitersPer100Km:reference,estimatedMileage:estimated,minimumMileage:minimum,maximumMileage:maximum,anomaly};
 });}
 async decide(id:string,dto:{decision:'VALIDATED'|'REJECTED';reason?:string},actor:Actor){if(dto.decision==='REJECTED'&&!dto.reason?.trim())throw new BadRequestException('Le motif du refus est obligatoire');
  return this.db.transaction(async client=>{const current=await client.query(`SELECT mr.*,v.registration_display FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id WHERE mr.id=$1 AND mr.status='PENDING' FOR UPDATE OF mr`,[id]);
   if(!current.rows[0])throw new NotFoundException('Relevé introuvable ou déjà traité');
   const row=current.rows[0];const result=await client.query(`UPDATE mileage_reading SET status=$2,validated_by=$3,validated_at=now(),rejection_reason=$4,decision_reason=$4 WHERE id=$1 RETURNING *`,[id,dto.decision,actor.sub,dto.reason??null]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id) VALUES($1,$2,$3,$4,'mileage','mileage_reading',$5)`,
    [row.created_by,dto.decision==='VALIDATED'?'Kilométrage validé':'Kilométrage refusé',`${row.registration_display} : ${row.mileage} km — ${dto.reason??'validé'}`,dto.decision==='VALIDATED'?'INFO':'WARNING',id]);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,$2,'mileage_reading',$3,$4)`,[actor.email,dto.decision,id,{reason:dto.reason}]);return result.rows[0];});}
}
