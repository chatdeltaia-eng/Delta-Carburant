import { Injectable, Logger } from '@nestjs/common';

type LoginAlert = {
  name: string;
  email: string;
  role: string;
  ip: string;
  userAgent: string;
  occurredAt: Date;
};

@Injectable()
export class LoginAlertService {
  private readonly logger = new Logger(LoginAlertService.name);
  private readonly recipient = process.env.LOGIN_ALERT_TO?.trim() || 'Khaled.sfaxi@deltacuisine.com';

  async send(event: LoginAlert): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.LOGIN_ALERT_FROM?.trim();
    if (!apiKey || !from) {
      this.logger.warn('Alerte de connexion non envoyée : RESEND_API_KEY ou LOGIN_ALERT_FROM absent');
      return;
    }
    const role = event.role === 'DIRECTION_GENERAL' || event.role === 'SUPER_ADMIN'
      ? 'Direction générale / Administrateur'
      : event.role === 'ZIN_FINANCE' ? 'Zin Finance' : event.role === 'NAJIB_ASSIGNER' ? 'Najib' : event.role;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [this.recipient],
          subject: `Connexion Delta Carburant — ${event.name}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:620px;padding:28px;color:#173b2b"><h2 style="margin:0 0 18px">Nouvelle session ouverte</h2><p>Une connexion sécurisée vient d’être effectuée sur Delta Carburant.</p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:9px;background:#f2f7f5">Utilisateur</td><td style="padding:9px"><b>${this.escape(event.name)}</b></td></tr><tr><td style="padding:9px;background:#f2f7f5">Rôle</td><td style="padding:9px">${this.escape(role)}</td></tr><tr><td style="padding:9px;background:#f2f7f5">Compte</td><td style="padding:9px">${this.escape(event.email)}</td></tr><tr><td style="padding:9px;background:#f2f7f5">Date et heure</td><td style="padding:9px">${event.occurredAt.toLocaleString('fr-TN', { timeZone: 'Africa/Tunis' })}</td></tr><tr><td style="padding:9px;background:#f2f7f5">Adresse IP</td><td style="padding:9px">${this.escape(event.ip)}</td></tr><tr><td style="padding:9px;background:#f2f7f5">Appareil</td><td style="padding:9px">${this.escape(event.userAgent)}</td></tr></table><p style="margin-top:20px;color:#65796f;font-size:12px">Si cette connexion n’est pas reconnue, révoquez immédiatement la session et changez le mot de passe du compte.</p></div>`,
        }),
      });
      if (!response.ok) this.logger.error(`Échec de l’alerte de connexion (${response.status})`);
    } catch (error) {
      this.logger.error(`Échec de l’alerte de connexion : ${error instanceof Error ? error.message : 'erreur inconnue'}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private escape(value: string): string {
    return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
  }
}
