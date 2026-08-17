import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MailingService } from './mailing.service';

type FollowupRow = { card: string; company: string; responsible: string; status: string; monthlyLimit: number; consumed: number; usageRate: number };

@Injectable()
export class CardFollowupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CardFollowupService.name);
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: DatabaseService, private readonly mail: MailingService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    void this.runScheduled();
    this.timer = setInterval(() => void this.runScheduled(), 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async summary() {
    const rows = await this.db.query<FollowupRow>(`SELECT fc.masked_card_number AS card,c.code AS company,
      coalesce(u.display_name,'Non affecté') AS responsible,fc.status::text,
      fc.monthly_limit::float AS "monthlyLimit",coalesce(sum(ft.amount_incl_tax),0)::float AS consumed,
      CASE WHEN fc.monthly_limit>0 THEN round(100*coalesce(sum(ft.amount_incl_tax),0)/fc.monthly_limit,1)::float ELSE 0 END AS "usageRate"
      FROM fuel_card fc JOIN company c ON c.id=fc.company_id LEFT JOIN app_user u ON u.id=fc.responsible_user_id
      LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL
        AND ft.transaction_date>=date_trunc('month',current_date)
      WHERE fc.deleted_at IS NULL GROUP BY fc.id,c.code,u.display_name ORDER BY "usageRate" DESC`);
    const critical = rows.filter(row => row.usageRate >= Number(process.env.CARD_LIMIT_ALERT_PERCENT || 90));
    const anomalies = await this.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM anomaly WHERE status IN('OPEN','IN_REVIEW')`);
    return { generatedAt: new Date(), totalCards: rows.length, criticalCards: critical.length, openAnomalies: Number(anomalies[0]?.count || 0), rows, critical };
  }

  async sendDirectionReport(reason = 'MANUAL') {
    const report = await this.summary();
    const recipients = (process.env.DIRECTION_MAIL_TO || 'khaled.sfaxi@deltacuisine.com').split(',').map(x => x.trim()).filter(Boolean);
    const appUrl = process.env.APPLICATION_URL || process.env.WEB_ORIGIN || 'http://localhost:3000';
    const rows = report.critical.map(row => `<tr><td>${this.escape(row.card)}</td><td>${this.escape(row.company)}</td><td>${this.escape(row.responsible)}</td><td>${row.consumed.toFixed(3)} / ${row.monthlyLimit.toFixed(3)} TND</td><td><b>${row.usageRate.toFixed(1)} %</b></td></tr>`).join('');
    const result = await this.mail.send(recipients, `Suivi cartes carburant — ${new Date().toLocaleDateString('fr-TN')}`, `<div style="font-family:Arial,sans-serif;max-width:900px;color:#173b2b"><h2>Situation des cartes du groupe</h2><p>Rapport automatique de suivi Delta Carburant.</p><p><b>${report.totalCards}</b> cartes suivies · <b>${report.criticalCards}</b> cartes plafonnées ou proches du plafond · <b>${report.openAnomalies}</b> anomalies ouvertes.</p><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#163d2e;color:#fff"><th>Carte</th><th>Société</th><th>Responsable</th><th>Consommation</th><th>Taux</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="padding:15px">Aucune carte au seuil d’alerte.</td></tr>'}</tbody></table><p style="margin-top:24px"><a href="${this.escape(appUrl)}" style="background:#16856a;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Ouvrir Delta Carburant</a></p></div>`);
    await this.db.query(`INSERT INTO management_mail_log(report_type,recipients,status,details) VALUES('CARD_FOLLOWUP',$1,$2,$3)`, [recipients, result.sent ? 'SENT' : 'SKIPPED', { reason, ...result }]);
    return { ...result, recipients, report };
  }

  private async runScheduled() {
    try {
      await this.createCardAlerts();
      const hour = Number(process.env.DIRECTION_MAIL_HOUR || 8);
      const now = new Date();
      if (now.getHours() !== hour) return;
      const sent = await this.db.query(`SELECT 1 FROM management_mail_log WHERE report_type='CARD_FOLLOWUP' AND created_at::date=current_date AND status='SENT' LIMIT 1`);
      if (!sent.length) await this.sendDirectionReport('DAILY_SCHEDULE');
    } catch (error) { this.logger.error(`Rapport de suivi non envoyé : ${error instanceof Error ? error.message : 'erreur inconnue'}`); }
  }
  private async createCardAlerts() {
    const threshold = Number(process.env.CARD_LIMIT_ALERT_PERCENT || 90);
    await this.db.query(`WITH consumption AS (
      SELECT fc.id,fc.responsible_user_id,fc.masked_card_number,fc.monthly_limit,
        coalesce(sum(ft.amount_incl_tax),0) AS consumed
      FROM fuel_card fc LEFT JOIN fuel_transaction ft ON ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL
        AND ft.transaction_date>=date_trunc('month',current_date)
      WHERE fc.deleted_at IS NULL AND fc.monthly_limit>0 GROUP BY fc.id
    ), recipients AS (
      SELECT c.id AS card_id,c.masked_card_number,c.monthly_limit,c.consumed,u.id AS user_id
      FROM consumption c JOIN app_user u ON u.active AND (u.id=c.responsible_user_id OR u.role::text IN ('DIRECTION_GENERAL','ZIN_FINANCE','SUPER_ADMIN'))
      WHERE 100*c.consumed/c.monthly_limit >= $1
    ) INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
      SELECT r.user_id,'Alerte plafond carte',format('La carte %s a consommé %s %% de son plafond mensuel.',r.masked_card_number,round(100*r.consumed/r.monthly_limit,1)),
        CASE WHEN r.consumed>=r.monthly_limit THEN 'CRITICAL'::issue_severity ELSE 'HIGH'::issue_severity END,'cards','fuel_card',r.card_id
      FROM recipients r WHERE NOT EXISTS (SELECT 1 FROM notification n WHERE n.user_id=r.user_id AND n.entity_id=r.card_id AND n.title='Alerte plafond carte' AND n.created_at::date=current_date)`, [threshold]);
  }
  private escape(value: string) { return value.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]!)); }
}
