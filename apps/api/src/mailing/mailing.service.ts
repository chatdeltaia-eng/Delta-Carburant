import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { setDefaultResultOrder } from 'node:dns';

@Injectable()
export class MailingService {
  private readonly logger = new Logger(MailingService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string | undefined;

  constructor() {
    // Render ne fournit pas toujours de route IPv6 sortante alors que Gmail
    // publie des adresses AAAA. Préférer IPv4 évite ENETUNREACH sans désactiver
    // les alertes opérationnelles.
    setDefaultResultOrder('ipv4first');
    const host = process.env.SMTP_HOST?.trim();
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASSWORD?.trim();
    this.from = process.env.MAIL_FROM?.trim() || user;
    this.transporter = host && user && pass ? nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user, pass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 15_000,
    }) : null;
  }

  configured() { return Boolean(this.transporter && this.from); }

  async send(to: string[], subject: string, html: string) {
    if (!this.transporter || !this.from) {
      this.logger.warn(`E-mail non envoyé (${subject}) : configuration SMTP absente`);
      return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
    }
    const info = await this.transporter.sendMail({ from: this.from, to, subject, html });
    return { sent: true, messageId: info.messageId };
  }

  async sendDirectionOperation(operation: {
    actorEmail: string;
    actorRole: string;
    method: string;
    path: string;
    entityId?: string;
    occurredAt: Date;
  }) {
    const recipients = (process.env.DIRECTION_MAIL_TO || 'khaled.sfaxi@deltacuisine.com')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const appUrl = process.env.APPLICATION_URL || process.env.WEB_ORIGIN || 'http://localhost:3000';
    const escape = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]!);
    const operationName = `${operation.method} ${operation.path.split('?')[0]}`;
    return this.send(recipients, `Opération Delta Carburant — ${operationName}`, `
      <div style="font-family:Arial,sans-serif;max-width:720px;color:#173b2b">
        <h2>Nouvelle opération dans Delta Carburant</h2>
        <p>Une opération a été réalisée avec succès dans l'application.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px;border:1px solid #dce4e0"><b>Utilisateur</b></td><td style="padding:8px;border:1px solid #dce4e0">${escape(operation.actorEmail)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #dce4e0"><b>Rôle</b></td><td style="padding:8px;border:1px solid #dce4e0">${escape(operation.actorRole)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #dce4e0"><b>Opération</b></td><td style="padding:8px;border:1px solid #dce4e0">${escape(operationName)}</td></tr>
          ${operation.entityId ? `<tr><td style="padding:8px;border:1px solid #dce4e0"><b>Référence</b></td><td style="padding:8px;border:1px solid #dce4e0">${escape(operation.entityId)}</td></tr>` : ''}
          <tr><td style="padding:8px;border:1px solid #dce4e0"><b>Date</b></td><td style="padding:8px;border:1px solid #dce4e0">${escape(operation.occurredAt.toLocaleString('fr-TN'))}</td></tr>
        </table>
        <p style="margin-top:24px"><a href="${escape(appUrl)}" style="background:#16856a;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Ouvrir l'application</a></p>
      </div>`);
  }
}
