import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private readonly db: DatabaseService) {}
  async summary(actor: { sub: string; role: string }) {
    const ownCards = actor.role === 'NAJIB_ASSIGNER';
    const [totals] = await this.db.query(`SELECT
      count(*)::int AS "totalCards",
      count(*) FILTER (WHERE status='ACTIVE')::int AS "activeCards",
      count(*) FILTER (WHERE status IN ('SUSPENDED','OPPOSED','LOST','STOLEN'))::int AS "blockedCards",
      coalesce(sum(monthly_limit) FILTER (WHERE status='ACTIVE'),0)::float AS "activeMonthlyLimit"
      FROM fuel_card WHERE deleted_at IS NULL AND ($1::boolean=false OR responsible_user_id=$2)`, [ownCards, actor.sub]);
    const [entities] = await this.db.query(`SELECT
      (SELECT count(DISTINCT ca.beneficiary_id)::int FROM card_assignment ca JOIN fuel_card fc ON fc.id=ca.fuel_card_id
        WHERE ca.ends_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS beneficiaries,
      (SELECT count(DISTINCT ca.vehicle_id)::int FROM card_assignment ca JOIN fuel_card fc ON fc.id=ca.fuel_card_id
        WHERE ca.ends_at IS NULL AND ca.vehicle_id IS NOT NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS vehicles,
      (SELECT count(*)::int FROM transaction_review tr JOIN fuel_card fc ON fc.id=tr.fuel_card_id
        WHERE tr.status='PENDING' AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS "openIssues",
      (SELECT count(*)::int FROM transaction_review tr JOIN fuel_card fc ON fc.id=tr.fuel_card_id
        WHERE tr.status='PENDING' AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS "pendingTransactionReviews",
      (SELECT coalesce(sum(ft.quantity_liters),0)::float FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
        WHERE ft.deleted_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS liters,
      (SELECT coalesce(sum(ft.amount_incl_tax),0)::float FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
        WHERE ft.deleted_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2)) AS amount,
      (SELECT count(*)::int FROM card_request cr WHERE cr.status NOT IN ('CLOSED','REJECTED','CANCELLED')
        AND ($1::boolean=false OR cr.requested_by=$2)) AS "openRequests"`, [ownCards, actor.sub]);
    const statuses = await this.db.query(`SELECT status, count(*)::int AS count FROM fuel_card
      WHERE deleted_at IS NULL AND ($1::boolean=false OR responsible_user_id=$2)
      GROUP BY status ORDER BY count DESC`, [ownCards, actor.sub]);
    return { ...totals, ...entities, statuses };
  }
  async direction() {
    const kpis = await this.db.query(`SELECT
      coalesce(sum(ft.quantity_liters) FILTER (WHERE fc.old_card_id IS NULL),0)::float AS "oldCardLiters",
      coalesce(sum(ft.quantity_liters) FILTER (WHERE fc.old_card_id IS NOT NULL),0)::float AS "newCardLiters",
      count(DISTINCT fc.id) FILTER (WHERE fc.old_card_id IS NOT NULL)::int AS "migratedCards",
      count(DISTINCT fc.id) FILTER (WHERE fc.status='ACTIVE')::int AS "activeCards",
      coalesce(sum(fc.monthly_limit) FILTER (WHERE fc.status='ACTIVE'),0)::float AS "totalLimit"
      FROM fuel_card fc LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL`);
    const migrations = await this.db.query('SELECT * FROM v_direction_card_reporting ORDER BY lifecycle_liters DESC');
    const companies = await this.db.query(`SELECT c.code AS company,coalesce(sum(ft.quantity_liters),0)::float AS liters
      FROM company c LEFT JOIN fuel_card fc ON fc.company_id=c.id LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL GROUP BY c.code ORDER BY liters DESC`);
    return { ...kpis[0], migrations, companies };
  }
}
