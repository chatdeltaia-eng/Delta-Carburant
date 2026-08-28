import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MailingService } from './mailing.service';

type AnomalyRow = { id:string;type:string;severity:string;description:string;createdAt:string;company:string;card:string;vehicle:string };

@Injectable()
export class AnomalyMailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnomalyMailService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly db: DatabaseService, private readonly mail: MailingService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    void this.deliverPending();
    const interval = Math.max(2, Number(process.env.ANOMALY_MAIL_INTERVAL_SECONDS || 5)) * 1000;
    this.timer = setInterval(() => void this.deliverPending(), interval);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async deliverPending() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.query<AnomalyRow>(`SELECT a.id::text,a.anomaly_type AS type,a.severity::text,
        a.description,a.created_at AS "createdAt",coalesce(c.code,'Non déterminée') AS company,
        coalesce(fc.masked_card_number,'—') AS card,coalesce(v.registration_display,'—') AS vehicle
        FROM anomaly a LEFT JOIN fuel_card fc ON fc.id=a.fuel_card_id
        LEFT JOIN vehicle v ON v.id=a.vehicle_id
        LEFT JOIN company c ON c.id=coalesce(fc.company_id,v.company_id)
        WHERE a.status IN('OPEN','IN_REVIEW') AND NOT EXISTS(SELECT 1 FROM management_mail_log ml
          WHERE ml.report_type='ANOMALY_REALTIME' AND ml.status='SENT' AND ml.details->>'anomalyId'=a.id::text)
        ORDER BY a.created_at LIMIT 50`);
      for (const anomaly of rows) await this.sendAnomaly(anomaly);
    } catch (error) { this.logger.error(`Envoi temps réel des anomalies impossible : ${this.message(error)}`); }
    finally { this.running = false; }
  }

  private async sendAnomaly(anomaly: AnomalyRow) {
    const recipients=(process.env.ANOMALY_MAIL_TO||process.env.DIRECTION_MAIL_TO||'khaled.sfaxi@deltacuisine.com').split(',').map(v=>v.trim()).filter(Boolean);
    const appUrl=process.env.APPLICATION_URL||process.env.WEB_ORIGIN||'http://localhost:3000';
    try {
      const result=await this.mail.send(recipients,`Alerte anomalie ${anomaly.company} — ${anomaly.type}`,`<div style="font-family:Arial,sans-serif;max-width:760px;color:#18344a"><h2 style="color:#c62828">Nouvelle anomalie détectée</h2><p>Delta Carburant a détecté automatiquement une anomalie nécessitant votre attention.</p><table style="width:100%;border-collapse:collapse">${this.row('Société',anomaly.company)}${this.row('Gravité',anomaly.severity)}${this.row('Type',anomaly.type)}${this.row('Carte',anomaly.card)}${this.row('Véhicule',anomaly.vehicle)}${this.row('Date',new Date(anomaly.createdAt).toLocaleString('fr-TN'))}${this.row('Détail',anomaly.description)}</table><p style="margin-top:24px"><a href="${this.escape(appUrl)}" style="background:#126bc5;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Consulter l'anomalie</a></p></div>`);
      await this.db.query(`INSERT INTO management_mail_log(report_type,recipients,status,details) VALUES('ANOMALY_REALTIME',$1,$2,$3)`,[recipients,result.sent?'SENT':'SKIPPED',{anomalyId:anomaly.id,...result}]);
      if(result.sent)this.logger.log(`Anomalie ${anomaly.id} envoyée à ${recipients.join(', ')}`);
    } catch(error) {
      await this.db.query(`INSERT INTO management_mail_log(report_type,recipients,status,details) VALUES('ANOMALY_REALTIME',$1,'FAILED',$2)`,[recipients,{anomalyId:anomaly.id,error:this.message(error)}]);
      this.logger.error(`Anomalie ${anomaly.id} non envoyée : ${this.message(error)}`);
    }
  }
  private row(label:string,value:string){return `<tr><td style="padding:9px;border:1px solid #d9e2ea;width:145px"><b>${this.escape(label)}</b></td><td style="padding:9px;border:1px solid #d9e2ea">${this.escape(value)}</td></tr>`;}
  private escape(value:string){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]!));}
  private message(error:unknown){return error instanceof Error?error.message:'erreur inconnue';}
}
