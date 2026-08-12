import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { TransactionsService } from '../transactions/transactions.service';

type Actor = { sub: string; email: string };
type ConfigDto = {
  customerId: string;
  customerNumber: string;
  siteNumber: string;
  userId?: string;
  username?: string;
  refreshToken: string;
  syncIntervalMinutes?: number;
};
type ConnectionRow = {
  id: string;
  customer_id: string;
  customer_number: string;
  site_number: string;
  user_id: string | null;
  username: string | null;
  refresh_token_ciphertext: string;
  last_success_at: Date | string | null;
};
type RemoteTransaction = {
  transactionDate?: string;
  transactionTime?: string;
  samTransactionNumber?: number;
  samNumber?: number;
  applicationTransactionCounter?: number;
  approvalNumber?: number | string;
  authorisationCode?: number | string;
  productName?: string;
  unitPrice?: number;
  totalAmount?: number;
  transactedAmount?: number;
  transactionVolume?: number;
  volume?: number;
  stationName?: string;
  cardNumber?: string;
  cardHolderName?: string;
  registrationPlate?: string;
  currentMileage?: string;
  previousMileage?: string;
  transactionStatus?: string;
};

@Injectable()
export class TotalMobilityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TotalMobilityService.name);
  private timer?: NodeJS.Timeout;
  private readonly endpoint =
    'https://customer.fleet.totalenergies.com/tn/api/transaction/online/api/v1/report/list';
  private readonly tokenEndpoint =
    'https://tte-pool-prod.auth.eu-central-1.amazoncognito.com/oauth2/token';
  private readonly clientId = '75e7et2c904672c940ct6pcie8';
  private readonly applicationId = '2657f67d-1b24-4c31-af22-a0ba72df0623';
  private readonly initialExtractionDate = '2026-08-01';
  constructor(
    private readonly db: DatabaseService,
    private readonly transactions: TransactionsService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.scheduledSync(), 60_000);
    this.timer.unref();
    setTimeout(() => void this.scheduledSync(), 15_000).unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private key() {
    return createHash('sha256')
      .update(process.env.CARD_ENCRYPTION_KEY ?? 'delta-development-card-key')
      .digest();
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv),
      data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  }
  private decrypt(value: string) {
    const [iv, tag, data] = value.split('.');
    if (!iv || !tag || !data) throw new Error('Secret Total illisible');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  async status() {
    const rows = await this.db
      .query(`SELECT customer_number AS "customerNumber",site_number AS "siteNumber",username,enabled,
    sync_interval_minutes AS "syncIntervalMinutes",last_sync_at AS "lastSyncAt",last_success_at AS "lastSuccessAt",last_error AS "lastError",updated_at AS "updatedAt"
    FROM total_mobility_connection LIMIT 1`);
    return rows[0] ?? { connected: false };
  }
  async runs() {
    return this.db
      .query(`SELECT id,started_at AS "startedAt",finished_at AS "finishedAt",status,fetched_rows AS "fetchedRows",
    imported_rows AS "importedRows",duplicate_rows AS "duplicateRows",review_rows AS "reviewRows",error_message AS "errorMessage",metadata
    FROM total_mobility_sync_run ORDER BY started_at DESC LIMIT 50`);
  }
  async connect(dto: ConfigDto, actor: Actor) {
    const refreshToken = this.normalizeRefreshToken(dto.refreshToken);
    try {
      await this.refreshAccessToken(refreshToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(
        `Connexion Total refusée : ${message}. Reconnectez-vous à Total Mobility puis copiez de nouveau la valeur refresh_token depuis Application → Local Storage.`,
      );
    }
    await this.db.query(
      `INSERT INTO total_mobility_connection(customer_id,customer_number,site_number,user_id,username,refresh_token_ciphertext,
      sync_interval_minutes,connected_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT((true)) DO UPDATE SET customer_id=excluded.customer_id,customer_number=excluded.customer_number,site_number=excluded.site_number,
      user_id=excluded.user_id,username=excluded.username,refresh_token_ciphertext=excluded.refresh_token_ciphertext,
      sync_interval_minutes=excluded.sync_interval_minutes,connected_by=excluded.connected_by,enabled=true,last_error=null,updated_at=now()`,
      [
        dto.customerId.trim(),
        dto.customerNumber.trim(),
        dto.siteNumber.trim(),
        dto.userId?.trim() || null,
        dto.username?.trim() || null,
        this.encrypt(refreshToken),
        dto.syncIntervalMinutes ?? 60,
        actor.sub,
      ],
    );
    await this.db.query(
      `INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'CONNECT_TOTAL_MOBILITY','integration','TOTAL_MOBILITY',$2)`,
      [
        actor.email,
        {
          customerNumber: dto.customerNumber,
          siteNumber: dto.siteNumber,
          interval: dto.syncIntervalMinutes ?? 60,
        },
      ],
    );
    return {
      connected: true,
      passwordStored: false,
      syncIntervalMinutes: dto.syncIntervalMinutes ?? 60,
    };
  }
  async reconnect(refreshTokenValue: string, actor: Actor) {
    const refreshToken = this.normalizeRefreshToken(refreshTokenValue);
    try {
      await this.refreshAccessToken(refreshToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Reconnexion Total refusée : ${message}`);
    }
    const updated = await this.db.query<{ id: string }>(
      `UPDATE total_mobility_connection SET refresh_token_ciphertext=$1,enabled=true,last_error=null,
       connected_by=$2,updated_at=now() RETURNING id`,
      [this.encrypt(refreshToken), actor.sub],
    );
    if (!updated[0])
      throw new BadRequestException(
        'La connexion Total initiale doit être configurée une seule fois par un administrateur',
      );
    await this.db.query(
      `INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
       VALUES($1,'RECONNECT_TOTAL_MOBILITY','integration','TOTAL_MOBILITY',$2)`,
      [actor.email, { automatic: true }],
    );
    return { connected: true };
  }
  async toggle(enabled: boolean, email: string) {
    await this.db.query(
      `UPDATE total_mobility_connection SET enabled=$1,updated_at=now()`,
      [enabled],
    );
    await this.db.query(
      `INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'TOGGLE_TOTAL_MOBILITY','integration','TOTAL_MOBILITY',$2)`,
      [email, { enabled }],
    );
    return { enabled };
  }
  private async scheduledSync() {
    const due = await this.db.query<{
      sub: string;
      email: string;
    }>(`SELECT c.connected_by AS sub,u.email FROM total_mobility_connection c JOIN app_user u ON u.id=c.connected_by
      WHERE c.enabled AND (c.last_sync_at IS NULL OR c.last_sync_at<=now()-make_interval(mins=>c.sync_interval_minutes)) LIMIT 1`);
    if (due[0])
      try {
        await this.syncNow(due[0]);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  async syncNow(actor: Actor, requestedFromDate?: string) {
    const lock = await this.db.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('delta-total-mobility-sync')) AS locked`,
    );
    if (!lock[0]?.locked)
      return {
        status: 'SKIPPED',
        message: 'Une synchronisation est déjà en cours',
      };
    let runId: string | undefined;
    try {
      const config = (
        await this.db.query<ConnectionRow>(
          `SELECT * FROM total_mobility_connection WHERE enabled LIMIT 1`,
        )
      )[0];
      if (!config)
        throw new BadRequestException(
          'Connexion Total Mobility non configurée ou désactivée',
        );
      runId = (
        await this.db.query<{ id: string }>(
          `INSERT INTO total_mobility_sync_run(connection_id) VALUES($1) RETURNING id`,
          [config.id],
        )
      )[0].id;
      await this.db.query(
        `UPDATE total_mobility_connection SET last_sync_at=now(),updated_at=now() WHERE id=$1`,
        [config.id],
      );
      const token = await this.refreshAccessToken(
        this.decrypt(config.refresh_token_ciphertext),
      );
      // Chaque passage est un instantané complet. L'ancien état de la période
      // est remplacé dans la même transaction seulement après réception de Total.
      const fromDate = requestedFromDate ?? this.initialExtractionDate;
      const remote = await this.fetchAll(config, token, fromDate);
      const rows = remote.map((r, index) => this.mapTransaction(r, index));
      const result = rows.length
        ? await this.transactions.import(
            {
              filename: `TOTAL_MOBILITY_${new Date().toISOString()}.json`,
              rows,
              replaceFrom: fromDate,
            },
            actor,
          )
        : { imported: 0, duplicates: 0, pendingReview: 0 };
      await this.db.query(
        `UPDATE total_mobility_sync_run SET finished_at=now(),status=$2,fetched_rows=$3,imported_rows=$4,duplicate_rows=$5,review_rows=$6,metadata=$7 WHERE id=$1`,
        [
          runId,
          result.pendingReview ? 'PARTIAL' : 'SUCCESS',
          rows.length,
          result.imported,
          result.duplicates,
          result.pendingReview,
          {
            source: 'TOTAL_MOBILITY_API',
            dateFrom: fromDate,
            dateTo: new Date().toISOString(),
          },
        ],
      );
      await this.db.query(
        `UPDATE total_mobility_connection SET last_success_at=now(),last_error=null,updated_at=now() WHERE id=$1`,
        [config.id],
      );
      return {
        status: result.pendingReview ? 'PARTIAL' : 'SUCCESS',
        fetched: rows.length,
        dateFrom: fromDate,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId)
        await this.db.query(
          `UPDATE total_mobility_sync_run SET finished_at=now(),status='FAILED',error_message=$2 WHERE id=$1`,
          [runId, message.slice(0, 1000)],
        );
      await this.db.query(
        `UPDATE total_mobility_connection SET last_error=$1,updated_at=now()`,
        [message.slice(0, 1000)],
      );
      await this.notifyFailure(message);
      throw new BadGatewayException(
        `Synchronisation Total impossible : ${message}`,
      );
    } finally {
      await this.db.query(
        `SELECT pg_advisory_unlock(hashtext('delta-total-mobility-sync'))`,
      );
    }
  }
  private async refreshAccessToken(refreshToken: string) {
    if (!refreshToken || refreshToken.length < 20)
      throw new Error('le refresh_token est absent ou incomplet');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken,
    });
    let response: Response;
    try {
      response = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('le service d’authentification Total est momentanément inaccessible');
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        error_description?: string;
      } | null;
      const reason = payload?.error_description || payload?.error;
      throw new Error(
        reason
          ? `session Total invalide ou expirée (${reason})`
          : `session Total invalide ou expirée (HTTP ${response.status})`,
      );
    }
    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token)
      throw new Error('Total n’a pas retourné de jeton d’accès');
    return json.access_token;
  }
  private normalizeRefreshToken(value: string) {
    let token = value.trim();
    // Chrome peut copier la valeur JSON avec ses guillemets, ou la paire clé/valeur.
    const assignment = token.match(/^(?:["']?refresh_token["']?\s*[:=]\s*)([\s\S]+)$/i);
    if (assignment) token = assignment[1].trim();
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      try {
        token = JSON.parse(token) as string;
      } catch {
        token = token.slice(1, -1);
      }
    }
    return token.trim();
  }
  private signature(payload: string, nonce: string, token: string) {
    const secret = token.trim().slice(0, 16) + token.trim().slice(-16);
    return createHmac('sha256', secret)
      .update(payload + nonce)
      .digest('base64');
  }
  private async fetchAll(
    config: ConnectionRow,
    token: string,
    requestedFromDate?: string,
  ) {
    const results: RemoteTransaction[] = [];
    const now = new Date();
    const from = requestedFromDate
      ? new Date(`${requestedFromDate}T00:00:00+01:00`)
      : new Date(config.last_success_at ?? `${this.initialExtractionDate}T00:00:00+01:00`);
    if (Number.isNaN(from.getTime())) throw new Error('date de début invalide');
    if (!requestedFromDate) from.setHours(from.getHours() - 6);
    for (let page = 0; page < 100; page++) {
      const correlation = randomUUID(),
        payload: Record<string, unknown> = {
          AccessToken: '',
          ApplicationId: this.applicationId,
          CardNumber: '',
          CorrelationId: correlation,
          Country: 'All',
          CustomerId: config.customer_id,
          CustomerName: '',
          CustomerNumber: config.customer_number,
          DateFrom: this.formatDate(from, false),
          DateTo: this.formatDate(now, true),
          DivisionName: '',
          ExpandClient: 'Total',
          ExpandProduct: 'MyFuel',
          ExportToExcel: false,
          FilterExpression: '',
          IntraUserId: '',
          LanguageId: 'b25a7eda-f295-11e2-a0ca-000c2976e124',
          Locale: '',
          NameOnCard: '',
          NewSearch: false,
          NodeNumber: '',
          NodeTypeNumber: 10,
          PageSize: 100,
          PartnerId: '0',
          PhantomCardNumber: '',
          ReportType: 4,
          RequestId: '',
          SendEmail: false,
          SiteNumber: config.site_number,
          SortExpression: '',
          StartIndex: page * 100 + 1,
          UIRoute: '/transaction/online/api/v1/report/list',
          UsePartner: false,
          UserId: config.user_id ?? '',
          UserName: '',
          UserSessionId: '',
          UserSite: '',
          VehicleRegistrationNumber: '',
          Version: '',
          WorkFlowId: '',
          usersname: config.username ?? '',
        };
      const raw = JSON.stringify(payload),
        nonce = createHash('sha256')
          .update(new Date().toString())
          .digest('hex');
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: token,
          applicationid: this.applicationId,
          correlationid: correlation,
          'x-request-id': this.signature(raw, nonce, token),
          'x-request-nonce': nonce,
        },
        body: raw,
      });
      if (!response.ok) throw new Error(`API Total ${response.status}`);
      const json: unknown = await response.json();
      const pageRows = this.findTransactions(json);
      results.push(...pageRows);
      if (pageRows.length < 100) break;
    }
    return results;
  }
  private findTransactions(value: unknown): RemoteTransaction[] {
    if (Array.isArray(value)) {
      if (
        value.some(
          (v) =>
            v &&
            typeof v === 'object' &&
            ('transactionDate' in v || 'cardNumber' in v),
        )
      )
        return value as RemoteTransaction[];
      for (const item of value) {
        const found = this.findTransactions(item);
        if (found.length) return found;
      }
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        const found = this.findTransactions(item);
        if (found.length) return found;
      }
    }
    return [];
  }
  private formatDate(date: Date, end: boolean) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${end ? '23:59:59' : '00:00:00'}`;
  }
  private mapTransaction(row: RemoteTransaction, index: number) {
    if (!row.transactionDate || !row.cardNumber)
      throw new Error(`Transaction Total incomplète à la ligne ${index + 1}`);
    const match = row.transactionDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) throw new Error(`Date Total invalide : ${row.transactionDate}`);
    const time = (row.transactionTime ?? '00:00').match(
      /^(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!time) throw new Error(`Heure Total invalide : ${row.transactionTime}`);
    const date = `${match[3]}-${match[2]}-${match[1]}T${time[1]}:${time[2]}:${time[3] ?? '00'}+01:00`;
    const approval = String(
      row.approvalNumber ?? row.authorisationCode ?? '',
    ).trim();
    const providerIdentity = [
      row.samNumber,
      row.samTransactionNumber,
      row.applicationTransactionCounter,
    ].every((value) => value !== undefined)
      ? `SAM:${row.samNumber}:${row.samTransactionNumber}:${row.applicationTransactionCounter}`
      : undefined;
    return {
      date,
      cardNumber: row.cardNumber,
      vehicle: row.registrationPlate ?? '',
      beneficiary: row.cardHolderName ?? '',
      station: row.stationName ?? 'STATION TOTAL',
      product: row.productName ?? 'PRODUIT TOTAL',
      liters: Number(row.transactionVolume ?? row.volume ?? 0),
      amount: Number(row.totalAmount ?? row.transactedAmount ?? 0),
      previousMileage: Number(row.previousMileage) || undefined,
      mileage: Number(row.currentMileage) || undefined,
      authorizationCode: approval || providerIdentity,
      externalId: providerIdentity,
    };
  }
  private async notifyFailure(message: string) {
    await this.db.query(
      `INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id)
    SELECT id,'Synchronisation Total interrompue',$1,'CRITICAL','settings','integration',null FROM app_user WHERE active AND role IN('ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN')
    AND NOT EXISTS(SELECT 1 FROM notification n WHERE n.user_id=app_user.id AND n.title='Synchronisation Total interrompue' AND n.created_at>now()-interval '1 hour')`,
      [`La session Total doit être reconnectée : ${message.slice(0, 300)}`],
    );
  }
}
