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
      (SELECT coalesce(sum(source.amount),0)::float FROM (
        SELECT ft.amount_incl_tax AS amount
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
        WHERE ft.deleted_at IS NULL
          AND ft.transaction_date>=date_trunc('month',current_date)
          AND ft.transaction_date<date_trunc('month',current_date)+interval '1 month'
          AND ($1::boolean=false OR fc.responsible_user_id=$2)
        UNION ALL
        SELECT tr.amount_incl_tax AS amount
        FROM transaction_review tr LEFT JOIN fuel_card fc ON fc.id=tr.fuel_card_id
        WHERE tr.status='PENDING'
          AND tr.transaction_date>=date_trunc('month',current_date)
          AND tr.transaction_date<date_trunc('month',current_date)+interval '1 month'
          AND ($1::boolean=false OR fc.responsible_user_id=$2)
      ) source) AS "officialMonthAmount",
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
      (SELECT coalesce(sum(monthly_limit),0)::float FROM fuel_card
        WHERE deleted_at IS NULL AND status='ACTIVE') AS "totalLimit"
      FROM fuel_card fc LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL`);
    const migrations = await this.db.query('SELECT * FROM v_direction_card_reporting ORDER BY lifecycle_liters DESC');
    const companies = await this.db.query(`SELECT c.code AS company,coalesce(sum(ft.quantity_liters),0)::float AS liters
      FROM company c LEFT JOIN fuel_card fc ON fc.company_id=c.id LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL GROUP BY c.code ORDER BY liters DESC`);
    const [overview] = await this.db.query(`SELECT
      coalesce(sum(ft.amount_incl_tax) FILTER(WHERE ft.transaction_date>=date_trunc('month',now())),0)::float AS "monthAmount",
      coalesce(sum(ft.quantity_liters) FILTER(WHERE ft.transaction_date>=date_trunc('month',now())),0)::float AS "monthLiters",
      (SELECT coalesce(sum(monthly_limit),0)::float FROM fuel_card WHERE deleted_at IS NULL AND status='ACTIVE') AS "monthBudget",
      count(*) FILTER(WHERE ft.validation_status='BILLING_MISMATCH' AND ft.transaction_date>=date_trunc('month',now()))::int AS "billingMismatches",
      coalesce(sum(abs(ft.billing_difference)) FILTER(WHERE ft.validation_status='BILLING_MISMATCH' AND ft.transaction_date>=date_trunc('month',now())),0)::float AS "billingExposure",
      (SELECT count(*)::int FROM anomaly WHERE status IN('OPEN','IN_REVIEW')) AS "openAnomalies"
      FROM fuel_card fc LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL`);
    const monthly = await this.db.query(`SELECT to_char(date_trunc('month',transaction_date),'YYYY-MM') AS month,
      sum(quantity_liters)::float AS liters,sum(amount_incl_tax)::float AS amount
      FROM fuel_transaction WHERE deleted_at IS NULL AND transaction_date>=date_trunc('month',now())-interval '11 months'
      GROUP BY 1 ORDER BY 1`);
    const topConsumers = await this.db.query(`SELECT fc.masked_card_number AS card,coalesce(b.display_name,fc.holder_name) AS beneficiary,
      v.registration_display AS vehicle,sum(ft.quantity_liters)::float AS liters,sum(ft.amount_incl_tax)::float AS amount,
      CASE WHEN fc.monthly_limit>0 THEN round(100*sum(ft.amount_incl_tax)/fc.monthly_limit,1)::float ELSE 0 END AS "usageRate"
      FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id
      WHERE ft.deleted_at IS NULL AND ft.transaction_date>=date_trunc('month',now())
      GROUP BY fc.id,b.display_name,v.registration_display ORDER BY amount DESC LIMIT 10`);
    const products = await this.db.query(`SELECT coalesce(product,'Non renseigné') AS product,sum(quantity_liters)::float AS liters,
      sum(amount_incl_tax)::float AS amount FROM fuel_transaction WHERE deleted_at IS NULL
      AND transaction_date>=date_trunc('month',now()) GROUP BY product ORDER BY amount DESC`);
    const risks = await this.db.query(`SELECT ft.id,fc.masked_card_number AS card,ft.transaction_date AS date,ft.station,ft.product,
      ft.quantity_liters::float AS liters,ft.amount_incl_tax::float AS amount,
      CASE
        WHEN ft.validation_status='BILLING_MISMATCH' THEN 'Écart de facturation'
        WHEN lag(ft.transaction_date) OVER(PARTITION BY ft.fuel_card_id ORDER BY ft.transaction_date) > ft.transaction_date-interval '90 minutes' THEN 'Deux pleins rapprochés'
        WHEN extract(hour FROM ft.transaction_date)<5 OR extract(hour FROM ft.transaction_date)>=23 THEN 'Horaire inhabituel'
        ELSE null END AS reason
      FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
      WHERE ft.deleted_at IS NULL AND ft.transaction_date>=now()-interval '90 days'
      ORDER BY ft.transaction_date DESC`);
    return { ...kpis[0], ...overview, migrations, companies, monthly, topConsumers, products,
      risks: risks.filter((row:{reason:string|null})=>row.reason).slice(0,25) };
  }
}
