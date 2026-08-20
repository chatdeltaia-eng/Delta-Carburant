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
export type RemoteTransaction = {
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
export type RemoteCardStatus = {
  cardNumber: string;
  paymentMethodNumber?: string;
  status: string;
  holderName?: string;
  registration?: string;
  expiresOn?: string;
  monthlyLimit?: number;
  raw?: Record<string, unknown>;
};
export type RemoteDriver = {
  driverNumber: string;
  firstName: string;
  lastName: string;
  driverCode?: string;
  status?: string;
  raw?: Record<string, unknown>;
};
export type RemoteVehicle = {
  registration: string;
  mileage?: number;
  status?: string;
  brand?: string;
  model?: string;
  driverNumber?: string;
  driverName?: string;
  raw?: Record<string, unknown>;
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
    // Le connecteur est désormais un miroir quasi temps réel : normaliser les
    // anciennes configurations qui pouvaient encore attendre 15 à 120 min.
    void this.db.query(`UPDATE total_mobility_connection SET sync_interval_minutes=1 WHERE sync_interval_minutes<>1`);
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
  async cardReconciliation() {
    return this.db.query(`SELECT fc.id,fc.masked_card_number AS "cardNumber",fc.status AS "applicationStatus",
      fc.total_mobility_status AS "totalStatus",fc.total_mobility_checked_at AS "checkedAt",
      u.display_name AS "responsibleName",
      CASE WHEN fc.total_mobility_checked_at IS NULL THEN 'NOT_EXTRACTED'
        WHEN fc.status='SAFE' AND upper(coalesce(fc.total_mobility_status,'')) NOT IN ('INACTIVE','BLOCKED','SUSPENDED','OPPOSED','CANCELLED') THEN 'MISMATCH'
        WHEN fc.status IN ('ACTIVE','DISTRIBUTED','ASSIGNED') AND upper(coalesce(fc.total_mobility_status,'')) NOT IN ('ACTIVE','ACTIVATED') THEN 'MISMATCH'
        ELSE 'COMPLIANT' END AS conformity,
      pending.id AS "pendingActionId",pending.action_type AS "pendingAction"
      FROM fuel_card fc LEFT JOIN app_user u ON u.id=fc.responsible_user_id
      LEFT JOIN LATERAL (SELECT a.id,a.action_type FROM total_mobility_card_action a
        WHERE a.fuel_card_id=fc.id AND a.status='PENDING' ORDER BY a.requested_at DESC LIMIT 1) pending ON true
      WHERE fc.deleted_at IS NULL ORDER BY conformity DESC,fc.masked_card_number`);
  }
  async importCardStatuses(cards: RemoteCardStatus[], actor: Actor, clientName?: string) {
    if (!cards.length) throw new BadRequestException('Aucun statut de carte trouvé dans « Gérer les cartes » sur Total Mobility');
    return this.db.transaction(async client => {
      const totalName=String(clientName??'').trim();
      let company:{id:string;code:string}|undefined;
      if(totalName){
        const aliases:Record<string,string>={
          'DELTA CUISINE':'DC','IKIT TN':'IKIT','STE LES TECHNIQUES DE MARBRE':'TCM','DELTA CUISINE DISTRIBUTION':'DCD',
        };
        const normalized=totalName.toUpperCase().replace(/[^A-Z0-9]/g,'');
        const found=await client.query<{id:string;code:string}>(`SELECT id,code FROM company
          WHERE active AND (regexp_replace(upper(name),'[^A-Z0-9]','','g')=$1 OR upper(code)=$2) LIMIT 1`,
          [normalized,aliases[totalName.toUpperCase()]??'']);
        company=found.rows[0];
        if(!company){
          const baseCode=aliases[totalName.toUpperCase()]??totalName.split(/\s+/).map(word=>word[0]).join('').replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,8)??'TOTAL';
          const inserted=await client.query<{id:string;code:string}>(`INSERT INTO company(code,name) VALUES(
            CASE WHEN EXISTS(SELECT 1 FROM company WHERE upper(code)=upper($1)) THEN $1||substr(md5($2),1,3) ELSE $1 END,$2)
            RETURNING id,code`,[baseCode||'TOTAL',totalName]);
          company=inserted.rows[0];
        }
      }else{
        const configured=await client.query<{id:string;code:string}>(`SELECT c.id,c.code FROM company c WHERE EXISTS(
          SELECT 1 FROM driver d JOIN total_mobility_connection t ON regexp_replace(d.customer_number,'[^0-9]','','g')=regexp_replace(t.customer_number,'[^0-9]','','g')
          WHERE d.company_id=c.id AND t.enabled) LIMIT 1`);
        company=configured.rows[0];
      }
      if(!company)throw new BadRequestException(`Société introuvable pour le client Total ${totalName||'sélectionné'}`);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`total-cards:${company.id}`]);
      let matched=0,created=0,removed=0;
      const importedNumbers:string[]=[];
      for (const card of cards) {
        const number=this.normalizeCardNumber(card.cardNumber).padStart(4,'0');
        const remoteStatus=card.status.trim().toUpperCase();
        if(!number||!remoteStatus)continue;
        importedNumbers.push(number);
        await client.query(`INSERT INTO total_mobility_card_snapshot(card_number,remote_status,holder_name,registration,raw_data)
          VALUES($1,$2,$3,$4,$5)`,[number,remoteStatus,card.holderName??null,card.registration??null,card.raw??{}]);
        let updated=await client.query(`UPDATE fuel_card SET total_mobility_status=$3,total_mobility_checked_at=now(),
          official_card_number=coalesce(nullif($4,''),official_card_number),
          total_payment_number=coalesce(nullif($5,''),total_payment_number),
          holder_name=coalesce(nullif($6,''),holder_name),
          official_registration=coalesce(nullif($7,''),official_registration),
          expires_on=coalesce($8::date,expires_on),
          monthly_limit=CASE WHEN $9::numeric>0 THEN $9 ELSE monthly_limit END,updated_at=now()
          WHERE company_id=$1 AND deleted_at IS NULL AND (
            regexp_replace(masked_card_number,'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')
            OR regexp_replace(coalesce(official_card_number,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')
            OR ($5<>'' AND regexp_replace(coalesce(total_payment_number,''),'[^0-9]','','g')=regexp_replace($5,'[^0-9]','','g'))
          )
          RETURNING id,status`,[company.id,number,remoteStatus,number,this.normalizeCardNumber(card.paymentMethodNumber??''),
            card.holderName?.trim()??'',card.registration?.trim()??'',card.expiresOn??null,card.monthlyLimit??0]);
        if(!updated.rows[0]){
          const applicationStatus=/OPPOS|LOST|STOLEN|PERD|VOLE/.test(remoteStatus)?'OPPOSED'
            :/SUSPEND|BLOCK|BLOQU|TEMPORAIR/.test(remoteStatus)?'SUSPENDED'
            :/CANCEL|ANNULE|EXPIRE/.test(remoteStatus)?'CANCELLED':'TO_ASSIGN';
          const inserted=await client.query(`INSERT INTO fuel_card(company_id,card_number_ciphertext,card_number_hmac,masked_card_number,
            monthly_limit,status,card_category,total_mobility_status,total_mobility_checked_at,official_card_number,
            total_payment_number,holder_name,official_registration,expires_on)
            VALUES($1,pgp_sym_encrypt($2,$3,'cipher-algo=aes256'),hmac($2,$4,'sha256'),$2,$7,$5,'PERSONALIZED',$6,now(),
              $2,nullif($8,''),nullif($9,''),nullif($10,''),$11::date)
            ON CONFLICT(company_id,card_number_hmac) DO NOTHING RETURNING id,status`,[company.id,number,
            process.env.CARD_ENCRYPTION_KEY??'delta-development-card-key',process.env.CARD_HMAC_KEY??'delta-development-hmac-key',applicationStatus,remoteStatus,
            card.monthlyLimit??0,this.normalizeCardNumber(card.paymentMethodNumber??''),card.holderName?.trim()??'',card.registration?.trim()??'',card.expiresOn??null]);
          updated=inserted;
          if(inserted.rows[0])created++;
        }
        for(const local of updated.rows){
          matched++;
          const pending=await client.query(`SELECT id,action_type FROM total_mobility_card_action WHERE fuel_card_id=$1 AND status='PENDING'`,[local.id]);
          for(const action of pending.rows){
            const inactive=['INACTIVE','BLOCKED','SUSPENDED','OPPOSED','CANCELLED'].includes(remoteStatus);
            const active=['ACTIVE','ACTIVATED'].includes(remoteStatus);
            if((action.action_type==='DEACTIVATE'&&inactive)||(action.action_type==='ACTIVATE'&&active))
              await client.query(`UPDATE total_mobility_card_action SET status='CONFIRMED',confirmed_at=now(),confirmed_by=$2,remote_status=$3 WHERE id=$1`,[action.id,actor.sub,remoteStatus]);
          }
        }
      }
      // Retirer uniquement les lignes fantômes créées par les anciennes
      // versions de l'extracteur (0, 1, 10, etc.). Une carte ayant une
      // transaction ou une affectation n'est jamais touchée.
      await client.query(`UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
        WHERE fc.company_id=$1 AND fc.deleted_at IS NULL
          AND length(regexp_replace(fc.masked_card_number,'[^0-9]','','g'))<4
          AND fc.monthly_limit=0 AND fc.responsible_user_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM fuel_transaction ft WHERE ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM card_assignment ca WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL)`,[company.id]);
      // Nettoyer les lignes fantômes des anciennes versions (numéro lu depuis
      // le paginator, sans aucun détail réel provenant de Total).
      await client.query(`UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
        WHERE fc.company_id=$1 AND fc.deleted_at IS NULL AND fc.monthly_limit=0
          AND nullif(fc.total_payment_number,'') IS NULL
          AND nullif(fc.holder_name,'') IS NULL
          AND nullif(fc.official_registration,'') IS NULL
          AND fc.expires_on IS NULL AND fc.responsible_user_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM fuel_transaction ft WHERE ft.fuel_card_id=fc.id AND ft.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM card_assignment ca WHERE ca.fuel_card_id=fc.id AND ca.ends_at IS NULL)`,[company.id]);
      // DELTA CUISINE possède exactement 43 cartes dans Total Mobility. Une
      // extraction incomplète ne doit jamais supprimer de données ; en
      // revanche, lorsque les 43 cartes sont confirmées, la liste distante
      // devient le référentiel officiel et toutes les autres lignes locales
      // sont archivées comme données parasites. Le soft-delete conserve les
      // transactions et la piste d'audit historiques.
      const officialNumbers=[...new Set(importedNumbers)];
      if(company.code==='DC'&&officialNumbers.length===43){
        const cleanup=await client.query(`UPDATE fuel_card fc SET deleted_at=now(),updated_at=now()
          WHERE fc.company_id=$1 AND fc.deleted_at IS NULL
            AND NOT (regexp_replace(coalesce(fc.official_card_number,fc.masked_card_number), '[^0-9]', '', 'g') = ANY($2::text[]))
          RETURNING fc.id`,[company.id,officialNumbers]);
        removed=cleanup.rowCount??0;
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values)
        VALUES($1,'IMPORT_TOTAL_CARD_STATUSES','integration','TOTAL_MOBILITY_CARDS',$2)`,[actor.email,{client:totalName,company:company.code,extracted:cards.length,matched,created,removed}]);
      return {client:totalName,company:company.code,extracted:cards.length,matched,created,removed,unmatched:cards.length-matched};
    });
  }
  async importDrivers(drivers: RemoteDriver[], actor: Actor, clientName?: string) {
    if (!drivers.length) throw new BadRequestException('Aucun chauffeur trouvé dans « Gestion des chauffeurs » sur Total Mobility');
    const [connection]=await this.db.query<{customer_number:string}>(`SELECT customer_number FROM total_mobility_connection WHERE enabled LIMIT 1`);
    const aliases:Record<string,string>={'DELTA CUISINE':'DC','IKIT TN':'IKIT','STE LES TECHNIQUES DE MARBRE':'TCM','DELTA CUISINE DISTRIBUTION':'DCD'};
    const requestedCode=aliases[String(clientName??'').trim().toUpperCase()]??'';
    const [company]=await this.db.query<{id:string;code:string;customer_name:string}>(`SELECT c.id,c.code,
      coalesce((SELECT nullif(d.customer_name,'') FROM driver d WHERE d.company_id=c.id AND regexp_replace(coalesce(d.customer_number,''),'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g') AND d.deleted_at IS NULL AND nullif(d.customer_name,'') IS NOT NULL ORDER BY d.created_at LIMIT 1),c.name) customer_name
      FROM company c WHERE ($2<>'' AND c.code=$2) OR ($2='' AND EXISTS(SELECT 1 FROM driver d WHERE d.company_id=c.id AND regexp_replace(coalesce(d.customer_number,''),'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g'))) ORDER BY CASE WHEN c.code=$2 THEN 0 ELSE 1 END,c.created_at LIMIT 1`,[connection?.customer_number??'',requestedCode]);
    if(!company)throw new BadRequestException(`Aucune société de l'application ne correspond au client Total ${connection?.customer_number??'inconnu'}`);
    return this.db.transaction(async client=>{
      // Prevent two scheduled/manual synchronizations from both observing a
      // missing driver and attempting the same INSERT.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`total-drivers:${company.id}`]);
      let created=0,updated=0,keyConflicts=0;
      for(const remote of drivers){
        const number=String(remote.driverNumber).trim().padStart(4,'0');
        if(!number)continue;
        const rawCode=String(remote.driverCode??'').trim();
        // The extractor returns an empty string when Total does not expose a
        // driver code. Never turn every missing code into the shared "0000".
        const code=(rawCode||number).padStart(4,'0');
        const firstName=String(remote.firstName??'').trim();
        const lastName=String(remote.lastName??'').trim().toUpperCase();
        const active=!/oppos|bloqu|inactif|inactive|suspend/i.test(String(remote.status??''));
        // Total's driver code is the same business key enforced by
        // uq_driver_company_driver_code. Older imports sometimes stored a
        // different driver_number for an already known code, so looking up by
        // number alone attempted a duplicate INSERT and aborted the full sync.
        const existing=await client.query<{id:string;driver_number:string;driver_code:string}>(`SELECT id,driver_number,driver_code FROM driver
          WHERE company_id=$1 AND deleted_at IS NULL AND (driver_code=$2 OR driver_number=$3)
          ORDER BY CASE WHEN driver_code=$2 THEN 0 ELSE 1 END,created_at
          FOR UPDATE`,[company.id,code,number]);
        const codeOwner=existing.rows.find(row=>row.driver_code===code);
        const numberOwner=existing.rows.find(row=>row.driver_number===number);
        const target=codeOwner??numberOwner;
        if(target){
          // Bad historical data can have the requested code and number on two
          // different rows. Keep the target's number in that case instead of
          // violating uq_driver_company_driver_number and aborting the batch.
          const safeNumber=numberOwner&&numberOwner.id!==target.id?target.driver_number:number;
          if(safeNumber!==number)keyConflicts++;
          await client.query(`UPDATE driver SET first_name=$2,last_name=$3,full_name=trim($2||' '||$3),driver_number=$4,driver_code=$5,customer_number=$6,customer_name=$7,active=$8,total_mobility_checked_at=now(),total_mobility_raw=$9,updated_at=now() WHERE id=$1`,[target.id,firstName,lastName,safeNumber,code,connection?.customer_number??'',company.customer_name,active,remote.raw??{}]);updated++;
        }else{
          const inserted=await client.query<{id:string}>(`INSERT INTO driver(company_id,full_name,customer_number,customer_name,driver_number,first_name,last_name,driver_code,active,total_mobility_checked_at,total_mobility_raw) VALUES($1,trim($2||' '||$3),$4,$5,$6,$2,$3,$7,$8,now(),$9) ON CONFLICT DO NOTHING RETURNING id`,[company.id,firstName,lastName,connection?.customer_number??'',company.customer_name,number,code,active,remote.raw??{}]);
          if(inserted.rows[0])created++;
          else {
            // A manual write may race with the sync despite our advisory lock.
            // Treat it as an already-existing driver instead of failing all rows.
            await client.query(`UPDATE driver SET first_name=$3,last_name=$4,full_name=trim($3||' '||$4),customer_number=$5,customer_name=$6,active=$7,total_mobility_checked_at=now(),total_mobility_raw=$8,updated_at=now() WHERE company_id=$1 AND deleted_at IS NULL AND (driver_code=$2 OR driver_number=$9)`,[company.id,code,firstName,lastName,connection?.customer_number??'',company.customer_name,active,remote.raw??{},number]);
            updated++;
          }
        }
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'SYNC_TOTAL_DRIVERS','integration','TOTAL_MOBILITY_DRIVERS',$2)`,[actor.email,{company:company.code,received:drivers.length,created,updated,keyConflicts}]);
      return {received:drivers.length,created,updated,keyConflicts,company:company.code};
    });
  }
  async importVehicles(vehicles: RemoteVehicle[], actor: Actor, clientName?: string) {
    if (!vehicles.length) throw new BadRequestException('Aucun véhicule trouvé dans Total Mobility');
    const [connection]=await this.db.query<{customer_number:string}>(`SELECT customer_number FROM total_mobility_connection WHERE enabled LIMIT 1`);
    const aliases:Record<string,string>={'DELTA CUISINE':'DC','IKIT TN':'IKIT','STE LES TECHNIQUES DE MARBRE':'TCM','DELTA CUISINE DISTRIBUTION':'DCD'};
    const requestedCode=aliases[String(clientName??'').trim().toUpperCase()]??'';
    const [company]=await this.db.query<{id:string;code:string}>(`SELECT c.id,c.code FROM company c WHERE ($2<>'' AND c.code=$2) OR ($2='' AND EXISTS(SELECT 1 FROM driver d WHERE d.company_id=c.id AND regexp_replace(coalesce(d.customer_number,''),'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g'))) ORDER BY CASE WHEN c.code=$2 THEN 0 ELSE 1 END,c.created_at LIMIT 1`,[connection?.customer_number??'',requestedCode]);
    if(!company)throw new BadRequestException(`Aucune société ne correspond au client Total ${connection?.customer_number??'inconnu'}`);
    return this.db.transaction(async client=>{
      let created=0,updated=0,mileageReadings=0,ignoredMileage=0;
      for(const remote of vehicles){
        const registration=String(remote.registration??'').trim().toUpperCase();
        const normalized=registration.replace(/[^A-Z0-9]/g,'');
        if(!normalized)continue;
        const active=!/oppos|bloqu|inactif|inactive|suspend|sorti/i.test(String(remote.status??''));
        const driverNumber=String(remote.driverNumber??'').replace(/\D/g,'').padStart(4,'0');
        const driver=driverNumber?await client.query(`SELECT id,full_name FROM driver WHERE company_id=$1 AND driver_number=$2 AND deleted_at IS NULL LIMIT 1`,[company.id,driverNumber]):{rows:[]};
        const existing=await client.query(`SELECT id,total_mobility_mileage FROM vehicle WHERE company_id=$1 AND registration_normalized=$2 AND deleted_at IS NULL LIMIT 1`,[company.id,normalized]);
        let vehicleId:string;
        if(existing.rows[0]){
          vehicleId=existing.rows[0].id;
          await client.query(`UPDATE vehicle SET brand=coalesce(nullif($2,''),brand),model=coalesce(nullif($3,''),model),active=$4,
            driver_id=coalesce($5,driver_id),driver_name=coalesce(nullif($6,''),driver_name),total_mobility_status=$7,
            total_mobility_mileage=CASE WHEN $8::numeric IS NULL THEN total_mobility_mileage ELSE greatest(coalesce(total_mobility_mileage,0),$8) END,
            total_mobility_checked_at=now(),total_mobility_raw=$9,updated_at=now() WHERE id=$1`,
            [vehicleId,remote.brand??'',remote.model??'',active,driver.rows[0]?.id??null,remote.driverName??driver.rows[0]?.full_name??'',remote.status??null,remote.mileage??null,remote.raw??{}]);updated++;
        }else{
          const inserted=await client.query(`INSERT INTO vehicle(company_id,registration_normalized,registration_display,brand,model,active,driver_id,driver_name,
            total_mobility_status,total_mobility_mileage,total_mobility_checked_at,total_mobility_raw)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11) RETURNING id`,
            [company.id,normalized,registration,remote.brand??null,remote.model??null,active,driver.rows[0]?.id??null,remote.driverName??driver.rows[0]?.full_name??null,remote.status??null,remote.mileage??null,remote.raw??{}]);
          vehicleId=inserted.rows[0].id;created++;
        }
        const mileage=Number(remote.mileage);
        if(Number.isFinite(mileage)&&mileage>0){
          const latest=await client.query(`SELECT mileage::float FROM mileage_reading WHERE vehicle_id=$1 AND status='VALIDATED' ORDER BY reading_date DESC LIMIT 1`,[vehicleId]);
          if(!latest.rows[0]||mileage>=Number(latest.rows[0].mileage)){
            const inserted=await client.query(`INSERT INTO mileage_reading(vehicle_id,mileage,status,source,created_by,validated_by,validated_at)
              VALUES($1,$2,'VALIDATED','TOTAL_MOBILITY',$3,$3,now()) ON CONFLICT DO NOTHING RETURNING id`,[vehicleId,mileage,actor.sub]);
            mileageReadings+=inserted.rowCount??0;
          }else ignoredMileage++;
        }
      }
      await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'SYNC_TOTAL_VEHICLES','integration','TOTAL_MOBILITY_VEHICLES',$2)`,[actor.email,{company:company.code,received:vehicles.length,created,updated,mileageReadings,ignoredMileage}]);
      return {received:vehicles.length,created,updated,mileageReadings,ignoredMileage,company:company.code};
    });
  }
  private normalizeCardNumber(value:string){return value.replace(/[^0-9]/g,'');}
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
        1,
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
          interval: 1,
        },
      ],
    );
    return {
      connected: true,
      passwordStored: false,
      syncIntervalMinutes: 1,
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
       sync_interval_minutes=1,connected_by=$2,updated_at=now() RETURNING id`,
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
    // Lorsque l'agent navigateur autonome est configuré, il est la source de
    // vérité multi-clients. L'ancien connecteur API ne connaît qu'un seul
    // customer_id et ne doit plus remplacer en parallèle son lot historique.
    if (process.env.TOTAL_USERNAME?.trim() && process.env.TOTAL_PASSWORD) return;
    const due = await this.db.query<{
      sub: string;
      email: string;
    }>(`SELECT c.connected_by AS sub,u.email FROM total_mobility_connection c JOIN app_user u ON u.id=c.connected_by
      WHERE c.enabled AND (c.last_sync_at IS NULL OR c.last_sync_at<=now()-interval '1 minute') LIMIT 1`);
    if (due[0])
      try {
        await this.syncNow(due[0]);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  async syncWithAccessToken(actor: Actor, accessToken: string, requestedFromDate?: string) {
    const token = accessToken.trim().replace(/^Bearer\s+/i, '');
    if (token.length < 20) throw new BadRequestException('Session Total absente ou incomplète');
    return this.syncNow(actor, requestedFromDate, token);
  }
  async syncNow(actor: Actor, requestedFromDate?: string, sessionAccessToken?: string) {
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
      const token = sessionAccessToken ?? await this.refreshAccessToken(
        this.decrypt(config.refresh_token_ciphertext),
      );
      // Chaque passage est un instantané complet. L'ancien état de la période
      // est remplacé dans la même transaction seulement après réception de Total.
      // Toujours rapprocher le mois complet. Une transaction Total peut être
      // publiée plusieurs heures (voire plusieurs jours) après son passage en
      // station. Une fenêtre glissante basée sur last_success_at la perdait
      // définitivement dès qu'elle arrivait après les 6 heures de tolérance.
      const monthStart = new Date();
      monthStart.setDate(1);
      const currentMonthStart = this.formatDate(monthStart, false).slice(0, 10);
      const fromDate = requestedFromDate ?? currentMonthStart;
      const remote = await this.fetchAll(config, token, fromDate);
      const rows = remote.map((r, index) => this.mapTransaction(r, index));
      const [company] = await this.db.query<{id:string}>(`SELECT c.id FROM company c
        JOIN driver d ON d.company_id=c.id AND d.deleted_at IS NULL
        WHERE regexp_replace(d.customer_number,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g')
        ORDER BY d.updated_at DESC LIMIT 1`,[config.customer_number]);
      if(!company) throw new Error(`aucune société Delta ne correspond au client Total ${config.customer_number}`);
      const [existing] = await this.db.query<{count:number}>(`SELECT count(*)::int AS count
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id
        WHERE fc.company_id=$1 AND ft.deleted_at IS NULL AND ft.transaction_date >= $2::date`,
        [company.id,fromDate]);
      if (!rows.length && Number(existing?.count ?? 0) > 0)
        throw new Error('Total a retourné un instantané vide pour une période déjà consommée : données existantes conservées');
      const remoteAmount = rows.reduce((sum,row)=>sum+Number(row.amount||0),0);
      const remoteLiters = rows.reduce((sum,row)=>sum+Number(row.liters||0),0);
      const latestRemoteTransaction = rows.reduce<string|null>((latest,row)=>
        !latest || row.date>latest ? row.date : latest,null);
      const result = rows.length
        ? await this.transactions.import(
            {
              filename: `TOTAL_MOBILITY_${new Date().toISOString()}.json`,
              rows,
              replaceFrom: fromDate,
              companyId: company.id,
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
            source: sessionAccessToken ? 'TOTAL_MOBILITY_BROWSER_SESSION' : 'TOTAL_MOBILITY_API',
            dateFrom: fromDate,
            dateTo: new Date().toISOString(),
            remoteAmount,
            remoteLiters,
            latestRemoteTransaction,
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
      : new Date(`${this.initialExtractionDate}T00:00:00+01:00`);
    if (Number.isNaN(from.getTime())) throw new Error('date de début invalide');
    const pageSignatures=new Set<string>();
    // Le rapport global Total est plafonné à 100 lignes sur certains comptes,
    // même lorsque StartIndex change. Interroger chaque journée séparément
    // garantit un historique complet et inclut les opérations publiées en
    // retard. Une journée qui atteint 100 lignes reste paginée normalement.
    for(const day=new Date(from);day.getTime()<=now.getTime();day.setDate(day.getDate()+1)){
      let dayComplete=false;
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
          DateFrom: this.formatDate(day, false),
          DateTo: this.formatDate(day, true),
          DivisionName: '',
          ExpandClient: 'Total',
          ExpandProduct: 'MyFuel',
          ExportToExcel: false,
          FilterExpression: '',
          IntraUserId: '',
          LanguageId: 'b25a7eda-f295-11e2-a0ca-000c2976e124',
          Locale: '',
          NameOnCard: '',
          // Le rapport en ligne pagine directement avec StartIndex. Demander
          // NewSearch ou réinjecter le RequestId de la première réponse fige
          // le snapshot et répète les 100 premières lignes.
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
      const raw = JSON.stringify(payload),nonce=randomUUID().replace(/-/g,'');
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
      if(pageRows.length){
        const signature=pageRows.map(row=>[
          row.approvalNumber??row.authorisationCode,row.transactionDate,
          row.transactionTime,row.cardNumber,row.totalAmount??row.transactedAmount,
        ].join('|')).join('\n');
        if(pageSignatures.has(signature))
          throw new Error(`pagination Total répétée le ${this.formatDate(day,false).slice(0,10)} à partir de la ligne ${page*100+1} : données existantes conservées`);
        pageSignatures.add(signature);
      }
      results.push(...pageRows);
      if (pageRows.length < 100) { dayComplete = true; break; }
      }
      if(!dayComplete)
        throw new Error(`pagination Total incomplète le ${this.formatDate(day,false).slice(0,10)} : données existantes conservées`);
    }
    return results;
  }
  private findStringProperty(value: unknown, property: string): string {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findStringProperty(item, property);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key.toLowerCase() === property.toLowerCase() && typeof item === 'string')
          return item;
        const found = this.findStringProperty(item, property);
        if (found) return found;
      }
    }
    return '';
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

  transactionsFromUnknown(value: unknown) {
    return this.findTransactions(value);
  }

  async importBrowserTransactions(
    remote: RemoteTransaction[],
    actor: Actor,
    clientName: string,
    fromDate: string,
  ) {
    const aliases: Record<string, string> = {
      'DELTA CUISINE': 'DC',
      'IKIT TN': 'IKIT',
      'STE LES TECHNIQUES DE MARBRE': 'TCM',
      'DELTA CUISINE DISTRIBUTION': 'DCD',
    };
    const code = aliases[clientName.trim().toUpperCase()];
    if (!code) throw new Error(`Client Total non reconnu : ${clientName}`);
    const [company] = await this.db.query<{ id: string }>(
      `SELECT id FROM company WHERE active AND upper(code)=upper($1) LIMIT 1`,
      [code],
    );
    if (!company) throw new Error(`Société Delta ${code} introuvable`);
    const rows = remote.map((row, index) => this.mapTransaction(row, index));
    const [existing] = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM fuel_transaction ft
       JOIN fuel_card fc ON fc.id=ft.fuel_card_id
       WHERE fc.company_id=$1 AND ft.deleted_at IS NULL
         AND ft.transaction_date >= $2::date`,
      [company.id, fromDate],
    );
    if (!rows.length && Number(existing?.count ?? 0) > 0)
      throw new Error(`Total n'a retourné aucune transaction pour ${clientName}; données conservées`);
    if (!rows.length)
      return { client: clientName, fetched: 0, imported: 0, duplicates: 0, pendingReview: 0 };
    const result = await this.transactions.import(
      {
        filename: `TOTAL_BROWSER_${code}_${new Date().toISOString()}.json`,
        rows,
        replaceFrom: fromDate,
        companyId: company.id,
      },
      actor,
    );
    return {
      client: clientName,
      fetched: rows.length,
      amount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      latestTransaction: rows.reduce<string | null>(
        (latest, row) => (!latest || row.date > latest ? row.date : latest),
        null,
      ),
      ...result,
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
