import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private readonly db: DatabaseService) {}
  async summary() {
    const [totals] = await this.db.query(`SELECT
      count(*)::int AS "totalCards",
      count(*) FILTER (WHERE status='ACTIVE')::int AS "activeCards",
      count(*) FILTER (WHERE status IN ('SUSPENDED','OPPOSED','LOST','STOLEN'))::int AS "blockedCards",
      coalesce(sum(monthly_limit) FILTER (WHERE status='ACTIVE'),0)::float AS "activeMonthlyLimit"
      FROM fuel_card WHERE deleted_at IS NULL`);
    const [entities] = await this.db.query(`SELECT
      (SELECT count(*)::int FROM beneficiary WHERE active) AS beneficiaries,
      (SELECT count(*)::int FROM vehicle WHERE active) AS vehicles,
      ((SELECT count(*) FROM data_quality_issue WHERE resolved_at IS NULL)+(SELECT count(*) FROM transaction_review WHERE status='PENDING'))::int AS "openIssues",
      (SELECT count(*)::int FROM transaction_review WHERE status='PENDING') AS "pendingTransactionReviews",
      (SELECT coalesce(sum(quantity_liters),0)::float FROM fuel_transaction WHERE deleted_at IS NULL) AS liters,
      (SELECT coalesce(sum(amount_incl_tax),0)::float FROM fuel_transaction WHERE deleted_at IS NULL) AS amount,
      (SELECT count(*)::int FROM card_request WHERE status NOT IN ('CLOSED','REJECTED','CANCELLED')) AS "openRequests"`);
    const statuses = await this.db.query(`SELECT status, count(*)::int AS count FROM fuel_card WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC`);
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
