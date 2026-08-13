import { BadRequestException,Injectable,NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
type Actor={sub:string;email:string;role:string};
@Injectable()
export class ComplaintsService {
 constructor(private readonly db:DatabaseService){}
 list(actor:Actor){return this.db.query(`SELECT c.id,c.complaint_number AS "number",c.subject,c.description,c.priority,c.status,
   c.target_role AS "targetRole",creator.display_name AS creator,creator.role AS "creatorRole",assignee.display_name AS assignee,
   c.resolution,c.created_at AS "createdAt",c.updated_at AS "updatedAt",
   coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'message',m.message,'author',u.display_name,'role',u.role,'createdAt',m.created_at) ORDER BY m.created_at)
     FROM complaint_message m JOIN app_user u ON u.id=m.author_id WHERE m.complaint_id=c.id),'[]'::jsonb) AS messages
   FROM complaint c JOIN app_user creator ON creator.id=c.created_by LEFT JOIN app_user assignee ON assignee.id=c.assigned_to
   WHERE $2='SUPER_ADMIN' OR c.created_by=$1 OR c.target_role::text=$2 OR c.assigned_to=$1 ORDER BY c.created_at DESC`,[actor.sub,actor.role]);}
 async create(dto:{subject:string;description:string;priority:string;targetRole:string},actor:Actor){
  if(dto.targetRole===actor.role)throw new BadRequestException('Choisissez un autre destinataire pour la réclamation');
  return this.db.transaction(async client=>{const number=`REC-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
   const row=await client.query(`INSERT INTO complaint(complaint_number,subject,description,priority,created_by,target_role)
    VALUES($1,$2,$3,$4,$5,$6::user_role) RETURNING id,complaint_number AS "number",status`,[number,dto.subject.trim(),dto.description.trim(),dto.priority,actor.sub,dto.targetRole]);
   await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
    SELECT id,'Nouvelle réclamation',$1,$2,'complaints','complaint',$3 FROM app_user WHERE active AND role=$4::user_role`,[`${number} · ${dto.subject.trim()}`,dto.priority==='URGENT'?'CRITICAL':dto.priority==='HIGH'?'WARNING':'INFO',row.rows[0].id,dto.targetRole]);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'CREATE_COMPLAINT','complaint',$2,$3)`,[actor.email,row.rows[0].id,dto]);return row.rows[0];});}
 async message(id:string,message:string,actor:Actor){return this.db.transaction(async client=>{const access=await client.query(`SELECT id,created_by,target_role FROM complaint WHERE id=$1 AND ($2='SUPER_ADMIN' OR created_by=$3 OR target_role::text=$2)`,[id,actor.role,actor.sub]);if(!access.rows[0])throw new NotFoundException('Réclamation introuvable');
  const row=await client.query(`INSERT INTO complaint_message(complaint_id,author_id,message) VALUES($1,$2,$3) RETURNING id,created_at AS "createdAt"`,[id,actor.sub,message.trim()]);
  await client.query(`UPDATE complaint SET status=CASE WHEN status='OPEN' THEN 'IN_PROGRESS' ELSE status END,assigned_to=coalesce(assigned_to,$2),updated_at=now() WHERE id=$1`,[id,actor.sub]);return row.rows[0];});}
 async status(id:string,dto:{status:string;resolution?:string},actor:Actor){if(dto.status==='RESOLVED'&&!dto.resolution?.trim())throw new BadRequestException('La résolution est obligatoire');return this.db.transaction(async client=>{
  const found=await client.query(`SELECT * FROM complaint WHERE id=$1 AND ($2='SUPER_ADMIN' OR created_by=$3 OR target_role::text=$2) FOR UPDATE`,[id,actor.role,actor.sub]);if(!found.rows[0])throw new NotFoundException('Réclamation introuvable');
  const row=await client.query(`UPDATE complaint SET status=$2,resolution=coalesce($3,resolution),assigned_to=coalesce(assigned_to,$4),resolved_at=CASE WHEN $2 IN('RESOLVED','CLOSED') THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,[id,dto.status,dto.resolution?.trim()||null,actor.sub]);return row.rows[0];});}
}
