import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}
  list(userId: string) { return this.db.query(`SELECT id,title,message,severity,target_view AS "targetView",entity_type AS "entityType",entity_id AS "entityId",read_at AS "readAt",created_at AS "createdAt" FROM notification WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]); }
  async read(id: string, userId: string) { const [row] = await this.db.query('UPDATE notification SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at AS "readAt"',[id,userId]); if (!row) throw new NotFoundException('Notification introuvable'); return row; }
  notifyRoles(roles: string[], title: string, message: string, targetView: string, entityType: string, entityId: string) { return this.db.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) SELECT id,$2,$3,$4,$5,$6 FROM app_user WHERE active AND role::text=ANY($1::text[]) RETURNING id`,[roles,title,message,targetView,entityType,entityId]); }
}
