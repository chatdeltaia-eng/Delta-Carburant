import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  chromium as playwright,
  type Browser,
  type Frame,
  type Locator,
  type Page,
} from 'playwright';
import { TotalMobilityService } from './total-mobility.service';
import { DatabaseService } from '../database/database.service';
import type { RemoteCardStatus, RemoteDriver, RemoteTransaction, RemoteVehicle, TotalTransactionContext } from './total-mobility.service';

type Actor = { sub: string; email: string };
type AgentState =
  | 'IDLE'
  | 'STARTING'
  | 'SIGNING_IN'
  | 'CODE_REQUIRED'
  | 'EXTRACTING'
  | 'SUCCESS'
  | 'FAILED';

type AgentStatus = {
  state: AgentState;
  message: string;
  updatedAt: string;
  result?: unknown;
};

@Injectable()
export class TotalLoginAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TotalLoginAgentService.name);
  private browser?: Browser;
  private page?: Page;
  private actor?: Actor;
  private requestedCompanyId?: string;
  private requestedMode: 'REALTIME' | 'REFERENCE' = 'REALTIME';
  private activeClientName?: string;
  private refreshToken?: string;
  private accessToken?: string;
  private liveTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private lastCardReferenceSync=0;
  private lastCardDiagnostic='';
  private readonly cardLimitCheckpoint=new Map<string,{amount:number;holder:string}>();
  private statusValue: AgentStatus = this.status('IDLE', 'Agent Total prêt');
  private referenceStatusValue: AgentStatus = this.status('IDLE', 'Agent Cartes & Plafonds prêt');
  private pendingReference?: { actor: Actor; companyId?: string };

  constructor(
    private readonly total: TotalMobilityService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit() {
    // Render redémarre régulièrement les services. L'agent doit reprendre seul
    // au lieu d'attendre qu'un utilisateur clique à nouveau sur « Démarrer ».
    const delay = Math.max(60, Number(process.env.TOTAL_AGENT_RESTART_SECONDS ?? 300));
    setTimeout(() => void this.autoStart(), 5_000).unref();
    this.watchdogTimer = setInterval(() => void this.autoStart(), delay * 1_000);
    this.watchdogTimer.unref();
  }

  onModuleDestroy() {
    if(this.liveTimer)clearInterval(this.liveTimer);
    if(this.watchdogTimer)clearInterval(this.watchdogTimer);
    void this.closeBrowser();
  }

  private async autoStart() {
    // Un processus Render peut perdre Chromium sans recevoir une erreur du
    // portail. Ne jamais laisser un ancien état SUCCESS empêcher la reprise
    // autonome de la synchronisation.
    if (
      this.statusValue.state === 'SUCCESS' &&
      (!this.browser || !this.page || this.page.isClosed())
    ) {
      this.setStatus('FAILED', 'Session Total interrompue, reconnexion automatique…');
    }
    if (!['IDLE', 'FAILED'].includes(this.statusValue.state)) return;
    if (!process.env.TOTAL_USERNAME?.trim() || !process.env.TOTAL_PASSWORD) return;
    const [connection] = await this.db.query<{ enabled: boolean }>(
      `SELECT t.enabled FROM total_mobility_connection t WHERE t.enabled LIMIT 1`,
    );
    if (!connection) return;
    const [user] = await this.db.query<{ id: string; email: string }>(
      `SELECT id,email FROM app_user
       WHERE active AND role IN ('SUPER_ADMIN','DIRECTION_GENERAL')
       ORDER BY CASE role WHEN 'SUPER_ADMIN' THEN 0 ELSE 1 END, created_at LIMIT 1`,
    );
    if (!user) return;
    try {
      this.logger.log('Redémarrage automatique de l’agent Total Mobility');
      // Sans sélection humaine, synchroniser successivement les quatre clients.
      // Une sélection explicite dans Delta continue de limiter le cycle à une société.
      this.start({ sub: user.id, email: user.email });
    } catch (error) {
      this.logger.warn(`Agent Total non redémarré : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getStatus() {
    return {
      ...this.statusValue,
      automation: {
        enabled: Boolean(this.liveTimer),
        intervalMinutes: Math.max(1, Number(process.env.TOTAL_LIVE_SYNC_MINUTES ?? 1)),
        companies: ['DC', 'IKIT', 'DCD', 'TCM'],
        lastCardReferenceSync: this.lastCardReferenceSync || null,
      },
    };
  }

  getReferenceStatus() {
    return {
      ...this.referenceStatusValue,
      queued: Boolean(this.pendingReference),
      lockedCompanyId: this.pendingReference?.companyId ?? this.requestedCompanyId ?? null,
      coordinatorStep: this.statusValue.message,
    };
  }

  triggerRealtime(actor: Actor, companyId?: string) {
    if (['STARTING', 'SIGNING_IN', 'CODE_REQUIRED', 'EXTRACTING'].includes(this.statusValue.state))
      throw new BadRequestException('Une extraction Total est déjà en cours. Le temps réel démarrera dès sa fin.');
    this.actor = actor;
    if (!this.browser || !this.page || this.page.isClosed()) {
      return this.start(actor, companyId, 'REALTIME');
    }
    void this.liveRefresh(companyId).catch((error) => this.fail(error));
    return this.getStatus();
  }

  triggerCardReference(actor: Actor, companyId?: string) {
    const connectionPhase=['STARTING','SIGNING_IN','CODE_REQUIRED'].includes(this.statusValue.state)||
      (this.statusValue.state==='EXTRACTING'&&/connexion réussie|sélection du client|synchronisation successive/i.test(this.statusValue.message));
    if(connectionPhase){
      // La session Chromium n'a encore commencé aucune lecture métier. La
      // demande manuelle devient donc immédiatement prioritaire : réutiliser
      // la connexion en cours et passer directement aux cartes/plafonds au
      // lieu d'attendre un cycle transactions complet.
      this.actor=actor;
      this.requestedMode='REFERENCE';
      this.requestedCompanyId=companyId;
      this.pendingReference=undefined;
      this.referenceStatusValue=this.status('STARTING',companyId
        ?'Connexion Total en cours — démarrage immédiat des cartes/plafonds de la société sélectionnée après authentification…'
        :'Connexion Total en cours — démarrage immédiat des cartes/plafonds des sociétés après authentification…');
      return this.getReferenceStatus();
    }
    if (this.statusValue.state==='EXTRACTING') {
      this.pendingReference={actor,companyId};
      this.referenceStatusValue=this.status('STARTING',`Agent Cartes & Plafonds en attente prioritaire — opération en cours : ${this.statusValue.message}`);
      return this.getReferenceStatus();
    }
    this.actor = actor;
    if (!this.browser || !this.page || this.page.isClosed()) return this.start(actor, companyId, 'REFERENCE');
    this.requestedMode = 'REFERENCE';
    this.requestedCompanyId = companyId;
    void this.cardReferenceRefresh(companyId).catch((error) => this.fail(error));
    return this.getStatus();
  }

  start(actor: Actor, companyId?: string, mode: 'REALTIME' | 'REFERENCE' = 'REALTIME') {
    // Une sélection effectuée dans Delta doit prendre effet même si le
    // watchdog avait déjà démarré un cycle. L'ancien code retournait avant
    // d'enregistrer companyId et poursuivait les quatre clients.
    if(companyId)this.requestedCompanyId=companyId;
    if (
      ['STARTING', 'SIGNING_IN', 'CODE_REQUIRED', 'EXTRACTING'].includes(
        this.statusValue.state,
      )
    )
      return this.statusValue;
    const username = process.env.TOTAL_USERNAME?.trim();
    const password = process.env.TOTAL_PASSWORD;
    if (!username || !password)
      throw new BadRequestException(
        'Les secrets TOTAL_USERNAME et TOTAL_PASSWORD ne sont pas configurés sur le service API',
      );
    // Après une vraie perte de session, conserver les plafonds déjà validés
    // afin de reprendre à la première carte inachevée. Un nouveau lancement
    // volontaire après SUCCESS/IDLE repart en revanche sur un contrôle frais.
    if(this.statusValue.state!=='FAILED')this.cardLimitCheckpoint.clear();
    this.actor = actor;
    this.requestedCompanyId = companyId;
    this.requestedMode = mode;
    this.activeClientName = undefined;
    this.refreshToken = undefined;
    this.accessToken = undefined;
    this.setStatus('STARTING', companyId
      ? 'Démarrage de l’agent pour le client sélectionné…'
      : 'Démarrage sécurisé de l’agent Total…');
    void this.run(username, password).catch((error) => this.fail(error));
    return this.statusValue;
  }

  async submitCode(codeValue: string) {
    if (this.statusValue.state !== 'CODE_REQUIRED' || !this.page)
      throw new BadRequestException(
        'Aucun code de vérification Total n’est attendu',
      );
    const code = codeValue.replace(/\s+/g, '');
    if (!/^\d{4,8}$/.test(code))
      throw new BadRequestException(
        'Le code doit contenir entre 4 et 8 chiffres',
      );
    const inputs = await this.findVisible(
      this.page,
      this.otpSelectors(),
      2_000,
    );
    if (!inputs)
      throw new BadRequestException('Le champ du code Total n’a pas été trouvé');
    const count = await inputs.count();
    if (count === 1) await inputs.first().fill(code);
    else {
      for (let index = 0; index < Math.min(count, code.length); index++)
        await inputs.nth(index).fill(code[index]);
    }
    this.setStatus('SIGNING_IN', 'Vérification du code Total…');
    await this.clickSubmit(this.page);
    void this.awaitAuthenticated().catch((error) => this.fail(error));
    return this.statusValue;
  }

  private async run(username: string, password: string) {
    await this.closeBrowser();
    this.browser = await playwright.launch({ headless: true });
    // Une hauteur suffisante est indispensable : les grilles Total sont
    // virtualisées et ne rendent que les lignes visibles dans le DOM.
    const context = await this.browser.newContext({
      locale: 'fr-FR',
      viewport: { width: 1920, height: 1200 },
    });
    this.page = await context.newPage();
    this.captureTokens(this.page);
    this.setStatus('SIGNING_IN', 'Connexion automatique à Total Mobility…');
    await this.page.goto('https://customer.fleet.totalenergies.com/tn/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    // Le portail est une SPA : l'écran Gigya peut apparaître après le
    // chargement initial, dans la page ou dans une iframe.
    await this.clickLoginEntryIfPresent(this.page);
    await this.fillFirst(
      this.page,
      [
        'input[type="email"]',
        'input[name="username"]',
        'input[name="loginID"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
        'input[id*="login" i]:not([type="submit"]):not([type="button"]):not([type="hidden"])',
        'input[autocomplete="username"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="e-mail" i]',
        'input[placeholder*="identifiant" i]',
      ],
      username,
    );
    let passwordFilled = await this.tryFillFirst(
      this.page,
      [
        'input[type="password"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]',
      ],
      password,
    );
    // Certains écrans Total/Gigya demandent d’abord l’adresse, puis affichent
    // le mot de passe dans une seconde étape.
    if (!passwordFilled) {
      await this.clickSubmit(this.page);
      await this.page.waitForTimeout(1_200);
      passwordFilled = await this.tryFillFirst(
        this.page,
        [
          'input[type="password"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]',
        ],
        password,
      );
    }
    if (!passwordFilled)
      throw new Error(
        'Le formulaire Total n’a pas affiché le champ du mot de passe',
      );
    await this.clickSubmit(this.page);
    await this.awaitAuthenticated();
  }

  private async awaitAuthenticated() {
    const page = this.page;
    if (!page) throw new Error('Le navigateur Total a été fermé');
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      // La réponse OAuth contenant le refresh_token arrive avant que la SPA
      // Total ait terminé sa redirection de callback. Démarrer finish() à ce
      // moment laisse le navigateur sur /oauth2?code=… et toute ouverture de
      // Transactions expire. Attendre une vraie route applicative Total.
      if (this.refreshToken||this.accessToken) {
        const currentUrl=page.url();
        let portalReady=false;
        try{
          const parsed=new URL(currentUrl);
          portalReady=parsed.hostname==='customer.fleet.totalenergies.com'&&
            !/\/oauth2(?:[/?#]|$)|\/login(?:[/?#]|$)/i.test(parsed.pathname);
        }catch{/* navigation OAuth transitoire */}
        if(portalReady)return this.finish(this.refreshToken,this.accessToken);
      }
      const body = (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).toLowerCase();
      if (/captcha|je ne suis pas un robot|i am not a robot/.test(body))
        throw new Error(
          'Total demande un CAPTCHA. La connexion automatique ne peut pas le valider.',
        );
      const otp = await this.findVisible(page, this.otpSelectors(), 100);
      if (otp) {
        this.setStatus(
          'CODE_REQUIRED',
          'Total demande un code de vérification',
        );
        return;
      }
      if (
        /mot de passe incorrect|incorrect password|invalid credentials|identifiant.*incorrect/.test(
          body,
        )
      )
        throw new Error('Total a refusé l’identifiant ou le mot de passe');
      await page.waitForTimeout(750);
    }
    // Sur Render, le callback OAuth peut rester affiché alors que les jetons
    // et cookies sont déjà valides. Tenter une seule reprise contrôlée vers le
    // portail avant de déclarer l'authentification en échec.
    if(this.refreshToken||this.accessToken){
      await page.goto('https://customer.fleet.totalenergies.com/tn/customer-selection',{
        waitUntil:'domcontentloaded',timeout:60_000,
      }).catch(()=>undefined);
      await page.waitForTimeout(3_000);
      if(!/\/login(?:[/?#]|$)|access-?denied/i.test(page.url()))
        return this.finish(this.refreshToken,this.accessToken);
    }
    throw new Error(`Total n’a pas terminé la connexion dans le délai prévu. Dernière page : ${page.url()}`);
  }

  private captureTokens(page: Page) {
    page.on('response', async (response) => {
      if (!/(oauth2\/token|\/token(?:\?|$))/i.test(response.url())) return;
      try {
        const json = (await response.json()) as Record<string, unknown>;
        const token = json.refresh_token;
        if (typeof token === 'string' && token.length > 20)
          this.refreshToken = token;
        const accessToken=json.access_token;
        if(typeof accessToken==='string'&&accessToken.length>20)
          this.accessToken=accessToken;
      } catch {
        /* La réponse observée n’est pas du JSON OAuth. */
      }
    });
  }

  private async finish(refreshToken?: string, accessToken?:string) {
    if (!this.actor || this.statusValue.state === 'EXTRACTING') return;
    this.setStatus(
      'EXTRACTING',
      'Connexion réussie. Sélection du client Total…',
    );
    // Total redirige l'utilisateur authentifié vers l'écran de sélection du
    // client. Aucun module (transactions, chauffeurs ou cartes) ne doit être
    // ouvert avant que le client configuré ait été réellement sélectionné et
    // validé avec « Ok », sinon le portail charge des données sans périmètre
    // fiable ou renvoie vers access-denied.
    // Chaque worker sélectionne lui-même son client juste avant la lecture.
    // Ne jamais présélectionner le client configuré (historiquement DC) : une
    // demande ciblée IKIT/DCD/TCM ne doit même pas ouvrir Delta Cuisine.
    this.setStatus('EXTRACTING', this.requestedCompanyId
      ? 'Connexion réussie. Sélection exclusive de la société demandée…'
      : 'Connexion réussie. Synchronisation successive des 4 sociétés…');
    if(refreshToken)await this.total.reconnect(refreshToken, this.actor);
    else if(!accessToken)throw new Error('Total n’a fourni aucun jeton de session exploitable');
    this.setStatus('EXTRACTING', this.requestedCompanyId
      ? 'Extraction des transactions du client sélectionné…'
      : 'Extraction complète des transactions de tous les clients…');
    const selectedCompanyId=this.requestedCompanyId;
    const referenceRequested=this.requestedMode==='REFERENCE';
    const clients=referenceRequested
      ?await this.extractClientsWithSessionRecovery(selectedCompanyId)
      :await this.extractTransactionsLiveWithReference(selectedCompanyId);
    if(referenceRequested)this.lastCardReferenceSync=Date.now();
    const summary=this.summarizeClientResults(clients);
    if(summary.fetched<1)
      throw new Error('Total n’a renvoyé aucune transaction : actualisation refusée');
    this.statusValue = {
      ...this.status('SUCCESS', `${summary.visible} transaction(s) Total actualisée(s)`),
      result: { clients, ...summary },
    };
    // Une demande humaine ciblée ne doit limiter que l'extraction demandée.
    // Les cycles suivants redeviennent globaux afin d'actualiser les quatre
    // clients Total sans intervention de l'utilisateur.
    this.requestedCompanyId=undefined;
    this.requestedMode='REALTIME';
    // L'instance spécialisée Cartes & Plafonds doit rester strictement
    // manuelle. Seule l'instance Transactions programme le cycle temps réel.
    if(!referenceRequested){
      this.scheduleLiveRefresh();
      this.runPendingReference();
    }
  }

  private scheduleLiveRefresh(){
    if(this.liveTimer)clearInterval(this.liveTimer);
    const minutes=Math.max(1,Number(process.env.TOTAL_LIVE_SYNC_MINUTES??1));
    this.liveTimer=setInterval(()=>void this.liveRefresh(),minutes*60_000);this.liveTimer.unref();
  }

  private async cardReferenceRefresh(companyId?: string){
    if(!this.actor||['STARTING','SIGNING_IN','CODE_REQUIRED','EXTRACTING'].includes(this.statusValue.state))return;
    if(!this.browser||!this.page||this.page.isClosed()){
      this.fail(new Error('Session Total interrompue; le référentiel va reprendre après reconnexion'));
      return;
    }
    try{
      this.cardLimitCheckpoint.clear();
      this.setStatus('EXTRACTING',companyId?'Agent Référentiel Total : cartes et plafonds de la société sélectionnée…':'Agent Référentiel Total : cartes et plafonds des 4 sociétés…');
      const clients=await this.extractClientsWithSessionRecovery(companyId);
      this.lastCardReferenceSync=Date.now();
      const summary=this.summarizeClientResults(clients);
      this.statusValue={...this.status('SUCCESS',companyId?'Référentiel cartes/plafonds Total actualisé pour la société sélectionnée':'Référentiel cartes/plafonds Total actualisé pour toutes les sociétés'),result:{clients,...summary,worker:'CARD_REFERENCE',companyId:companyId??null,nextRealtime:true}};
      this.referenceStatusValue=this.statusValue;
      this.requestedMode='REALTIME';
      this.requestedCompanyId=undefined;
      // Aucun cycle transactions ici : l'agent Cartes & Plafonds est une
      // session indépendante et strictement manuelle.
    }catch(error){this.fail(error);}
  }
  private async liveRefresh(companyId?: string){
    if(!this.actor||['STARTING','SIGNING_IN','CODE_REQUIRED','EXTRACTING'].includes(this.statusValue.state))return;
    if(!this.browser||!this.page||this.page.isClosed()){
      this.fail(new Error('Session Total interrompue; l’agent va se reconnecter automatiquement'));
      return;
    }
    try{
      this.setStatus('EXTRACTING','Agent Temps réel : transactions, KM et chauffeurs des 4 sociétés…');
      const clients=await this.extractTransactionsLiveWithReference(companyId);
      const summary=this.summarizeClientResults(clients);
      if(summary.fetched<1)
        throw new Error('Total n’a renvoyé aucune transaction : données existantes conservées');
      this.statusValue={...this.status('SUCCESS',`${summary.visible} transaction(s) Total actualisée(s) · véhicules/KM et chauffeurs synchronisés`),result:{clients,...summary,live:true,worker:'REALTIME',companyId:companyId||null,lastCardReferenceSync:this.lastCardReferenceSync||null}};
      this.runPendingReference();
    }catch(error){this.fail(error);this.runPendingReference();}
  }

  private runPendingReference(){
    const pending=this.pendingReference;if(!pending)return;
    this.pendingReference=undefined;
    setTimeout(()=>this.triggerCardReference(pending.actor,pending.companyId),250).unref();
  }

  private async extractTransactionsLiveWithReference(companyId?:string){
    if(companyId)return [await this.extractSelectedCompanyTransactionsOnly(companyId)];
    return this.extractAllClientTransactionsOnly();
  }

  private async extractClientsWithSessionRecovery(companyId?:string){
    for(let attempt=1;;attempt++){
      try{
        return companyId
          ?[await this.extractSelectedCompany(companyId)]
          :await this.extractAllClientCards();
      }catch(error){
        const page=this.page;
        // Une session réellement fermée ou revenue à l'authentification exige
        // une reconnexion. Les erreurs de grille/navigation, elles, doivent
        // être reprises dans la session courante sans fermer Chromium.
        if(!page||page.isClosed()||/customer-selection|\/oauth2|gigya|login|access-?denied/i.test(page.url()))throw error;
        const message=error instanceof Error?error.message:String(error);
        const checkpointClient=(this.activeClientName??'DELTA CUISINE').trim().toUpperCase();
        const [progress]=await this.db.query<{count:number}>(`SELECT count(*)::int count
          FROM total_card_limit_extraction_checkpoint WHERE client_name=$1`,[checkpointClient]).catch(()=>[]);
        const completed=Number(progress?.count??0);
        this.setStatus('EXTRACTING',`Reprise ${attempt} dans la même session — ${completed} plafond(s) ${checkpointClient} conservé(s) — blocage : ${message}`);
        this.logger.warn(`Reprise Total ${attempt}, checkpoints ${checkpointClient} ${completed} : ${message}`);
        await page.keyboard.press('Escape').catch(()=>undefined);
        for(const frame of page.frames())await frame.evaluate(()=>{
          for(const dialog of document.querySelectorAll<HTMLElement>('.q-dialog[aria-hidden="true"]')){
            dialog.style.pointerEvents='none';
            for(const backdrop of dialog.querySelectorAll<HTMLElement>('.q-dialog__backdrop'))backdrop.style.pointerEvents='none';
          }
        }).catch(()=>undefined);
        await page.waitForTimeout(Math.min(2_000,500+attempt*100));
      }
    }
  }

  private summarizeClientResults(clients:unknown[]){
    const values=clients.filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object');
    const sum=(key:string)=>values.reduce((total,value)=>{
      const nested=value.transactions&&typeof value.transactions==='object'
        ? value.transactions as Record<string,unknown>
        : undefined;
      return total+Number(value[key]??nested?.[key]??0);
    },0);
    const imported=sum('imported'),pendingReview=sum('pendingReview');
    return {fetched:sum('fetched'),imported,pendingReview,duplicates:sum('duplicates'),visible:imported+pendingReview};
  }

  private async extractDrivers():Promise<RemoteDriver[]>{
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé avant l’extraction des chauffeurs');
    const captured:unknown[]=[];
    const listener=async(response:import('playwright').Response)=>{if(!/driver|chauffeur/i.test(response.url()))return;try{captured.push(await response.json());}catch{/* non JSON */}};
    page.on('response',listener);
    try{
      await this.openDriversFromTotalMenu();
      await page.waitForTimeout(4_000);
      const rowTexts:string[]=[];const bodyTexts:string[]=[];
      // Lire toutes les pages. Total limite habituellement la grille à 10
      // lignes ; l'ancienne extraction ne conservait donc que la première.
      for(let pageIndex=0;pageIndex<100;pageIndex++){
        for(const frame of page.frames()){
          await frame.evaluate(()=>{
            const candidates=[document.scrollingElement,...Array.from(document.querySelectorAll<HTMLElement>('[role="grid"], [role="table"], .table-container, .mat-table, main'))].filter(Boolean) as HTMLElement[];
            for(const element of candidates)element.scrollTop=element.scrollHeight;
          }).catch(()=>undefined);
          rowTexts.push(...await frame.locator('table tr, mat-row, [role="row"], .mat-mdc-row, .mat-row')
            .evaluateAll(elements=>elements.map(row=>(row.textContent??'').replace(/\s+/g,' ').trim()).filter(Boolean)).catch(()=>[]));
          const text=await frame.locator('body').innerText().catch(()=>'');if(text)bodyTexts.push(text);
        }
        let advanced=false;
        for(const frame of page.frames()){
          const buttons=frame.locator('button');
          const nextIndex=await buttons.evaluateAll(elements=>elements.findIndex(element=>{
            const button=element as HTMLButtonElement;
            const token=[button.textContent,button.getAttribute('aria-label'),button.getAttribute('title')].filter(Boolean).join(' ').replace(/\s+/g,' ').trim().toLowerCase();
            const visible=Boolean(button.offsetWidth||button.offsetHeight||button.getClientRects().length);
            return visible&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&
              (/^(chevron_right|navigate_next|keyboard_arrow_right)$/.test((button.textContent??'').trim())||/next page|page suivante|suivant/.test(token))&&
              !/last|derni[eè]re/.test(token);
          })).catch(()=>-1);
          if(nextIndex<0)continue;
          const before=await frame.locator('table tr, mat-row, [role="row"], .mat-mdc-row, .mat-row').allTextContents().catch(()=>[]);
          await buttons.nth(nextIndex).click({force:true});await page.waitForTimeout(900);
          const after=await frame.locator('table tr, mat-row, [role="row"], .mat-mdc-row, .mat-row').allTextContents().catch(()=>[]);
          advanced=after.join('|')!==before.join('|');if(advanced)break;
        }
        if(!advanced)break;
      }
      const jsonDrivers=this.driversFromUnknown(captured);
      const fromRows=this.driversFromVisibleRows(rowTexts);
      // Dernier recours robuste pour la grille virtuelle actuelle de Mobility
      // Business : lecture du texte visible (0001, prénom, nom, etc.).
      const visibleDrivers=bodyTexts.flatMap(text=>this.driversFromVisibleText(text));
      const result=this.uniqueDrivers([...jsonDrivers,...fromRows,...visibleDrivers]);
      if(!result.length){
        const diagnostic=bodyTexts.join(' ').replace(/\s+/g,' ').slice(0,240);
        throw new Error(`Total n'a renvoyé aucune ligne chauffeur sur ${page.url()}. Contenu visible : ${diagnostic||'vide'}`);
      }
      return result;
    }finally{page.off('response',listener);}
  }

  private async openDriversFromTotalMenu(){
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé');
    if(/\/tn\/drivers(?:[/?#]|$)/i.test(page.url()))return;
    // Total conserve le client sélectionné dans l'état de sa SPA. Un goto()
    // complet vers /drivers détruit cet état et renvoie à customer-selection.
    await page.waitForTimeout(2_500);
    // Sur le tableau de bord, le tiroir est souvent réduit aux seules icônes.
    // Ouvrir le hamburger avant de chercher le libellé du menu.
    for(const frame of page.frames()){
      const toggles=[
        frame.locator('button[aria-label*="menu" i], button[title*="menu" i]').first(),
        frame.locator('button:has(.q-icon)').filter({hasText:/^\s*menu\s*$/i}).first(),
        frame.locator('.q-icon').filter({hasText:/^\s*menu\s*$/i}).first(),
      ];
      for(const toggle of toggles){
        if(await toggle.isVisible({timeout:400}).catch(()=>false)){
          await toggle.click();await frame.waitForTimeout(900);break;
        }
      }
    }
    for(const frame of page.frames()){
      const link=frame.locator('a[href*="/tn/drivers"], [routerlink*="drivers" i]').first();
      if(await link.isVisible({timeout:2_000}).catch(()=>false)){
        await link.click();
        await page.waitForURL(/\/tn\/drivers(?:[/?#]|$)/i,{timeout:15_000});
        return;
      }
      const menu=frame.getByText(/^\s*Gestion des chauffeurs\s*$/i).first();
      if(await menu.isVisible({timeout:2_000}).catch(()=>false)){
        await menu.click();
        await page.waitForURL(/\/tn\/drivers(?:[/?#]|$)/i,{timeout:15_000});
        return;
      }
    }
    // Repli SPA sans rechargement HTTP : conserve le client dans la mémoire
    // du portail tout en demandant au routeur d'afficher les chauffeurs.
    await page.evaluate(()=>{
      history.pushState({},'', '/tn/drivers');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(2_000);
    if(/\/tn\/drivers(?:[/?#]|$)/i.test(page.url()))return;
    throw new Error(`Le menu « Gestion des chauffeurs » est introuvable après la sélection du client (${page.url()})`);
  }

  private async selectConfiguredClient(){
    const page=this.page;if(!page)return;
    const [connection]=await this.db.query<{customer_number:string;site_number:string;customer_name:string|null;company_code:string|null}>(
      `SELECT t.customer_number,t.site_number,
        (SELECT d.customer_name FROM driver d WHERE regexp_replace(coalesce(d.customer_number,''),'[^0-9]','','g')=regexp_replace(t.customer_number,'[^0-9]','','g') AND d.deleted_at IS NULL AND d.customer_name<>'' ORDER BY d.created_at LIMIT 1) customer_name,
        (SELECT c.code FROM company c JOIN driver d ON d.company_id=c.id WHERE regexp_replace(coalesce(d.customer_number,''),'[^0-9]','','g')=regexp_replace(t.customer_number,'[^0-9]','','g') AND d.deleted_at IS NULL ORDER BY d.created_at LIMIT 1) company_code
       FROM total_mobility_connection t WHERE t.enabled LIMIT 1`,
    );
    const customer=connection?.customer_number?.trim();if(!customer)return;
    try{
      this.setStatus('EXTRACTING','Total : vérification du client Delta Cuisine actif…');
      const aliases:Record<string,string>={DC:'DELTA CUISINE',DCD:'DELTA CUISINE DISTRIBUTION',IKIT:'IKIT TN',TCM:'STE LES TECHNIQUES DE MARBRE'};
      const candidates=[aliases[String(connection.company_code??'').toUpperCase()],connection.customer_name,
        connection.company_code,customer].map(value=>String(value??'').trim()).filter(Boolean);
      // Après le SSO, Mobility Business ouvre souvent directement le
      // tableau de bord du dernier client validé. Dans ce cas il n'existe ni
      // radio ni liste à resélectionner : le nom du client actif est affiché
      // dans l'en-tête. Accepter ce contexte uniquement lorsqu'un marqueur
      // visible correspond exactement au client attendu. Les noms connus sont
      // testés du plus long au plus court afin de ne jamais confondre DC et DCD.
      // Ne jamais considérer le texte de la liste comme un client actif sur
      // /customer-selection : la radio doit être cochée puis confirmée avec
      // Ok. Cette confusion laissait l'agent sur la modale et bloquait ensuite
      // l'ouverture de Gérer les cartes.
      if(!/customer-selection/i.test(page.url())){
        const expectedName=aliases[String(connection.company_code??'').toUpperCase()]??String(connection.customer_name??'').trim().toUpperCase();
        const knownNames=Object.values(aliases).sort((left,right)=>right.length-left.length);
        for(const frame of page.frames()){
          const visible=await frame.locator('header, .q-header, nav, [class*="customer" i], [class*="client" i], main, .q-page')
            .allTextContents().catch(()=>[]);
          const normalized=visible.join(' ').toUpperCase().replace(/[^A-Z0-9]/g,'');
          const detected=knownNames.find(name=>normalized.includes(name.replace(/[^A-Z0-9]/g,'')));
          if(detected&&detected===expectedName){
            this.activeClientName=detected;
            return;
          }
          // Après reconnexion, le tableau de bord affiche parfois seulement
          // « No. du client 10391 » dans son contenu, sans répéter le nom dans
          // l'en-tête. Cette preuve est sûre hors /customer-selection.
          const customerDigits=customer.replace(/\D/g,'');
          if(customerDigits&&normalized.includes(customerDigits)){
            this.activeClientName=expectedName;
            return;
          }
        }
      }
      await this.openTotalCustomerSelection();
      this.setStatus('EXTRACTING','Total : sélection automatique de Delta Cuisine…');
      let selectedName='';
      for(const candidate of [...new Set(candidates)]){
        if(await this.selectTotalClientByName(candidate)){selectedName=candidate;break;}
      }
      if(!selectedName)throw new Error(`client ${candidates.join(' / ')||customer} introuvable dans les radios ou la liste Total`);
      const confirmed=await this.confirmTotalCustomerSelection();
      if(!confirmed)throw new Error('bouton Ok de sélection du client introuvable ou désactivé');
      this.setStatus('EXTRACTING','Total : validation du client Delta Cuisine…');
      await this.waitForTotalRoute(
        url=>!url.pathname.includes('customer-selection')&&!url.pathname.includes('/oauth2'),
        'validation du client Total configuré',
      );
      await page.waitForLoadState('domcontentloaded').catch(()=>undefined);
      this.activeClientName=(aliases[String(connection.company_code??'').toUpperCase()]??selectedName).toUpperCase();
      const site=connection.site_number?.trim();
      if(site){
        const siteChoice=page.getByText(new RegExp(site.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),{exact:false}).last();
        if(await siteChoice.isVisible({timeout:800}).catch(()=>false)){
          await siteChoice.click();await page.waitForTimeout(1_000);
        }
      }
      if(/customer-selection/i.test(page.url()))
        throw new Error('Total est resté sur l’écran « Choisir un client » après validation');
    }catch(error){
      const message=`Sélection automatique du client Total ${customer} impossible : ${error instanceof Error?error.message:String(error)}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  private driversFromUnknown(input:unknown):RemoteDriver[]{
    const result:RemoteDriver[]=[];const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;const row=value as Record<string,unknown>;const read=(pattern:RegExp)=>Object.entries(row).find(([key])=>pattern.test(key))?.[1];const number=read(/driver.*(number|no)|numero.*chauffeur|chauffeur.*numero/i);const first=read(/first.*name|prenom/i);const last=read(/last.*name|nom(?!.*client)/i);if((typeof number==='string'||typeof number==='number')&&(first||last))result.push({driverNumber:String(number),firstName:String(first??''),lastName:String(last??''),driverCode:String(read(/driver.*code|code.*chauffeur/i)??''),status:String(read(/status|statut|state/i)??''),raw:row});Object.values(row).forEach(visit);};visit(input);return result;
  }
  private uniqueDrivers(rows:RemoteDriver[]){const seen=new Set<string>();return rows.filter(row=>{const key=row.driverNumber.replace(/\D/g,'');if(!key||seen.has(key))return false;seen.add(key);row.driverNumber=key.padStart(4,'0');return true;});}

  private driversFromVisibleRows(rows:string[]):RemoteDriver[]{
    const result:RemoteDriver[]=[];
    for(const text of rows){
      const match=text.match(/(?:^|\s)(\d{4})(?:\s+)([\p{L}'’-]+)(?:\s+)([\p{L}'’ -]+?)(?=\s+(?:modifier|mise en opposition|actif|inactif|\d{4})|$)/iu);
      if(match)result.push({driverNumber:match[1],firstName:match[2],lastName:match[3].trim(),raw:{text}});
    }
    return result;
  }

  private driversFromVisibleText(text:string):RemoteDriver[]{
    const lines=text.split(/\r?\n/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean);
    const ignored=/^(numéro de chauffeur|prénom|nom|modifier chauffeurs|mise en opposition|lignes par page|recherche)$/i;
    const result:RemoteDriver[]=[];
    for(let index=0;index<lines.length;index++){
      if(!/^\d{4}$/.test(lines[index]))continue;
      const values:string[]=[];
      for(let cursor=index+1;cursor<lines.length&&values.length<2;cursor++){
        const value=lines[cursor];
        if(/^\d{4}$/.test(value))break;
        if(ignored.test(value)||/^\d+\s*[–-]\s*\d+/.test(value))continue;
        if(/^[\p{L}'’ -]{2,}$/u.test(value))values.push(value);
      }
      if(values.length===2)result.push({driverNumber:lines[index],firstName:values[0],lastName:values[1],raw:{source:'visible-text'}});
    }
    return result;
  }

  private async extractVehicles():Promise<RemoteVehicle[]>{
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé avant l’extraction des véhicules');
    const captured:unknown[]=[];
    const listener=async(response:import('playwright').Response)=>{if(!/vehicle|vehicule|véhicule|fleet|parc/i.test(response.url()))return;try{captured.push(await response.json());}catch{/* non JSON */}};
    page.on('response',listener);
    try{
      const routes=['https://customer.fleet.totalenergies.com/tn/vehicles','https://customer.fleet.totalenergies.com/tn/fleet/vehicles'];
      for(const route of routes){
        await page.goto(route,{waitUntil:'domcontentloaded',timeout:60_000});await page.waitForTimeout(3_000);
        const fromJson=this.vehiclesFromUnknown(captured);if(fromJson.length)return this.uniqueVehicles(fromJson);
      }
      const rows=await page.locator('table tbody tr').evaluateAll(elements=>elements.map(row=>Array.from(row.querySelectorAll('td')).map(cell=>(cell.textContent??'').trim())));
      return this.uniqueVehicles(rows.map(cells=>({registration:cells.find(value=>/\d{1,4}\s*(?:TU|TN)\s*\d{1,4}/i.test(value))??'',mileage:Number((cells.find(value=>/\d[\d\s.,]*\s*km/i.test(value))??'').replace(/[^\d.,]/g,'').replace(',','.'))||undefined,status:cells.find(value=>/actif|active|inactif|inactive|bloqu|suspend/i.test(value)),raw:{cells}})).filter(row=>Boolean(row.registration)));
    }finally{page.off('response',listener);}
  }

  private vehiclesFromUnknown(input:unknown):RemoteVehicle[]{
    const result:RemoteVehicle[]=[];const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;const row=value as Record<string,unknown>;const read=(pattern:RegExp)=>Object.entries(row).find(([key])=>pattern.test(key))?.[1];const registration=read(/registration|immatriculation|license.*plate|vehicle.*plate|matricule/i);if(typeof registration==='string'&&registration.trim()){const mileageRaw=read(/current.*mileage|mileage|odometer|kilometr/i);const mileage=Number(String(mileageRaw??'').replace(/\s/g,'').replace(',','.'));result.push({registration:String(registration),mileage:Number.isFinite(mileage)&&mileage>0?mileage:undefined,status:String(read(/status|statut|state/i)??''),brand:String(read(/brand|marque/i)??''),model:String(read(/model|modele|modèle/i)??''),driverNumber:String(read(/driver.*(number|no)|numero.*chauffeur/i)??''),driverName:String(read(/driver.*name|chauffeur|conducteur/i)??''),raw:row});}Object.values(row).forEach(visit);};visit(input);return result;
  }
  private uniqueVehicles(rows:RemoteVehicle[]){const seen=new Set<string>();return rows.filter(row=>{const key=row.registration.toUpperCase().replace(/[^A-Z0-9]/g,'');if(!key||seen.has(key))return false;seen.add(key);return true;});}

  private async extractCardStatuses(): Promise<RemoteCardStatus[]> {
    const page=this.page;
    if(!page)throw new Error('Le navigateur Total a été fermé avant l’extraction des cartes');
    const checkpointClient=(this.activeClientName??'').trim().toUpperCase();
    const storedInventory=checkpointClient?await this.db.query<{card_data:RemoteCardStatus;expected_total:number}>(
      `SELECT card_data,expected_total FROM total_card_inventory_extraction_checkpoint
       WHERE client_name=$1 ORDER BY card_number,payment_method_number`,[checkpointClient],
    ).catch(()=>[]):[];
    const storedExpected=storedInventory.length?Math.max(...storedInventory.map(row=>Number(row.expected_total)||0)):0;
    if(storedExpected>0&&storedInventory.length===storedExpected){
      const cachedCards=storedInventory.map(row=>({
        ...row.card_data,
        raw:{...(row.card_data.raw??{}),expectedTotal:storedExpected,inventoryCheckpoint:true},
      }));
      this.setStatus('EXTRACTING',`Total ${checkpointClient} : inventaire ${storedExpected}/${storedExpected} rechargé, reprise directe des plafonds…`);
      const detailedLimits=await this.extractCardProductLimits(cachedCards);
      return cachedCards.map(card=>detailedLimits.has(card.cardNumber)
        ?{...card,monthlyLimit:detailedLimits.get(card.cardNumber),raw:{...(card.raw??{}),monthlyLimitExtracted:true}}
        :{...card,raw:{...(card.raw??{}),monthlyLimitExtracted:false}});
    }
    const captured: unknown[]=[];
    const listener=async(response: import('playwright').Response)=>{
      // L'endpoint actuel porte un nom générique de recherche de « moyens de
      // paiement » et ne contient pas forcément card/carte dans son URL.
      const contentType=response.headers()['content-type']??'';
      if(!/json/i.test(contentType))return;
      try{captured.push(await response.json());}catch{/* Réponse Total non JSON. */}
    };
    page.on('response',listener);
    try{
      this.setStatus('EXTRACTING','Total : ouverture de Gérer les cartes…');
      let manageOpened=false;let manageError:unknown;
      for(let attempt=0;attempt<2&&!manageOpened;attempt++){
        try{await this.openManageCardsFromMenu();manageOpened=true;}
        catch(error){
          manageError=error;
          await page.keyboard.press('Escape').catch(()=>undefined);
          await page.waitForTimeout(750);
        }
      }
      if(!manageOpened)throw manageError;
      this.setStatus('EXTRACTING','Total : lecture de la grille des cartes…');
      // La grille contient déjà les cartes VALIDE. Ne jamais cliquer sur
      // Recherche : ce bouton est inutile pour l'inventaire complet et un
      // ancien backdrop Quasar invisible peut intercepter son clic.
      await page.waitForTimeout(1_500);
      this.setStatus('EXTRACTING','Total : affichage de 50 cartes par page…');
      const pageSize50=await this.setCardRowsPerPage50();
      // DC expose 40 cartes et exige le mode 50 pour prouver l'inventaire
      // complet. Les petits portefeuilles IKIT/DCD/TCM affichent parfois
      // toutes leurs lignes sans rendre de sélecteur ni de paginateur : cela
      // ne doit pas empêcher la lecture détaillée des plafonds.
      if(!pageSize50&&this.activeClientName==='DELTA CUISINE')
        throw new Error('Le sélecteur « Lignes par page » ne propose pas 50 cartes');
      if(!pageSize50)
        this.logger.log(`Total ${this.activeClientName??'client'} : petite grille sans option 50, lecture directe de toutes les lignes visibles`);
      await page.waitForTimeout(1_000);
      // Attendre la disparition du panneau « Récupération de vos
      // informations » avant de lire le tableau.
      await Promise.all(page.frames().map(frame=>frame.getByText(/récupération de vos informations/i)
        .waitFor({state:'hidden',timeout:20_000}).catch(()=>undefined)));
      const rows:string[][]=[];
      // La q-table Total affiche bien 40 lignes par page mais virtualise le
      // DOM : selon la hauteur du viewport, seulement 20 à 30 lignes existent
      // simultanément. Balayer progressivement la page et les conteneurs
      // scrollables, en mémorisant les lignes avant qu'elles soient recyclées.
      for(const frame of page.frames()){
        const harvested=await frame.evaluate(async()=>{
          const selector='table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row';
          const unique=new Map<string,string[]>();
          const collect=()=>{
            for(const row of document.querySelectorAll<HTMLElement>(selector)){
              const cells=Array.from(row.querySelectorAll<HTMLElement>('td, [role="cell"], mat-cell'))
                .map(cell=>(cell.textContent??'').replace(/\s+/g,' ').trim());
              const key=cells.join('|');if(cells.length&&key)unique.set(key,cells);
            }
          };
          const pause=()=>new Promise(resolve=>setTimeout(resolve,120));
          const containers=[document.scrollingElement,...Array.from(document.querySelectorAll<HTMLElement>(
            '.q-table__middle, .q-virtual-scroll, .q-virtual-scroll__content, [role="grid"], [role="table"], main',
          ))].filter((value):value is HTMLElement=>Boolean(value));
          for(const container of containers){
            const maximum=Math.max(0,container.scrollHeight-container.clientHeight);
            const step=Math.max(180,Math.floor(container.clientHeight*.65));
            for(let position=0;position<=maximum;position+=step){
              container.scrollTop=Math.min(position,maximum);window.scrollTo(0,Math.min(position,document.documentElement.scrollHeight));
              await pause();collect();
            }
            container.scrollTop=maximum;await pause();collect();
          }
          window.scrollTo(0,document.documentElement.scrollHeight);await pause();collect();
          return [...unique.values()];
        }).catch(()=>[] as string[][]);
        rows.push(...harvested);
      }
      for(const frame of page.frames())await frame.evaluate(async()=>{
        const candidates=[document.scrollingElement,...Array.from(document.querySelectorAll<HTMLElement>('[role="grid"], [role="table"], .table-container, .mat-table, main'))].filter(Boolean) as HTMLElement[];
        for(const element of candidates){element.scrollTop=element.scrollHeight;}
        await new Promise(resolve=>setTimeout(resolve,700));
      }).catch(()=>undefined);
      for(let pageIndex=0;pageIndex<100;pageIndex++){
        rows.push(...(await Promise.all(page.frames().map(frame=>frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row').evaluateAll(elements=>elements.map(row=>
          Array.from(row.querySelectorAll('td, [role="cell"], mat-cell')).map(cell=>(cell.textContent??'').replace(/\s+/g,' ').trim()))).catch(()=>[])))).flat());
        let advanced=false;
        for(const frame of page.frames()){
          const buttons=frame.locator('button');
          const nextIndex=await buttons.evaluateAll(elements=>elements.findIndex(element=>{
            const button=element as HTMLButtonElement;
            const token=[button.textContent,button.getAttribute('aria-label'),button.getAttribute('title')]
              .filter(Boolean).join(' ').replace(/\s+/g,' ').trim().toLowerCase();
            const visible=Boolean(button.offsetWidth||button.offsetHeight||button.getClientRects().length);
            return visible&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&(
              /^(chevron_right|navigate_next|keyboard_arrow_right)$/.test((button.textContent??'').trim())||
              /next page|page suivante|suivant/.test(token)
            )&&!/last|derni[eè]re/.test(token);
          })).catch(()=>-1);
          if(nextIndex>=0){
            const before=await frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row').allTextContents().catch(()=>[]);
            await buttons.nth(nextIndex).click({force:true});
            await page.waitForTimeout(900);
            const after=await frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row').allTextContents().catch(()=>[]);
            advanced=after.join('|')!==before.join('|');
            if(advanced)break;
          }
        }
        if(!advanced)break;
      }
      const fromJson=this.cardsFromUnknown(captured);
      const fromTable=rows.map(cells=>{
        const statusIndex=cells.findIndex(value=>/valid|active|inactive|bloqu|suspend|oppos|actif|inactif|annul|expir/i.test(value));
        const expiry=cells.find(value=>/^\d{2}-\d{2}-\d{4}$/.test(value));
        const registration=cells.find(value=>/^HORS\s+PARC$/i.test(value)||/\b(?:TU|TN)\b|\d{1,4}\s*(?:TU|TN)\s*\d{1,4}/i.test(value));
        const paymentMethodNumber=cells.find(value=>/^(?:\d{6,18}|\d{4}(?:\s+\d+){1,3})$/.test(value));
        const explicitCard=cells.find(value=>/^\d{4}$/.test(value));
        const paymentDigits=String(paymentMethodNumber??'').replace(/\D/g,'');
        const cardNumber=explicitCard??(paymentDigits.length>=4?paymentDigits.slice(-4):'');
        const holderName=expiry&&cells.indexOf(expiry)>0?cells[cells.indexOf(expiry)-1]:statusIndex>=0?cells[statusIndex+3]??'':'';
        const paymentMethodType=cells.find(value=>/postpay|prépay|prepay|débit|debit|crédit|credit/i.test(value));
        const limitCell=cells.find(value=>/(?:plafond|limit)/i.test(value)&&/\d/.test(value));
        return {cardNumber,paymentMethodNumber,paymentMethodType,status:statusIndex>=0?cells[statusIndex]:'',holderName,registration,
          expiresOn:this.parseTotalDate(expiry),monthlyLimit:this.parseAmount(limitCell),raw:{cells}};
      })
        .filter(row=>row.cardNumber&&row.status);
      const visibleTexts=await Promise.all(page.frames().map(frame=>frame.locator('body').innerText().catch(()=>'')));
      const fromVisible=visibleTexts.flatMap(text=>this.cardsFromVisibleText(text));
      // Le tableau « Gérer » est le référentiel visible et paginé de Total.
      // Les réponses JSON de la SPA contiennent aussi des objets techniques
      // portant quatre chiffres (compteurs, filtres, anciennes recherches) :
      // elles ne doivent jamais ajouter des cartes absentes du tableau. Elles
      // servent uniquement à enrichir les lignes réellement affichées.
      const tableCards=this.uniqueCards(fromTable);
      const authoritativeNumbers=new Set(tableCards.map(card=>card.cardNumber));
      const supplements=[...fromJson,...fromVisible].filter(card=>authoritativeNumbers.has(card.cardNumber));
      let result=tableCards.length
        ?this.uniqueCards([...supplements,...tableCards])
        :this.uniqueCards([...fromJson,...fromVisible]);
      // Le référentiel opérationnel demandé correspond au filtre Total
      // « Statut du mode de paiement = VALIDE ». Ne jamais inclure une carte
      // inactive, bloquée ou opposée dans ce lot de plafonds actifs.
      result=result.filter(card=>/^\s*VALIDE?\s*$/i.test(card.status));
      // Le paginator Total affiche par exemple « 1–40 sur 40 ». Conserver ce
      // total officiel dans le lot afin que l'import puisse supprimer les cinq
      // anciennes lignes locales uniquement lorsqu'une extraction complète a
      // réellement ramené toutes les cartes du client sélectionné.
      const paginatorTotals=visibleTexts.flatMap(text=>[...text.matchAll(/\b(?:sur|of)\s+(\d{1,5})\b/gi)]
        .map(match=>Number(match[1])).filter(value=>Number.isInteger(value)&&value>0));
      const expectedTotal=paginatorTotals.length
        ?Math.max(...paginatorTotals)
        :this.activeClientName!=='DELTA CUISINE'&&result.length>0
          ?result.length
          :undefined;
      if(expectedTotal!==undefined)result=result.map(card=>({...card,raw:{...(card.raw??{}),expectedTotal}}));
      if(checkpointClient&&expectedTotal!==undefined&&result.length===expectedTotal){
        await this.db.query(`INSERT INTO total_card_inventory_extraction_checkpoint(
          client_name,card_number,payment_method_number,card_data,expected_total,updated_at)
          SELECT $1,item->>'cardNumber',coalesce(item->>'paymentMethodNumber',''),item,$3,now()
          FROM jsonb_array_elements($2::jsonb) item
          ON CONFLICT(client_name,card_number,payment_method_number) DO UPDATE SET
            card_data=excluded.card_data,expected_total=excluded.expected_total,updated_at=now()`,[
          checkpointClient,JSON.stringify(result),expectedTotal,
        ]);
      }
      // Le tableau « Gérer » n'expose pas le plafond mensuel. Total le place
      // uniquement dans Modifier > Produit de la carte > Limite. Lire ce
      // détail sans enregistrer la fiche, puis le rattacher au numéro de carte.
      const detailedLimits=await this.extractCardProductLimits(result);
      result=result.map(card=>detailedLimits.has(card.cardNumber)
        ?{...card,monthlyLimit:detailedLimits.get(card.cardNumber),raw:{...(card.raw??{}),monthlyLimitExtracted:true}}
        :{...card,raw:{...(card.raw??{}),monthlyLimitExtracted:false}});
      this.lastCardDiagnostic=`JSON=${captured.length}, lignes=${rows.length}, JSON-cartes=${fromJson.length}, tableau=${fromTable.length}, texte=${fromVisible.length}, total=${expectedTotal??'inconnu'}, url=${page.url()}`;
      if(!result.length){
        const visible=(await Promise.all(page.frames().map(frame=>frame.locator('body').innerText().catch(()=>''))))
          .join(' ').replace(/\s+/g,' ').slice(0,400);
        this.logger.warn(`Aucune carte lue sur ${page.url()} (JSON=${captured.length}, lignes=${rows.length}). Contenu visible : ${visible||'vide'}`);
      }
      return result;
    }finally{page.off('response',listener);}
  }

  private async extractCardProductLimits(cards:RemoteCardStatus[]){
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé pendant les plafonds');
    const limits=new Map<string,number>();
    const detailPayloads:unknown[]=[];
    const detailListener=async(response:import('playwright').Response)=>{
      if(!/card|payment|product|limit/i.test(response.url())||!/json/i.test(response.headers()['content-type']??''))return;
      try{detailPayloads.push(await response.json());}catch{/* Réponse Total non JSON. */}
    };
    page.on('response',detailListener);
    try{
    for(const [cardIndex,card] of cards.entries()){
      const checkpointKey=[this.activeClientName??'',card.cardNumber,
        String(card.paymentMethodNumber??'').replace(/\D/g,'')].join('|');
      const holderKey=String(card.holderName??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .toUpperCase().replace(/[^A-Z0-9]/g,'');
      let checkpoint=this.cardLimitCheckpoint.get(checkpointKey);
      if(!checkpoint){
        const [stored]=await this.db.query<{amount:string;holder_key:string}>(
          `SELECT amount::text,holder_key FROM total_card_limit_extraction_checkpoint WHERE checkpoint_key=$1 LIMIT 1`,
          [checkpointKey],
        );
        const storedAmount=Number(stored?.amount);
        if(stored&&Number.isFinite(storedAmount)){
          checkpoint={amount:storedAmount,holder:stored.holder_key};
          this.cardLimitCheckpoint.set(checkpointKey,checkpoint);
        }
      }
      if(checkpoint&&checkpoint.holder===holderKey){
        limits.set(card.cardNumber,checkpoint.amount);
        this.setStatus('EXTRACTING',`Plafonds Total : carte ${cardIndex+1}/${cards.length} — ${card.cardNumber} déjà validée, reprise sans doublon`);
        continue;
      }
      this.setStatus('EXTRACTING',`Plafonds Total : carte ${cardIndex+1}/${cards.length} — ${card.cardNumber}`);
      detailPayloads.length=0;
      // Reproduire le parcours humain complet pour CHAQUE carte. Ne jamais
      // réutiliser la sélection de la passe précédente : Total conserve sinon
      // l'ancien moyen de paiement dans son modèle Vue et ouvre le mauvais
      // titulaire malgré le radio visuellement coché.
      await this.openManageCardsFromMenu();
      await page.waitForTimeout(250);
      let completeGrid=false;
      for(let gridAttempt=0;gridAttempt<3&&!completeGrid;gridAttempt++){
        // Après Annuler → Oui, Quasar peut conserver brièvement un backdrop
        // aria-hidden au-dessus du nouveau paginateur. Le neutraliser, fermer
        // un éventuel menu résiduel, puis refaire le geste 50 lignes.
        for(const frame of page.frames())await frame.evaluate(()=>{
          for(const dialog of document.querySelectorAll<HTMLElement>('.q-dialog[aria-hidden="true"]')){
            dialog.style.pointerEvents='none';
            for(const backdrop of dialog.querySelectorAll<HTMLElement>('.q-dialog__backdrop'))backdrop.style.pointerEvents='none';
          }
        }).catch(()=>undefined);
        if(gridAttempt>0){await page.keyboard.press('Escape').catch(()=>undefined);await page.waitForTimeout(300);}
        completeGrid=await this.setCardRowsPerPage50();
      }
      if(!completeGrid){
        // Le contrôle Quasar affiche parfois bien 50 et rend la carte cible,
        // sans exposer un paginateur lisible par Playwright. Ne pas boucler
        // sur cette preuve secondaire : la recherche exacte de la ligne, son
        // numéro et son radio coché constituent les contrôles bloquants juste
        // après. Si la carte n'est réellement pas rendue, l'erreur « carte
        // absente » déclenchera alors la reprise utile.
        this.logger.warn(`Plafond Total ${card.cardNumber} : paginateur 50 non confirmé, vérification directe de la carte`);
        this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} : vérification directe dans la grille…`);
      }
      await page.waitForTimeout(200);
      let row:Locator|undefined;
      for(const frame of page.frames()){
        // La q-table recycle les lignes selon la position verticale. Revenir
        // d'abord en haut, puis balayer progressivement tous les conteneurs
        // scrollables jusqu'à rendre la carte cible dans le DOM.
        await frame.evaluate(()=>{
          window.scrollTo(0,0);
          const known=Array.from(document.querySelectorAll<HTMLElement>(
            '.q-table__middle,.q-virtual-scroll,.q-virtual-scroll__content,[role="grid"],[role="table"],main,.q-page-container,.q-page',
          ));
          const generic=Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(element=>{
            const style=getComputedStyle(element);
            return element.scrollHeight>element.clientHeight+2&&/(auto|scroll)/.test(style.overflowY);
          });
          for(const element of new Set([...known,...generic]))element.scrollTop=0;
        }).catch(()=>undefined);
        for(let sweep=0;sweep<60&&!row;sweep++){
          const candidates=frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row');
          for(let rowIndex=0;rowIndex<await candidates.count();rowIndex++){
            const candidate=candidates.nth(rowIndex);
            const cells=await candidate.locator('td, [role="cell"], mat-cell').allTextContents().catch(()=>[]);
            const containsOfficialCard=cells.some(value=>value.replace(/\D/g,'').padStart(4,'0')===card.cardNumber);
            if(!containsOfficialCard)continue;
            await candidate.scrollIntoViewIfNeeded().catch(()=>undefined);
            if(await candidate.isVisible({timeout:300}).catch(()=>false)){row=candidate;break;}
          }
          if(row)break;
          const advanced=await frame.evaluate(()=>{
            const known=Array.from(document.querySelectorAll<HTMLElement>(
              '.q-table__middle,.q-virtual-scroll,[role="grid"],[role="table"],main,.q-page-container,.q-page',
            ));
            const generic=Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(element=>{
              const style=getComputedStyle(element);
              return element.scrollHeight>element.clientHeight+2&&/(auto|scroll)/.test(style.overflowY);
            });
            const elements=[...new Set([...known,...generic])].filter(element=>element.scrollHeight>element.clientHeight+2);
            let changed=false;
            for(const element of elements){
              const before=element.scrollTop;
              element.scrollTop=Math.min(element.scrollHeight,element.scrollTop+Math.max(160,element.clientHeight*.7));
              if(element.scrollTop!==before)changed=true;
            }
            const beforeWindow=window.scrollY;
            window.scrollBy(0,Math.max(160,window.innerHeight*.6));
            return changed||window.scrollY!==beforeWindow;
          }).catch(()=>false);
          if(!advanced)break;
          await page.waitForTimeout(100);
        }
        if(row)break;
      }
      if(!row)row=await this.findCardRowAcrossPages(card.cardNumber);
      if(!row)throw new Error(`Plafond Total ${card.cardNumber} : carte absente de la grille complète 1–40 sur 40`);
      // Total masque l'input radio natif dans un composant Quasar/Material.
      // Cliquer uniquement l'input lorsqu'il est visible laissait donc la
      // carte non sélectionnée et le crayon Modifier désactivé. Actionner le
      // contrôle visuel, puis utiliser le clic natif du composant en repli.
      let selected=false;
      const nativeRadio=row.locator('input[type="radio"]').first();
      if(await nativeRadio.count().catch(()=>0)){
        // check() ne se contente pas de peindre le radio : il modifie l'input
        // natif et émet les événements utilisés par le modèle Vue de Total.
        selected=await nativeRadio.check({force:true,timeout:3_000}).then(()=>true).catch(()=>false);
      }
      const visibleRadio=row.locator('.q-radio, mat-radio-button, [role="radio"], label:has(input[type="radio"])')
        .filter({visible:true}).first();
      if(!selected&&await visibleRadio.isVisible({timeout:500}).catch(()=>false)){
        selected=await visibleRadio.click({timeout:3_000}).then(()=>true).catch(()=>false);
      }
      if(!selected){
        selected=await row.evaluate(element=>{
          const input=element.querySelector<HTMLInputElement>('input[type="radio"]');
          const target=input?.closest<HTMLElement>('.q-radio,mat-radio-button,label,[role="radio"]')??input;
          if(!target)return false;
          target.click();
          return true;
        }).catch(()=>false);
      }
      if(!selected)throw new Error(`Plafond Total ${card.cardNumber} : contrôle de sélection de la carte introuvable`);
      await page.waitForTimeout(350);
      let selectionConfirmed=await row.evaluate(element=>{
        const input=element.querySelector<HTMLInputElement>('input[type="radio"]');
        const radio=element.querySelector<HTMLElement>('[role="radio"]');
        return Boolean(input?.checked||radio?.getAttribute('aria-checked')==='true'||
          element.querySelector('.q-radio__inner--truthy, .mat-radio-checked, .mat-mdc-radio-checked'));
      }).catch(()=>false);
      // La q-table recycle ses nœuds lors du scroll. Confirmer également que
      // l'unique ligne cochée dans la grille porte toujours le numéro attendu.
      let checkedCard='';
      for(const frame of page.frames()){
        const checkedRows=frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row');
        for(let index=0;index<await checkedRows.count();index++){
          const candidate=checkedRows.nth(index);
          const checked=await candidate.evaluate(element=>{
            const input=element.querySelector<HTMLInputElement>('input[type="radio"]');
            const radio=element.querySelector<HTMLElement>('[role="radio"]');
            return Boolean(input?.checked||radio?.getAttribute('aria-checked')==='true'||
              element.querySelector('.q-radio__inner--truthy,.mat-radio-checked,.mat-mdc-radio-checked'));
          }).catch(()=>false);
          if(!checked)continue;
          const values=await candidate.locator('td, [role="cell"], mat-cell').allTextContents().catch(()=>[]);
          checkedCard=values.map(value=>value.replace(/\D/g,'')).find(value=>/^\d{1,4}$/.test(value))?.padStart(4,'0')??'';
          if(checkedCard===card.cardNumber)row=candidate;
          break;
        }
        if(checkedCard)break;
      }
      selectionConfirmed=selectionConfirmed&&checkedCard===card.cardNumber;
      if(!selectionConfirmed)throw new Error(`Plafond Total ${card.cardNumber} : la carte n'a pas été sélectionnée`);
      this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 1/6 : carte sélectionnée et vérifiée`);
      // La grille Total utilise une colonne « Modifier » dont l'icône crayon
      // n'a parfois aucun texte/aria-label. Repérer l'index de l'en-tête puis
      // cliquer le contrôle de la cellule correspondante.
      let opened=false;
      // Dans la q-table actuelle, « Action » peut couvrir plusieurs cellules :
      // l'index des <th> ne correspond donc pas toujours à celui des <td>.
      // Après sélection, aligner géométriquement la colonne Modifier avec la
      // cellule de la ligne et envoyer un vrai clic Playwright (événement
      // utilisateur trusted), car Total ignore parfois HTMLElement.click().
      const editDeadline=Date.now()+8_000;
      while(!opened&&Date.now()<editDeadline){
        for(const frame of page.frames()){
          const headers=frame.locator('th, [role="columnheader"]').filter({visible:true});
          let headerBox:Awaited<ReturnType<Locator['boundingBox']>>=null;
          for(let headerIndex=0;headerIndex<await headers.count();headerIndex++){
            const header=headers.nth(headerIndex);
            if(!/^\s*Modifier\s*$/i.test((await header.innerText().catch(()=>'')).replace(/\s+/g,' ')))continue;
            headerBox=await header.boundingBox();if(headerBox)break;
          }
          if(!headerBox)continue;
          const gridRows=frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row');
          for(let rowIndex=0;rowIndex<await gridRows.count();rowIndex++){
            const currentRow=gridRows.nth(rowIndex);
            const values=await currentRow.locator('td, [role="cell"], mat-cell').allTextContents().catch(()=>[]);
            if(!values.some(value=>value.replace(/\D/g,'').padStart(4,'0')===card.cardNumber))continue;
            const isChecked=await currentRow.evaluate(element=>{
              const input=element.querySelector<HTMLInputElement>('input[type="radio"]');
              const radio=element.querySelector<HTMLElement>('[role="radio"]');
              return Boolean(input?.checked||radio?.getAttribute('aria-checked')==='true'||
                element.querySelector('.q-radio__inner--truthy,.mat-radio-checked,.mat-mdc-radio-checked'));
            }).catch(()=>false);
            if(!isChecked)continue;
            const cells=currentRow.locator('td, [role="cell"], mat-cell');
            let editCell:Locator|undefined;let distance=Number.POSITIVE_INFINITY;
            const headerCenter=headerBox.x+headerBox.width/2;
            for(let cellIndex=0;cellIndex<await cells.count();cellIndex++){
              const candidate=cells.nth(cellIndex);const box=await candidate.boundingBox();if(!box)continue;
              const nextDistance=Math.abs(box.x+box.width/2-headerCenter);
              if(nextDistance<distance){distance=nextDistance;editCell=candidate;}
            }
            if(!editCell)continue;
            const control=editCell.locator('button,a,[role="button"],[tabindex],.q-icon,mat-icon,svg,img,i,[class*="edit" i]')
              .filter({visible:true}).first();
            opened=await (await control.isVisible({timeout:300}).catch(()=>false)?control:editCell)
              .click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);
            if(opened)break;
          }
          if(opened)break;
        }
        if(!opened)await page.waitForTimeout(250);
      }
      let columnEdit:Locator|undefined;
      const table=row.locator('xpath=ancestor::table[1]');
      if(await table.count().catch(()=>0)){
        const headers=await table.locator('thead th').allTextContents().catch(()=>[]);
        const editIndex=headers.findIndex(value=>/^\s*modifier\s*$/i.test(value));
        if(editIndex>=0)columnEdit=row.locator('td').nth(editIndex)
          .locator('button, a, [role="button"], .q-icon, mat-icon, svg, img, [class*="edit" i]').first();
      }
      const editCandidates=[
        ...(columnEdit?[columnEdit]:[]),
        row.locator('button[aria-label*="modifier" i], button[title*="modifier" i], button:has-text("edit"), .q-icon:has-text("edit")').first(),
        row.locator('mat-icon:has-text("edit"), .material-icons:has-text("edit"), svg[aria-label*="modifier" i]').first(),
        row.locator('button, [role="button"]').filter({hasText:/modifier|edit/i}).first(),
      ];
      for(const edit of editCandidates){
        if(opened)break;
        if(!await edit.isVisible({timeout:300}).catch(()=>false))continue;
        opened=await edit.evaluate(element=>{
          const target=element.closest<HTMLElement>('button,a,[role="button"],[tabindex]')??element as HTMLElement;
          target.click();
        }).then(()=>true).catch(()=>false);if(opened)break;
      }
      // Lorsque la ligne est située plus bas dans les 40 résultats, l'en-tête
      // Modifier peut être hors viewport et l'alignement géométrique devient
      // impossible. Dans la grille Total observée, la dernière cellule est la
      // case « Mise en opposition temporaire » et l'avant-dernière est le
      // crayon Modifier. Utiliser cette structure sur la ligne déjà cochée.
      if(!opened){
        const cells=row.locator('td, [role="cell"], mat-cell');
        const count=await cells.count();
        if(count>=2){
          const editCell=cells.nth(count-2);
          await editCell.scrollIntoViewIfNeeded().catch(()=>undefined);
          const control=editCell.locator('button,a,[role="button"],[tabindex],.q-icon,mat-icon,svg,img,i,[class*="edit" i]')
            .filter({visible:true}).first();
          opened=await (await control.isVisible({timeout:500}).catch(()=>false)?control:editCell)
            .click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);
        }
      }
      // Sur le portail actuel, Modifier se trouve parfois dans la barre
      // d'actions au-dessus du tableau et n'apparaît qu'après sélection de
      // la ligne. Utiliser ce bouton global si la ligne n'en contient pas.
      if(!opened){
        for(const frame of page.frames()){
          const edit=frame.getByRole('button',{name:/^\s*modifier\s*$/i}).filter({visible:true}).first();
          if(!await edit.isVisible({timeout:300}).catch(()=>false))continue;
          opened=await edit.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);
          if(opened)break;
        }
      }
      if(!opened)throw new Error(`Plafond Total ${card.cardNumber} : bouton Modifier introuvable`);
      const detailsDeadline=Date.now()+10_000;
      let detailsReady=false;
      while(!detailsReady&&Date.now()<detailsDeadline){
        if(/\/cards\/edit-card/i.test(page.url()))detailsReady=true;
        for(const frame of page.frames()){
          const body=await frame.locator('body').innerText().catch(()=>'');
          if(/Détails du client/i.test(body)&&/Limite de Crédit/i.test(body)){detailsReady=true;break;}
        }
        if(!detailsReady)await page.waitForTimeout(250);
      }
      if(!detailsReady)
        throw new Error(`Plafond Total ${card.cardNumber} : Modifier n'a pas ouvert Détails du client`);
      if(card.holderName?.trim()){
        const normalizeIdentity=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
          .toUpperCase().replace(/[^A-Z0-9]/g,'');
        const expected=normalizeIdentity(card.holderName);
        // Nom du porteur est un champ modifiable : input.value n'est pas
        // inclus dans body.innerText(). Lire explicitement toutes les valeurs
        // de formulaire, comme pour le champ modifiable « Limite de ».
        const firstPageParts=(await Promise.all(page.frames().map(frame=>frame.locator('body').evaluate(element=>({
          text:(element as HTMLElement).innerText,
          values:Array.from(element.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select'))
            .map(field=>field.value).filter(Boolean),
        })).catch(()=>({text:'',values:[]})))));
        const firstPage=normalizeIdentity(firstPageParts.flatMap(part=>[part.text,...part.values]).join(' '));
        let observedHolder='';
        for(const frame of page.frames()){
          observedHolder=await frame.locator('body').evaluate(()=>{
            const normalize=(value:string)=>value.replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
            const labels=Array.from(document.querySelectorAll<HTMLElement>('label,.q-field__label,.mat-form-field-label,div,span'))
              .filter(node=>/^Nom du porteur$/i.test(normalize(node.textContent??'')));
            for(const label of labels){
              const field=label.closest<HTMLElement>('.q-field,mat-form-field,.mat-mdc-form-field,.form-group,[class*="field"]')
                ??label.parentElement;
              const input=field?.querySelector<HTMLInputElement>('input,textarea');
              if(input?.value.trim())return input.value.trim();
              const own=normalize(field?.textContent??'').replace(/^Nom du porteur\s*/i,'').trim();
              if(own)return own;
              const labelBox=label.getBoundingClientRect();
              const nearest=Array.from(document.querySelectorAll<HTMLInputElement>('input'))
                .filter(candidate=>candidate.value.trim()&&Math.abs(candidate.getBoundingClientRect().top-labelBox.top)<70)
                .sort((left,right)=>Math.abs(left.getBoundingClientRect().left-labelBox.right)-
                  Math.abs(right.getBoundingClientRect().left-labelBox.right))[0];
              if(nearest?.value.trim())return nearest.value.trim();
            }
            return '';
          }).catch(()=>'');
          if(observedHolder)break;
        }
        if(expected.length>=3&&!firstPage.includes(expected)&&observedHolder){
          throw new Error(`Plafond Total ${card.cardNumber} : carte cochée ${checkedCard||'inconnue'}, titulaire attendu ${card.holderName}, titulaire ouvert ${observedHolder}`);
        }
        if(expected.length>=3&&!firstPage.includes(expected)&&!observedHolder){
          // Certaines versions Total peignent le champ Nom du porteur sans
          // exposer sa valeur au DOM/ARIA. Ne pas bloquer sur cette absence :
          // la preuve obligatoire reste le radio coché de la ligne portant le
          // numéro officiel exact. Une valeur lisible mais différente demeure
          // en revanche une erreur bloquante ci-dessus.
          this.logger.warn(`Plafond Total ${card.cardNumber} : Nom du porteur non exposé ; validation par carte cochée ${checkedCard}`);
        }
      }
      this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 2/6 : fiche Modifier et titulaire vérifiés`);
      // La première étape contient « Limite de Crédit » (ligne de crédit du
      // client, ex. 16 000 TND). Ce n'est jamais le plafond de la carte. Le
      // parcours officiel impose Continuer avant d'ouvrir Produit de la carte.
      let continued=false;
      const continueDeadline=Date.now()+10_000;
      while(!continued&&Date.now()<continueDeadline){
        for(const frame of page.frames()){
          // Ne pas dépendre de locator.filter({visible:true}) : sur cette
          // version Quasar le bouton est peint et cliquable, mais Playwright
          // peut le considérer hors du locator pendant la transition d'étape.
          continued=await frame.evaluate(()=>{
            const normalize=(value:string)=>value.replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
            const visible=(element:HTMLElement)=>{
              const rect=element.getBoundingClientRect();const style=getComputedStyle(element);
              return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
            };
            // Le libellé peut vivre dans un span .q-btn__content accompagné
            // d'autres nœuds Quasar. Choisir le plus petit nœud visible qui
            // contient « Continuer », puis remonter au contrôle cliquable.
            const label=Array.from(document.querySelectorAll<HTMLElement>('body *'))
              .filter(element=>visible(element)&&/\bContinuer\b/i.test(normalize(element.innerText||element.textContent||'')))
              .sort((left,right)=>{
                const a=left.getBoundingClientRect(),b=right.getBoundingClientRect();
                return a.width*a.height-b.width*b.height;
              })[0];
            const target=label?.closest<HTMLElement>('button,.q-btn,[role="button"],a')??label;
            if(!target)return false;
            if(target.matches('[disabled],[aria-disabled="true"],.disabled,.q-btn--disable'))return false;
            target.scrollIntoView({block:'center',inline:'center'});
            target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
            target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
            target.click();return true;
          }).catch(()=>false);
          if(continued)break;
        }
        if(!continued)await page.waitForTimeout(250);
      }
      if(!continued)throw new Error(`Plafond Total ${card.cardNumber} : bouton Continuer introuvable sur Détails du client`);
      this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 3/6 : Continuer cliqué`);
      // La deuxième étape peut s'ouvrir sur un autre panneau. Le plafond
      // recherché est exclusivement dans « Produit de la carte ».
      let productOpened=false;
      const productDeadline=Date.now()+10_000;
      while(!productOpened&&Date.now()<productDeadline){
        for(const frame of page.frames()){
          productOpened=await frame.evaluate(()=>{
            const normalize=(value:string)=>value.replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
            const node=Array.from(document.querySelectorAll<HTMLElement>('button,a,[role="button"],.q-stepper__tab,.q-tab,body *'))
              .find(element=>/^Produit de la carte$/i.test(normalize(element.innerText||element.textContent||''))&&
                element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0);
            if(!node)return false;
            const target=node.closest<HTMLElement>('button,a,[role="button"],.q-stepper__tab,.q-tab')??node;
            target.click();return true;
          }).catch(()=>false);
          if(productOpened)break;
        }
        if(!productOpened)await page.waitForTimeout(250);
      }
      if(!productOpened)throw new Error(`Plafond Total ${card.cardNumber} : étape Produit de la carte introuvable après Continuer`);
      this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 4/6 : Produit de la carte ouvert`);
      await Promise.all(page.frames().map(frame=>frame.getByText(/^\s*Limite de\s*$/i).first()
        .waitFor({state:'visible',timeout:10_000}).catch(()=>undefined)));
      const productText=(await Promise.all(page.frames().map(frame=>frame.locator('body').innerText().catch(()=>'')))).join(' ');
      if(!/Limite de/i.test(productText)||!/(?:^|\s)TND(?:\s|$)/i.test(productText)||!/(?:^|\s)Mois(?:\s|$)/i.test(productText))
        throw new Error(`Plafond Total ${card.cardNumber} : restriction Limite de / TND / Mois incomplète sur Produit de la carte`);
      let amount:number|undefined;
      for(const frame of page.frames()){
        const values=await frame.locator('body').evaluate(()=>{
          const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
          const result:string[]=[];
          const labels=Array.from(document.querySelectorAll<HTMLElement>('label, .q-field__label, .mat-form-field-label, div, span'))
            .filter(node=>/^(?:Limite de|Limit of)$/i.test(normalize(node.textContent??'')));
          for(const label of labels){
            // Rester dans le petit champ associé au libellé exact. Ne jamais
            // remonter au formulaire complet, qui contient aussi « Limite de
            // Crédit », « Consommation » et « % consommation ».
            const field=label.closest<HTMLElement>('.q-field, mat-form-field, .mat-mdc-form-field, .form-group, .col, [class*="field"]')
              ??label.parentElement;
            if(!field)continue;
            const input=field.querySelector<HTMLInputElement>('input');
            if(input?.value)result.push(input.value);
            const ownText=normalize(field.textContent??'');
            const match=ownText.match(/^(?:Limite de|Limit of)\s*([\d\s.,]+)\s*(?:TND|DT)?(?:\s*(?:Par mois|Monthly))?/i);
            if(match)result.push(match[1]);
            // Dans la fiche actuelle, « Limite de » est une colonne texte
            // et la valeur est le premier input visuellement à sa droite sur
            // la même ligne. Choisir le champ le plus proche évite les champs
            // Consommation et % consommation situés plus loin.
            const labelRect=label.getBoundingClientRect();
            const visual=Array.from(document.querySelectorAll<HTMLInputElement>('input'))
              .filter(input=>{
                const rect=input.getBoundingClientRect();const style=getComputedStyle(input);
                return Boolean(input.value)&&style.display!=='none'&&style.visibility!=='hidden'&&
                  rect.width>0&&rect.height>0&&rect.left>=labelRect.right-5&&
                  Math.abs((rect.top+rect.height/2)-(labelRect.top+labelRect.height/2))<55;
              })
              .sort((left,right)=>left.getBoundingClientRect().left-right.getBoundingClientRect().left)[0];
            if(visual?.value)result.push(visual.value);
          }
          return result;
        }).catch(()=>[]);
        amount=values.map(value=>this.parseAmount(value)).find(value=>value!==undefined&&value>=0);
        if(amount!==undefined)break;
      }
      // Certaines versions Quasar n'exposent pas la valeur du q-select dans
      // le texte DOM. La réponse JSON chargée par la même fiche Modifier est
      // alors une seconde source fiable, limitée aux champs produit/carte et
      // excluant explicitement toute limite de crédit client.
      if(amount===undefined)amount=this.cardProductLimitFromUnknown(detailPayloads);
      if(amount!==undefined){
        limits.set(card.cardNumber,amount);this.logger.log(`Plafond Total ${card.cardNumber} : ${amount} TND`);
        this.cardLimitCheckpoint.set(checkpointKey,{amount,holder:holderKey});
        await this.db.query(`INSERT INTO total_card_limit_extraction_checkpoint(
          checkpoint_key,client_name,card_number,payment_method_number,holder_key,amount,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,now())
          ON CONFLICT(checkpoint_key) DO UPDATE SET holder_key=excluded.holder_key,
            amount=excluded.amount,updated_at=now()`,[
          checkpointKey,this.activeClientName??'',card.cardNumber,
          String(card.paymentMethodNumber??'').replace(/\D/g,''),holderKey,amount,
        ]);
        this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 5/6 : Limite de = ${amount} TND`);
      }
      else throw new Error(`Plafond Total ${card.cardNumber} : valeur introuvable dans Produit de la carte`);
      // Revenir sans sauvegarder exactement comme l'utilisateur : Annuler,
      // puis confirmer Oui dans l'avertissement. Cette sortie remet Total au
      // menu des cartes et efface la sélection avant la carte suivante.
      let cancelled=false;
      for(const frame of page.frames()){
        cancelled=await frame.evaluate(()=>{
          const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
          const label=Array.from(document.querySelectorAll<HTMLElement>('body *'))
            .filter(node=>/^Annuler$/i.test(normalize(node.innerText||node.textContent||''))&&node.getBoundingClientRect().width>0)
            .sort((left,right)=>left.getBoundingClientRect().width*left.getBoundingClientRect().height-
              right.getBoundingClientRect().width*right.getBoundingClientRect().height)[0];
          const target=label?.closest<HTMLElement>('button,.q-btn,[role="button"],a')??label;
          if(!target)return false;target.click();return true;
        }).catch(()=>false);
        if(cancelled)break;
      }
      if(!cancelled)throw new Error(`Plafond Total ${card.cardNumber} : bouton Annuler introuvable après lecture de Limite de`);
      let confirmedExit=false;const exitDeadline=Date.now()+10_000;
      while(!confirmedExit&&Date.now()<exitDeadline){
        for(const frame of page.frames()){
          confirmedExit=await frame.evaluate(()=>{
            const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
            const dialog=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],.q-dialog,.modal'))
              .find(node=>node.getBoundingClientRect().width>0&&/vouloir quitter cette page/i.test(node.innerText||node.textContent||''));
            if(!dialog)return false;
            const label=Array.from(dialog.querySelectorAll<HTMLElement>('button,.q-btn,[role="button"],a,span'))
              .find(node=>/^Oui$/i.test(normalize(node.innerText||node.textContent||''))&&node.getBoundingClientRect().width>0);
            const target=label?.closest<HTMLElement>('button,.q-btn,[role="button"],a')??label;
            if(!target)return false;target.click();return true;
          }).catch(()=>false);
          if(confirmedExit)break;
        }
        if(!confirmedExit)await page.waitForTimeout(250);
      }
      if(!confirmedExit)throw new Error(`Plafond Total ${card.cardNumber} : confirmation Oui introuvable après Annuler`);
      // Ne pas commencer la carte suivante tant que la confirmation reste
      // affichée ou que Total n'a pas réellement quitté edit-card.
      const returnDeadline=Date.now()+15_000;
      while(Date.now()<returnDeadline){
        const dialogVisible=(await Promise.all(page.frames().map(frame=>frame.locator('[role="dialog"],.q-dialog,.modal')
          .filter({visible:true}).count().catch(()=>0)))).some(count=>count>0);
        if(!dialogVisible&&!/\/cards\/edit-card/i.test(page.url()))break;
        await page.waitForTimeout(250);
      }
      if(/\/cards\/edit-card/i.test(page.url()))
        throw new Error(`Plafond Total ${card.cardNumber} : Oui n'a pas quitté la fiche Modifier`);
      await page.waitForTimeout(250);
      this.setStatus('EXTRACTING',`Plafond ${card.cardNumber} — étape 6/6 : Annuler puis Oui confirmés`);
    }
    }finally{page.off('response',detailListener);}
    return limits;
  }

  private async setCardRowsPerPage50(){
    const page=this.page;if(!page)return false;
    // Si une passe précédente a déjà choisi 50, ne pas rouvrir le menu.
    if(await this.waitForCompleteCardPaginator(700)||await this.cardPageSizeControlShows50())return true;
    for(const frame of page.frames()){
      const paginatorCombos=frame.locator([
        '.q-table__bottom [role="combobox"]','.q-table__bottom .q-select','.q-table__bottom select',
        '.mat-paginator [role="combobox"]','.mat-paginator select','[class*="paginator"] [role="combobox"]',
        '[class*="paginator"] select',
      ].join(',')).filter({visible:true});
      for(let index=0;index<await paginatorCombos.count();index++){
        const combo=paginatorCombos.nth(index);
        if((await combo.evaluate(element=>element.tagName).catch(()=>''))==='SELECT'){
          const option=combo.locator('option').filter({hasText:/^\s*50\s*$/}).first();
          if(!await option.count().catch(()=>0))continue;
          const value=await option.getAttribute('value');
          await combo.selectOption(value!==null?{value}:{label:'50'});
        }else{
          await combo.click({force:true,timeout:3_000});await frame.waitForTimeout(300);
          const option=frame.locator('[role="option"], .q-menu .q-item, mat-option')
            .filter({hasText:/^\s*50\s*$/}).filter({visible:true}).last();
          if(!await option.isVisible({timeout:1_000}).catch(()=>false))continue;
          // L'option Quasar est parfois détachée/recréée pendant son
          // animation. Un locator.click attend alors indéfiniment son état
          // stable. Le nœud est déjà visible et résolu : utiliser le clic DOM
          // natif, exactement comme le gestionnaire q-item du portail.
          await option.evaluate(element=>(element as HTMLElement).click());
        }
        if(await this.cardPageSizeControlShows50()||await this.waitForCompleteCardPaginator())return true;
      }
      // Le portail observé utilise un select natif avec 5, 7, 10, 15, 20,
      // 25 et 50. selectOption déclenche les mêmes événements que le geste
      // utilisateur et reste le chemin le plus fiable.
      const selects=frame.locator('select');
      for(let index=0;index<await selects.count();index++){
        const select=selects.nth(index);
        if(!await select.isVisible({timeout:200}).catch(()=>false))continue;
        const option=select.locator('option').filter({hasText:/^\s*50\s*$/}).first();
        if(!await option.count().catch(()=>0))continue;
        const value=await option.getAttribute('value');
        await select.selectOption(value!==null?{value}:{label:'50'});
        if(await this.cardPageSizeControlShows50()||await this.waitForCompleteCardPaginator())return true;
      }
      // Repli Quasar/Material : retrouver le combobox situé dans le même
      // contrôle que « Lignes par page », puis choisir l'option 50.
      const labels=frame.getByText(/lignes par page|rows per page/i).filter({visible:true});
      for(let index=0;index<await labels.count();index++){
        const label=labels.nth(index);
        const control=label.locator('xpath=ancestor-or-self::*[contains(@class,"q-table__control") or contains(@class,"mat-paginator") or contains(@class,"paginator")][1]');
        const combo=(await control.count().catch(()=>0)?control:label.locator('xpath=..'))
          .locator('[role="combobox"], .q-select, .mat-select').first();
        if(!await combo.isVisible({timeout:300}).catch(()=>false))continue;
        await combo.click({force:true,timeout:3_000});await frame.waitForTimeout(300);
        const option=frame.locator('[role="option"], .q-item, mat-option').filter({hasText:/^\s*50\s*$/}).filter({visible:true}).first();
        if(!await option.isVisible({timeout:1_000}).catch(()=>false))continue;
        await option.evaluate(element=>(element as HTMLElement).click());
        if(await this.cardPageSizeControlShows50()||await this.waitForCompleteCardPaginator())return true;
      }
    }
    return false;
  }

  private async findCardRowAcrossPages(cardNumber:string):Promise<Locator|undefined>{
    const page=this.page;if(!page)return undefined;
    for(const frame of page.frames()){
      // Repli sans Recherche : réduire à 10 lignes afin que chaque ligne soit
      // réellement matérialisée, puis parcourir les pages du paginateur.
      const combos=frame.locator([
        '.q-table__bottom [role="combobox"]','.q-table__bottom .q-select','.q-table__bottom select',
        '.mat-paginator [role="combobox"]','.mat-paginator select','[class*="paginator"] [role="combobox"]',
      ].join(',')).filter({visible:true});
      for(let index=0;index<await combos.count();index++){
        const combo=combos.nth(index);
        if((await combo.evaluate(element=>element.tagName).catch(()=>''))==='SELECT'){
          const option=combo.locator('option').filter({hasText:/^\s*10\s*$/}).first();
          if(!await option.count().catch(()=>0))continue;
          const value=await option.getAttribute('value');
          await combo.selectOption(value!==null?{value}:{label:'10'});break;
        }
        await combo.click({force:true,timeout:3_000}).catch(()=>undefined);await frame.waitForTimeout(200);
        const option=frame.locator('[role="option"],.q-menu .q-item,.q-item,mat-option')
          .filter({hasText:/^\s*10\s*$/}).filter({visible:true}).last();
        if(!await option.isVisible({timeout:700}).catch(()=>false))continue;
        await option.evaluate(element=>(element as HTMLElement).click());break;
      }
      await frame.waitForTimeout(500);
      for(let pageIndex=0;pageIndex<10;pageIndex++){
        const rows=frame.locator('table tbody tr,mat-row,[role="row"],.mat-mdc-row,.mat-row');
        for(let rowIndex=0;rowIndex<await rows.count();rowIndex++){
          const candidate=rows.nth(rowIndex);
          const cells=await candidate.locator('td,[role="cell"],mat-cell').allTextContents().catch(()=>[]);
          if(!cells.some(value=>value.replace(/\D/g,'').padStart(4,'0')===cardNumber))continue;
          await candidate.scrollIntoViewIfNeeded().catch(()=>undefined);
          if(await candidate.isVisible({timeout:300}).catch(()=>false))return candidate;
        }
        const next=frame.locator('.q-table__bottom button,.mat-paginator button,[class*="paginator"] button')
          .filter({visible:true});
        const nextIndex=await next.evaluateAll(elements=>elements.findIndex(element=>{
          const button=element as HTMLButtonElement;
          const token=[button.textContent,button.getAttribute('aria-label'),button.getAttribute('title')]
            .filter(Boolean).join(' ').replace(/\s+/g,' ').trim().toLowerCase();
          return !button.disabled&&button.getAttribute('aria-disabled')!=='true'&&(
            /^(chevron_right|navigate_next|keyboard_arrow_right)$/.test((button.textContent??'').trim())||
            /next page|page suivante|suivant/.test(token)
          )&&!/last|derni[eè]re/.test(token);
        })).catch(()=>-1);
        if(nextIndex<0)break;
        await next.nth(nextIndex).click({force:true,timeout:3_000}).catch(()=>undefined);
        await frame.waitForTimeout(500);
      }
    }
    return undefined;
  }

  private async cardPageSizeControlShows50(){
    const page=this.page;if(!page)return false;
    for(const frame of page.frames()){
      const selected=await frame.evaluate(()=>{
        const visible=(element:HTMLElement)=>{
          const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
          return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
        };
        const roots=Array.from(document.querySelectorAll<HTMLElement>(
          '.q-table__bottom,.mat-paginator,[class*="paginator"],[class*="table__bottom"]',
        )).filter(visible);
        return roots.some(root=>{
          const text=(root.innerText||root.textContent||'').replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
          const select=root.querySelector<HTMLSelectElement>('select');
          if(select&&(select.value==='50'||select.selectedOptions[0]?.textContent?.trim()==='50'))return true;
          const inputs=Array.from(root.querySelectorAll<HTMLInputElement>('input')).filter(visible);
          if(inputs.some(input=>input.value.trim()==='50'))return true;
          const combos=Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"],.q-select,.mat-select')).filter(visible);
          if(combos.some(combo=>/^50$/.test((combo.innerText||combo.textContent||'').replace(/\s+/g,' ').trim())))return true;
          return /(?:Lignes par page|Rows per page)\s*:?\s*50\b/i.test(text);
        });
      }).catch(()=>false);
      if(selected)return true;
    }
    return false;
  }

  private async waitForCompleteCardPaginator(timeout=8_000){
    const page=this.page;if(!page)return false;
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      if(await this.cardPaginatorShowsCompleteDcInventory())return true;
      await page.waitForTimeout(250);
    }
    return false;
  }

  private async cardPaginatorShowsCompleteDcInventory(){
    const page=this.page;if(!page)return false;
    for(const frame of page.frames()){
      const text=await frame.locator('.q-table__bottom, .mat-paginator, [class*="paginator"], body')
        .allTextContents().catch(()=>[]);
      const normalized=text.join(' ').replace(/[\u00a0\u202f]/g,' ').replace(/\s+/g,' ').trim();
      const paginatorTokens=normalized.match(/\d+|sur|of/gi)?.map(token=>token.toLowerCase())??[];
      const hasRange=(end:number,total:number)=>paginatorTokens.some((token,index)=>token==='1'&&
        Number(paginatorTokens[index+1])===end&&['sur','of'].includes(paginatorTokens[index+2])&&
        Number(paginatorTokens[index+3])===total);
      // DC possède exactement 40 cartes VALIDES : preuve stricte 1–40/40.
      if(this.activeClientName==='DELTA CUISINE'&&hasRange(40,40))return true;
      // Pour les autres sociétés, le total varie. Confirmer que la plage
      // affichée commence à 1 et atteint bien le total propre à ce client
      // (ex. 1–8 sur 8), au lieu de valider immédiatement sans choisir 50.
      if(this.activeClientName!=='DELTA CUISINE'){
        for(let index=0;index<paginatorTokens.length-3;index++){
          if(paginatorTokens[index]!=='1'||!['sur','of'].includes(paginatorTokens[index+2]))continue;
          const end=Number(paginatorTokens[index+1]),total=Number(paginatorTokens[index+3]);
          if(end>=total&&total>0)return true;
        }
      }
    }
    return false;
  }

  private cardProductLimitFromUnknown(input:unknown){
    const candidates:number[]=[];
    const visit=(value:unknown,path:string[])=>{
      if(Array.isArray(value)){value.forEach((entry,index)=>visit(entry,[...path,String(index)]));return;}
      if(!value||typeof value!=='object')return;
      for(const [key,entry] of Object.entries(value as Record<string,unknown>)){
        const next=[...path,key];const token=next.join('.').toLowerCase();
        if(/limit|limite|ceiling/.test(key.toLowerCase())&&
          !/credit|customer|client|consum|used|remaining|available|percentage|percent/.test(token)&&
          (typeof entry==='number'||typeof entry==='string')){
          const parsed=this.parseAmount(entry);if(parsed!==undefined&&parsed>=0)candidates.push(parsed);
        }
        visit(entry,next);
      }
    };
    visit(input,[]);
    const unique=[...new Set(candidates)];
    return unique.length===1?unique[0]:undefined;
  }

  private async openManageCardsFromMenu(){
    const page=this.page;if(!page)throw new Error('La session Total est indisponible');
    const waitForManageCardsReady=async(timeout=20_000)=>{
      const deadline=Date.now()+timeout;
      while(Date.now()<deadline){
        if(/\/cards\/manage-card/i.test(page.url()))return true;
        for(const currentFrame of page.frames()){
          // La version actuelle garde parfois l'URL /tn/cards après le clic
          // sur Gérer. La grille et ses filtres sont alors la seule preuve
          // fiable que le module de gestion est ouvert.
          const manageUi=currentFrame.locator([
            'button:has-text("Recherche")',
            'table tbody tr',
            '[role="table"] [role="row"]',
            'input[placeholder*="carte" i]',
            'input[placeholder*="paiement" i]',
          ].join(',')).filter({visible:true}).first();
          if(await manageUi.isVisible({timeout:250}).catch(()=>false))return true;
          const activeManage=currentFrame.locator('.q-tab--active, [aria-selected="true"], .active')
            .filter({hasText:/^\s*Gérer\s*$/i}).first();
          if(await activeManage.isVisible({timeout:250}).catch(()=>false))return true;
        }
        await page.waitForTimeout(300);
      }
      return false;
    };
    if(await waitForManageCardsReady(500))return;
    // Si le module Méthodes de paiement est déjà ouvert sur /tn/cards, ne pas
    // repartir au dashboard. Cliquer directement sur la tuile Gérer.
    if(/\/tn\/cards(?:[/?#]|$)/i.test(page.url())){
      for(const frame of page.frames()){
        const manage=frame.getByText(/^\s*G[\u00e9e]rer\s*$/i).filter({visible:true}).first();
        if(!await manage.isVisible({timeout:700}).catch(()=>false))continue;
        await manage.evaluate(element=>(element.closest<HTMLElement>('a,button,[role="button"],.q-item')??element as HTMLElement).click());
        if(await waitForManageCardsReady())return;
        throw new Error(`Délai dépassé pendant ouverture de Gérer les cartes. Dernière page Total : ${page.url()}`);
      }
    }
    // Parcours principal observé sur Mobility Business Tunisie : depuis le
    // tableau de bord, cliquer le libellé visible « Méthodes de paiement »,
    // puis la tuile « Gérer ». Ce chemin court évite les attentes du tiroir
    // mini Quasar lorsque les libellés sont déjà affichés.
    for(const frame of page.frames()){
      const payment=frame.getByText(/^\s*M[\u00e9e]thodes? de paiement\s*$/i).filter({visible:true}).first();
      if(!await payment.isVisible({timeout:800}).catch(()=>false))continue;
      if(!await payment.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false))continue;
      await this.waitForTotalRoute(url=>/\/tn\/(?:cards|payment)/i.test(url.pathname),'ouverture directe de Méthodes de paiement',12_000).catch(()=>undefined);
      await page.waitForTimeout(800);
      for(const currentFrame of page.frames()){
        const manage=currentFrame.getByText(/^\s*G[\u00e9e]rer\s*$/i).filter({visible:true}).first();
        if(!await manage.isVisible({timeout:1_000}).catch(()=>false))continue;
        if(!await manage.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false))continue;
        if(!await waitForManageCardsReady(15_000))
          throw new Error(`Délai dépassé pendant ouverture directe de Gérer les cartes. Dernière page Total : ${page.url()}`);
        await page.waitForTimeout(800);
        return;
      }
    }
    // Le date-picker Transactions laisse parfois dans le DOM un q-dialog
    // aria-hidden="true" dont le backdrop continue pourtant à intercepter les
    // clics. Neutraliser uniquement ces dialogues déjà fermés.
    for(const frame of page.frames())await frame.evaluate(()=>{
      for(const dialog of document.querySelectorAll<HTMLElement>('.q-dialog[aria-hidden="true"]')){
        dialog.style.pointerEvents='none';
        for(const backdrop of dialog.querySelectorAll<HTMLElement>('.q-dialog__backdrop'))
          backdrop.style.pointerEvents='none';
      }
    }).catch(()=>undefined);
    // Toujours repartir du tableau de bord du client actif. Les pages métier
    // (notamment /drivers) n'affichent pas toutes le même bouton de menu.
    // On utilise le logo/lien d'accueil de la SPA, jamais une URL métier
    // directe qui ferait perdre le contexte du client sélectionné.
    if(!/\/tn\/(?:dashboard)?(?:[/?#]|$)/i.test(page.url())){
      for(const frame of page.frames()){
        const home=frame.locator('a[href$="/tn"], a[href$="/tn/"], a[href*="/tn/dashboard"], [routerlink="/tn"], [routerlink*="dashboard" i]').filter({visible:true}).first();
        if(await home.isVisible({timeout:400}).catch(()=>false)){
          await home.click({force:true,timeout:3_000}).catch(()=>undefined);break;
        }
      }
      await page.waitForTimeout(1_500);
    }

    // Le bundle Total courant expose précisément `.menu-hamburger` et rend le
    // menu dans `.q-drawer`. Attendre aussi la fin de LoadPackageNavigation :
    // le tiroir peut être visible mais encore vide juste après le changement
    // de client.
    await page.locator('.menu-hamburger').first().waitFor({state:'visible',timeout:20_000}).catch(()=>undefined);
    await page.waitForFunction(()=>document.querySelectorAll('.q-drawer .q-item').length>0,{timeout:30_000}).catch(()=>undefined);
    const drawer=page.locator('.q-drawer').filter({visible:true}).first();
    if(await drawer.isVisible({timeout:1_000}).catch(()=>false)){
      // À 1920 px, Quasar laisse le tiroir en mode mini. Son événement
      // mouseover est le mécanisme officiel du portail pour afficher les
      // libellés et rendre « Méthodes de paiement » sélectionnable.
      await drawer.hover({position:{x:20,y:100}}).catch(()=>undefined);
      await page.waitForTimeout(900);
    }

    // Ouvrir le tiroir avec ses sélecteurs sémantiques en priorité.
    let drawerClicked=false;
    for(const frame of page.frames()){
      const semantic=frame.locator([
        '.menu-hamburger',
        'button[aria-label*="menu" i]','[role="button"][aria-label*="menu" i]',
        'button:has(.material-icons:text-is("menu"))','button:has(.q-icon:text-is("menu"))',
        '.q-btn:has-text("menu")','mat-icon:text-is("menu")',
      ].join(',')).filter({visible:true}).first();
      if(await semantic.isVisible({timeout:400}).catch(()=>false)){
        // Si le q-drawer est déjà visible (mode mini/desktop), le hamburger le
        // fermerait. Dans ce cas le survol ci-dessus suffit.
        const visibleDrawer=frame.locator('.q-drawer').filter({visible:true}).first();
        if(!await visibleDrawer.isVisible({timeout:200}).catch(()=>false))
          await semantic.click({timeout:2_000}).catch(()=>undefined);
        await frame.waitForTimeout(700);drawerClicked=true;break;
      }
      const controls=frame.locator('header button, header [role="button"], .q-header .q-btn, button, [role="button"], .q-btn');
      for(let index=0;index<await controls.count();index++){
        const control=controls.nth(index);
        if(!await control.isVisible().catch(()=>false))continue;
        const box=await control.boundingBox();
        // Les coordonnées Playwright commencent sous la barre de Chrome : le
        // hamburger visible vers y=103 sur la capture est vers y=23 dans la page.
        if(!box||box.x>85||box.y<0||box.y>65||box.width>90||box.height>90)continue;
        await control.click({timeout:2_000}).catch(()=>undefined);
        await frame.waitForTimeout(700);drawerClicked=true;break;
      }
      if(drawerClicked)break;
    }
    const paymentPattern=/(?:méthodes?|moyens?|modes?)\s+de\s+paiement|gestion\s+(?:des\s+)?(?:paiements?|cartes?)/i;
    let paymentVisible=false;
    for(const frame of page.frames())paymentVisible=paymentVisible||await frame.getByText(paymentPattern).filter({visible:true}).first().isVisible({timeout:250}).catch(()=>false);
    // Repli visuel exact dans le repère de la page, puis validation réelle du
    // libellé. Un clic seul ne suffit pas à conclure que le tiroir est ouvert.
    if(!paymentVisible){
      const hamburger=page.locator('.menu-hamburger').filter({visible:true}).first();
      const existingDrawer=page.locator('.q-drawer').filter({visible:true}).first();
      if(!await existingDrawer.isVisible({timeout:300}).catch(()=>false)){
        if(await hamburger.isVisible({timeout:300}).catch(()=>false))await hamburger.click();
        else await page.mouse.click(36,43);
      }
      await page.waitForTimeout(1_200);
      const reopened=page.locator('.q-drawer').filter({visible:true}).first();
      if(await reopened.isVisible({timeout:500}).catch(()=>false)){
        await reopened.hover({position:{x:20,y:100}}).catch(()=>undefined);
        await page.waitForTimeout(700);
      }
    }
    let paymentOpened=false;
    for(const frame of page.frames()){
      // Les éléments du bas du tiroir peuvent être hors viewport. Faire
      // défiler le conteneur avant de chercher le libellé ou sa route.
      await frame.locator('.q-drawer, aside, nav, [role="navigation"]').filter({visible:true}).first()
        .evaluate(element=>{element.scrollTop=element.scrollHeight;}).catch(()=>undefined);
      const byRoute=frame.locator('.q-drawer .q-item[href*="/cards" i], .q-drawer a[href*="/cards" i], a[href*="/cards" i], [routerlink*="cards" i], a[href*="payment" i], [routerlink*="payment" i]').filter({visible:true}).first();
      const payment=await byRoute.isVisible({timeout:400}).catch(()=>false)
        ?byRoute
        :frame.getByText(paymentPattern).filter({visible:true}).first();
      if(await payment.isVisible({timeout:1_500}).catch(()=>false)){
        await payment.scrollIntoViewIfNeeded().catch(()=>undefined);
        await payment.click({force:true,timeout:3_000});paymentOpened=true;break;
      }

      // En mode « mini », Total masque le libellé avec CSS et le q-item n'est
      // ni un lien ni un menuitem. Playwright ne peut donc pas le trouver avec
      // getByText(...). Chercher aussi dans le DOM brut (texte masqué,
      // aria-label, title, data-* et nom d'icône), puis cliquer le conteneur
      // Quasar réellement interactif. Ce clic conserve le contexte client,
      // contrairement à une navigation directe vers /manage-card.
      const clickedFromDom=await frame.evaluate((patternSource)=>{
        const pattern=new RegExp(patternSource,'i');
        const iconPattern=/^(?:credit_card|payment|payments|account_balance_wallet|card_membership)$/i;
        const nodes=Array.from(document.querySelectorAll<HTMLElement>('body *'));
        const scored=nodes.map(node=>{
          const attributes=Array.from(node.attributes).map(attribute=>attribute.value).join(' ');
          const ownText=Array.from(node.childNodes)
            .filter(child=>child.nodeType===Node.TEXT_NODE)
            .map(child=>child.textContent??'').join(' ').replace(/\s+/g,' ').trim();
          const materialIcon=node.matches('.material-icons,.q-icon,mat-icon')
            &&iconPattern.test((node.textContent??'').trim());
          const haystack=`${ownText} ${attributes}`.replace(/\s+/g,' ').trim();
          const matches=pattern.test(haystack)||materialIcon;
          const target=node.closest<HTMLElement>('.q-item,a,button,[role="button"],[tabindex]')??node;
          const rect=target.getBoundingClientRect();
          const visible=rect.width>0&&rect.height>0;
          const score=(pattern.test(ownText)?100:0)+(pattern.test(attributes)?70:0)
            +(materialIcon?40:0)+(target.matches('.q-item,a,button')?20:0)+(visible?10:0);
          return {target,matches,score};
        }).filter(candidate=>candidate.matches).sort((a,b)=>b.score-a.score);
        const candidate=scored[0];
        if(!candidate)return false;
        candidate.target.scrollIntoView({block:'center'});
        candidate.target.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
        candidate.target.click();
        return true;
      },paymentPattern.source).catch(()=>false);
      if(clickedFromDom){paymentOpened=true;break;}
    }
    if(!paymentOpened){
      const diagnostics=(await Promise.all(page.frames().map(async frame=>({
        links:await frame.locator('a:visible, [role="menuitem"]:visible').allTextContents().catch(()=>[]),
        hrefs:await frame.locator('a:visible').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')).filter(Boolean)).catch(()=>[]),
        controls:await frame.locator('.q-drawer .q-item, aside [role="button"], nav [role="button"], button')
          .evaluateAll(nodes=>nodes.map(node=>`${(node.textContent??'').replace(/\s+/g,' ').trim()} ${(node.getAttribute('aria-label')??'')} ${(node.getAttribute('title')??'')}`.trim()).filter(Boolean)).catch(()=>[]),
      })))).flatMap(item=>[...item.links,...item.hrefs,...item.controls]).map(value=>String(value).replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,50).join(' | ');
      throw new Error(`Menu de paiement introuvable après ouverture du tableau de bord (${page.url()}). Éléments visibles: ${diagnostics||'aucun'}`);
    }
    try{
      await this.waitForTotalRoute(
        url=>/\/tn\/(?:cards|payment)/i.test(url.pathname),
        'ouverture du module Méthodes de paiement',8_000,
      );
    }catch{
      // Un click Playwright forcé peut être absorbé par le gestionnaire
      // Quasar sans changer de route. Réessayer un clic DOM natif sur le lien
      // du menu (ce n'est pas une navigation directe vers manage-card et le
      // contexte client reste donc autorisé).
      let retried=false;
      for(const frame of page.frames()){
        const route=frame.locator('.q-drawer a[href*="/cards" i], .q-drawer a[href*="payment" i], a[href*="/cards" i], a[href*="payment" i]')
          .filter({visible:true}).first();
        if(!await route.isVisible({timeout:500}).catch(()=>false))continue;
        await route.evaluate((element)=>(element as HTMLElement).click());
        retried=true;break;
      }
      if(!retried)throw new Error(`Le lien « Méthodes de paiement » a disparu sur ${page.url()}`);
      await this.waitForTotalRoute(
        url=>/\/tn\/(?:cards|payment)/i.test(url.pathname),
        'seconde ouverture du module Méthodes de paiement',
      );
    }
    await page.waitForTimeout(1_500);
    for(const frame of page.frames()){
      const manageRoute=frame.locator('a[href*="manage-card" i], [routerlink*="manage-card" i]').filter({visible:true}).first();
      if(await manageRoute.isVisible({timeout:500}).catch(()=>false)){
        await manageRoute.click({force:true,timeout:3_000});
        if(await waitForManageCardsReady())return;
        throw new Error(`Délai dépassé pendant ouverture de Gérer les cartes. Dernière page Total : ${page.url()}`);
      }
      const manage=frame.getByText(/^\s*Gérer\s*$/i).filter({visible:true}).first();
      if(await manage.isVisible({timeout:800}).catch(()=>false)){
        await manage.click({force:true,timeout:3_000});
        if(await waitForManageCardsReady())return;
        throw new Error(`Délai dépassé pendant ouverture de Gérer les cartes. Dernière page Total : ${page.url()}`);
      }
    }
    // Ne jamais ouvrir /manage-card directement : Total renvoie alors vers
    // /access-denied même si l'utilisateur possède les droits via le menu.
    throw new Error(`Parcours Total impossible : bouton « Gérer » introuvable sur ${page.url()}`);
  }

  private async extractAllClientCards(){
    const page=this.page;if(!page||!this.actor)throw new Error('La session Total est indisponible pour les cartes');
    const knownClients=['DELTA CUISINE','IKIT TN','DELTA CUISINE DISTRIBUTION','STE LES TECHNIQUES DE MARBRE'];
    const results:unknown[]=[];
    // Chaque société est un lot indépendant. Une erreur DC ne doit jamais
    // empêcher l'extraction des plafonds IKIT, DCD ou TCM.
    for(const name of knownClients){
      if(this.requestedCompanyId)
        return [await this.extractSelectedCompany(this.requestedCompanyId)];
      await this.openTotalCustomerSelection();
      const selected=await this.selectTotalClientByName(name);
      if(!selected){results.push({client:name,error:'Client non sélectionnable'});continue;}
      const confirmed=await this.confirmTotalCustomerSelection();
      if(!confirmed){results.push({client:name,error:'Client non coché : bouton Ok désactivé'});continue;}
      await this.waitForTotalRoute(
        url=>!url.pathname.includes('customer-selection')&&!url.pathname.includes('/oauth2'),
        `validation du client ${name}`,
      );
      await page.waitForTimeout(1_500);
      this.activeClientName=name.trim().toUpperCase();
      try{results.push(await this.extractCurrentClientData(name));}catch(error){
        const message=error instanceof Error?error.message:String(error);
        this.logger.warn(`Extraction des cartes Total pour ${name} : ${message}`);
        results.push({client:name,error:message});
      }
    }
    const failed=results.filter(result=>result&&typeof result==='object'&&Boolean((result as Record<string,unknown>).error));
    if(failed.length){
      const details=failed.map(result=>{
        const row=result as Record<string,unknown>;
        return `${row.client??'Client inconnu'}: ${row.error??'extraction incomplète'}`;
      }).join(' | ');
      throw new Error(`Extraction Total multi-clients incomplète. Données existantes conservées pour les clients en erreur. ${details}`);
    }
    return results;
  }

  private async extractAllClientTransactionsOnly(){
    const page=this.page;if(!page||!this.actor)throw new Error('La session Total est indisponible pour le temps réel');
    const knownClients=['DELTA CUISINE','IKIT TN','DELTA CUISINE DISTRIBUTION','STE LES TECHNIQUES DE MARBRE'];
    const results:unknown[]=[];
    await this.selectConfiguredClient();
    results.push(await this.extractCurrentClientTransactionsOnly('DELTA CUISINE'));
    for(const name of knownClients.filter(name=>name!=='DELTA CUISINE')){
      await this.openTotalCustomerSelection();
      const selected=await this.selectTotalClientByName(name);
      if(!selected){results.push({client:name,error:'Client non sélectionnable'});continue;}
      const confirmed=await this.confirmTotalCustomerSelection();
      if(!confirmed){results.push({client:name,error:'Client non coché : bouton Ok désactivé'});continue;}
      await this.waitForTotalRoute(
        url=>!url.pathname.includes('customer-selection')&&!url.pathname.includes('/oauth2'),
        `validation du client ${name}`,
      );
      await page.waitForTimeout(700);
      this.activeClientName=name.trim().toUpperCase();
      try{results.push(await this.extractCurrentClientTransactionsOnly(name));}
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        this.logger.warn(`Temps réel transactions Total ${name} : ${message}`);
        results.push({client:name,error:message});
      }
    }
    return results;
  }

  private async extractSelectedCompany(companyId:string){
    const [company]=await this.db.query<{code:string;name:string}>(
      `SELECT code,name FROM company WHERE id=$1 AND active LIMIT 1`,[companyId],
    );
    if(!company)throw new Error('La société sélectionnée dans Delta est introuvable ou inactive');
    const totalNames:Record<string,string>={
      DC:'DELTA CUISINE',IKIT:'IKIT TN',DCD:'DELTA CUISINE DISTRIBUTION',TCM:'STE LES TECHNIQUES DE MARBRE',
    };
    const clientName=totalNames[company.code.trim().toUpperCase()];
    if(!clientName)throw new Error(`Aucun client Total associé à la société Delta ${company.code}`);
    this.setStatus('EXTRACTING',`Référentiel ${company.code} : sélection exclusive du client Total ${clientName}…`);
    if(this.activeClientName===clientName.toUpperCase()&&
      this.page&&!/customer-selection|\/oauth2|access-?denied/i.test(this.page.url()))
      return this.extractCurrentClientData(clientName);
    await this.openTotalCustomerSelection();
    if(!await this.selectTotalClientByName(clientName))
      throw new Error(`Le client Total ${clientName} n'est pas sélectionnable`);
    const confirmed=await this.confirmTotalCustomerSelection();
    if(!confirmed)throw new Error(`Le client Total ${clientName} n'a pas été confirmé`);
    await this.waitForTotalRoute(
      url=>!url.pathname.includes('customer-selection')&&!url.pathname.includes('/oauth2'),
      `validation du client ${clientName}`,
    );
    await this.page?.waitForTimeout(1_500);
    this.activeClientName=clientName.toUpperCase();
    return this.extractCurrentClientData(clientName);
  }

  private async extractSelectedCompanyTransactionsOnly(companyId:string){
    const [company]=await this.db.query<{code:string;name:string}>(
      `SELECT code,name FROM company WHERE id=$1 AND active LIMIT 1`,[companyId],
    );
    if(!company)throw new Error('La société sélectionnée dans Delta est introuvable ou inactive');
    const totalNames:Record<string,string>={
      DC:'DELTA CUISINE',IKIT:'IKIT TN',DCD:'DELTA CUISINE DISTRIBUTION',TCM:'STE LES TECHNIQUES DE MARBRE',
    };
    const clientName=totalNames[company.code.trim().toUpperCase()];
    if(!clientName)throw new Error(`Aucun client Total associé à la société Delta ${company.code}`);
    this.setStatus('EXTRACTING',`Temps réel ${company.code} : sélection exclusive du client Total ${clientName}…`);
    if(this.activeClientName!==clientName.toUpperCase()||!this.page||/customer-selection|\/oauth2|access-?denied/i.test(this.page.url())){
      await this.openTotalCustomerSelection();
      if(!await this.selectTotalClientByName(clientName))throw new Error(`Le client Total ${clientName} n'est pas sélectionnable`);
      if(!await this.confirmTotalCustomerSelection())throw new Error(`Le client Total ${clientName} n'a pas été confirmé`);
      await this.waitForTotalRoute(url=>!url.pathname.includes('customer-selection')&&!url.pathname.includes('/oauth2'),`validation du client ${clientName}`);
      await this.page?.waitForTimeout(700);
      this.activeClientName=clientName.toUpperCase();
    }
    return this.extractCurrentClientTransactionsOnly(clientName);
  }

  private async extractCurrentClientTransactionsOnly(clientName:string){
    const companyCodes:Record<string,string>={
      'DELTA CUISINE':'DC','IKIT TN':'IKIT','DELTA CUISINE DISTRIBUTION':'DCD','STE LES TECHNIQUES DE MARBRE':'TCM',
    };
    const code=companyCodes[clientName.trim().toUpperCase()];
    const [company]=await this.db.query<{id:string;cards:number}>(`SELECT c.id,count(fc.id)::int cards
      FROM company c LEFT JOIN fuel_card fc ON fc.company_id=c.id AND fc.deleted_at IS NULL
      WHERE c.active AND upper(c.code)=$1 GROUP BY c.id LIMIT 1`,[code]);
    if(!company)throw new Error(`Société Delta ${code??clientName} introuvable`);
    if(Number(company.cards)<1)throw new Error(`Référentiel cartes absent pour ${clientName} : extraction complète requise`);
    this.activeClientName=clientName.trim().toUpperCase();
    this.setStatus('EXTRACTING',`Temps réel Total ${clientName} : transactions…`);
    const transactions=await this.extractCurrentClientTransactions(clientName,company.id);
    this.setStatus('EXTRACTING',`Temps réel Total ${clientName} : chauffeurs…`);
    const driverRows=await this.extractDrivers().catch(error=>{
      this.logger.warn(`Temps réel chauffeurs ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const drivers=driverRows.length?await this.total.importDrivers(driverRows,this.actor!,clientName):{received:0};
    this.setStatus('EXTRACTING',`Temps réel Total ${clientName} : véhicules et kilométrages…`);
    const vehicleRows=await this.extractVehicles().catch(error=>{
      this.logger.warn(`Temps réel véhicules/KM ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const vehicles=vehicleRows.length?await this.total.importVehicles(vehicleRows,this.actor!,clientName):{received:0};
    return {client:clientName,transactions,drivers,vehicles,cards:{received:Number(company.cards),skipped:true,mode:'reference-cache'}};
  }

  private async extractCurrentClientData(clientName:string){
    if(!this.actor)throw new Error('Utilisateur de synchronisation Total absent');
    this.activeClientName=clientName.trim().toUpperCase();
    // Rafraîchir d'abord les cartes : leur immatriculation officielle permet
    // de rattacher immédiatement les transactions dont la colonne véhicule
    // est vide (cas fréquent de DCD).
    const companyCodes:Record<string,string>={
      'DELTA CUISINE':'DC','IKIT TN':'IKIT','DELTA CUISINE DISTRIBUTION':'DCD','STE LES TECHNIQUES DE MARBRE':'TCM',
    };
    const code=companyCodes[clientName.trim().toUpperCase()];
    const [company]=await this.db.query<{id:string}>(`SELECT id FROM company WHERE active AND upper(code)=$1 LIMIT 1`,[code]);
    if(!company)throw new Error(`Société Delta ${code??clientName} introuvable`);
    this.setStatus('EXTRACTING',`Total ${clientName} : extraction automatique des cartes et plafonds…`);
    // Les cartes et leurs plafonds constituent le référentiel parent. Ne
    // jamais poursuivre vers les transactions lorsque cette étape échoue :
    // cela recréerait des pseudo-cartes à partir de simples suffixes.
    const cardRows=await this.extractCardStatuses();
    if(!cardRows.length)throw new Error(`Aucune carte Total visible pour ${clientName} (${this.lastCardDiagnostic})`);
    const cards=await this.total.importCardStatuses(cardRows,this.actor,clientName);
    this.setStatus('EXTRACTING',`Total ${clientName} : cartes et plafonds validés, extraction des transactions…`);
    const transactions=await this.extractCurrentClientTransactions(clientName,company.id);
    const driverRows=await this.extractDrivers().catch(error=>{
      this.logger.warn(`Chauffeurs Total ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const drivers=driverRows.length?await this.total.importDrivers(driverRows,this.actor,clientName):{received:0};
    const vehicleRows=await this.extractVehicles().catch(error=>{
      this.logger.warn(`Véhicules Total ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const vehicles=vehicleRows.length?await this.total.importVehicles(vehicleRows,this.actor,clientName):{received:0};
    // Le client entier est maintenant validé et importé. Les checkpoints ne
    // sont plus nécessaires ; le prochain cycle relira volontairement Total.
    await this.db.query(`DELETE FROM total_card_limit_extraction_checkpoint WHERE client_name=$1`,[
      clientName.trim().toUpperCase(),
    ]);
    await this.db.query(`DELETE FROM total_card_inventory_extraction_checkpoint WHERE client_name=$1`,[
      clientName.trim().toUpperCase(),
    ]);
    for(const key of this.cardLimitCheckpoint.keys())if(key.startsWith(`${clientName.trim().toUpperCase()}|`))
      this.cardLimitCheckpoint.delete(key);
    return {client:clientName,transactions,cards,drivers,vehicles};
  }

  private async setTotalDateInput(input:Locator,value:string){
    // Le date-picker mx-datepicker expose intentionnellement un input readonly.
    // `locator.fill()` attend alors 30 s avant d'échouer. Le composant Vue
    // écoute les événements input/change : utiliser son setter natif permet
    // de reproduire la sélection d'une date sans dépendre du calendrier visuel.
    await input.evaluate((element,nextValue)=>{
      const field=element as HTMLInputElement;
      field.removeAttribute('readonly');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(setter)setter.call(field,nextValue);else field.value=nextValue;
      field.dispatchEvent(new Event('input',{bubbles:true}));
      field.dispatchEvent(new Event('change',{bubbles:true}));
      field.dispatchEvent(new Event('blur',{bubbles:true}));
    },value);
    const actual=await input.inputValue();
    if(actual!==value)throw new Error(`Le filtre de date Total a refusé ${value} (valeur actuelle : ${actual||'vide'})`);
  }

  private async selectTotalDateFromCalendar(input:Locator,isoDate:string,displayDate:string){
    // `mx-input` est readonly et sa valeur DOM n'est pas la source de vérité du
    // composant Vue. Modifier `input.value` affiche la bonne date mais Total
    // envoie encore l'ancienne période au rapport. Reproduire le geste humain
    // dans le calendrier met réellement à jour le modèle interne.
    await input.click({force:true,timeout:4_000});
    const page=this.page;
    if(!page)throw new Error('Le navigateur Total a été fermé pendant la sélection des dates');
    const target=new Date(`${isoDate}T12:00:00`);
    const today=new Date();
    const targetMonth=target.getFullYear()*12+target.getMonth();
    const currentMonth=today.getFullYear()*12+today.getMonth();
    const direction=targetMonth<=currentMonth?-1:1;
    for(let attempt=0;attempt<36;attempt++){
      for(const frame of page.frames()){
        const popup=frame.locator('.mx-datepicker-popup:visible, .mx-calendar:visible, [class*="datepicker"][class*="popup"]:visible').first();
        if(!await popup.isVisible({timeout:300}).catch(()=>false))continue;
        const exact=popup.locator(`[title="${isoDate}"], [data-date="${isoDate}"]`).filter({visible:true}).first();
        if(await exact.isVisible({timeout:300}).catch(()=>false)){
          await exact.click({force:true,timeout:4_000});
          await page.waitForTimeout(350);
          const actual=await input.inputValue().catch(()=>'');
          if(actual!==displayDate)
            throw new Error(`Le calendrier Total a sélectionné ${actual||'une valeur vide'} au lieu de ${displayDate}`);
          return;
        }
        const navigation=direction<0
          ? popup.locator('.mx-btn-icon-left, button[aria-label*="mois précédent" i], button[title*="mois précédent" i]').filter({visible:true})
          : popup.locator('.mx-btn-icon-right, button[aria-label*="mois suivant" i], button[title*="mois suivant" i]').filter({visible:true});
        if(await navigation.count()){
          await navigation.first().click({force:true,timeout:3_000});
          await page.waitForTimeout(250);
          break;
        }
      }
    }
    throw new Error(`La date ${displayDate} est introuvable dans le calendrier Total`);
  }

  private async extractCurrentClientTransactions(clientName:string,companyId:string){
    const page=this.page;
    if(!page||!this.actor)throw new Error('La session Total est indisponible pour les transactions');
    const captured:unknown[]=[];
    let reportAccessToken='';
    let reportContext:TotalTransactionContext|undefined;
    const listener=async(response:import('playwright').Response)=>{
      if(!/transaction\/online\/api\/v1\/report\/list/i.test(response.url()))return;
      const headers=await response.request().allHeaders().catch(()=>({} as Record<string,string>));
      const authorization=headers.authorization;
      if(authorization)reportAccessToken=authorization;
      try{
        const payload=response.request().postDataJSON() as Record<string,unknown>;
        const read=(name:string)=>Object.entries(payload).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
        const next={
          customerId:String(read('CustomerId')??''),customerNumber:String(read('CustomerNumber')??''),
          siteNumber:String(read('SiteNumber')??''),userId:String(read('UserId')??''),
          username:String(read('usersname')??read('UserName')??''),
        };
        if(next.customerId&&next.customerNumber&&next.siteNumber)reportContext=next;
      }catch{/* La requête observée n'expose pas de corps JSON. */}
      try{captured.push(await response.json());}catch{/* Réponse Total non JSON. */}
    };
    page.on('response',listener);
    try{
      // Total interdit une navigation directe vers online-transactions et la
      // transforme en /accessdenied. Reproduire strictement le parcours humain
      // depuis le menu latéral du client sélectionné.
      let opened=false;
      for(let attempt=0;attempt<3&&!opened;attempt++){
        for(const frame of page.frames()){
          const toggles=[
            frame.locator('button[aria-label*="menu" i], button[title*="menu" i]').filter({visible:true}).first(),
            frame.locator('.q-icon').filter({hasText:/^\s*menu\s*$/i}).filter({visible:true}).first(),
          ];
          for(const toggle of toggles){
            if(await toggle.isVisible({timeout:300}).catch(()=>false)){
              await toggle.click({force:true,timeout:3_000}).catch(()=>undefined);
              await frame.waitForTimeout(700);break;
            }
          }
        }
        for(const frame of page.frames()){
          const candidates=[
            frame.locator('a[href*="/transactions/online-transactions"], [routerlink*="online-transactions" i]').filter({visible:true}).first(),
            frame.getByText(/^\s*Transactions\s*$/i).filter({visible:true}).first(),
          ];
          for(const candidate of candidates){
            if(!await candidate.isVisible({timeout:700}).catch(()=>false))continue;
            const clicked=await candidate.click({force:true,timeout:4_000}).then(()=>true).catch(()=>false);
            if(!clicked)continue;
            // « Transactions » est parfois seulement le parent du sous-menu.
            // Dans ce cas, le premier clic ne change volontairement pas la
            // route : sélectionner ensuite l'entrée du rapport en ligne.
            await frame.waitForTimeout(500);
            if(!/\/tn\/transactions\/online-transactions/i.test(page.url())){
              const children=[
                frame.locator('a[href*="/transactions/online-transactions"], [routerlink*="online-transactions" i]').filter({visible:true}).first(),
                frame.getByText(/^\s*Transactions en ligne\s*$/i).filter({visible:true}).first(),
                frame.getByText(/^\s*Rapport des transactions\s*$/i).filter({visible:true}).first(),
                frame.getByText(/^\s*Libre\s*$/i).filter({visible:true}).first(),
              ];
              for(const child of children){
                if(!await child.isVisible({timeout:500}).catch(()=>false))continue;
                if(await child.click({force:true,timeout:4_000}).then(()=>true).catch(()=>false))break;
              }
            }
            opened=await page.waitForURL(/\/tn\/transactions\/online-transactions/i,{timeout:12_000})
              .then(()=>true).catch(()=>false);
            if(opened)break;
          }
          if(opened)break;
        }
        if(!opened)await page.waitForTimeout(1_000);
      }
      if(!opened)
        throw new Error(`Le menu « Transactions » de ${clientName} n'a pas ouvert online-transactions. Dernière page Total : ${page.url()}`);
      if(/customer-selection/i.test(page.url()))
        throw new Error(`Total a perdu le client ${clientName} avant l'ouverture des transactions`);
      await page.waitForLoadState('domcontentloaded',{timeout:15_000}).catch(()=>undefined);
      // La route SPA est disponible avant que le module Transactions ait fini
      // son rendu (particulièrement sur Render). Attendre un élément métier au
      // lieu d'utiliser un délai fixe qui peut expirer trop tôt.
      const reportDeadline=Date.now()+45_000;
      let reportReady=false;
      while(!reportReady&&Date.now()<reportDeadline){
        if(/customer-selection|\/oauth2|access-?denied/i.test(page.url()))
          throw new Error(`Total a quitté les transactions de ${clientName} pendant le chargement : ${page.url()}`);
        for(const frame of page.frames()){
          const marker=frame.getByText(/Rapport des transactions|^\s*Libre\s*$/i).filter({visible:true}).first();
          if(await marker.isVisible({timeout:300}).catch(()=>false)){reportReady=true;break;}
        }
        if(!reportReady)await page.waitForTimeout(500);
      }
      if(!reportReady)
        throw new Error(`Le rapport des transactions de ${clientName} ne s'est pas chargé. Dernière page Total : ${page.url()}`);
      const now=new Date();
      const pad=(value:number)=>String(value).padStart(2,'0');
      // Périmètre métier demandé : reprendre tout l'historique opérationnel
      // depuis le 1er août 2026 à chaque cycle, jusqu'au jour présent.
      // Total peut publier une transaction avec retard : une fenêtre glissante
      // ferait alors disparaître définitivement cette ligne.
      const extractionStart=process.env.TOTAL_EXTRACTION_START_DATE?.trim()||'2026-08-01';
      const startMatch=extractionStart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if(!startMatch)throw new Error(`TOTAL_EXTRACTION_START_DATE invalide : ${extractionStart}`);
      const fromText=`${startMatch[3]}/${startMatch[2]}/${startMatch[1]}`;
      const toText=`${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()}`;
      let datesFilled=false;
      let libreActivated=false;
      const dateDeadline=Date.now()+45_000;
      while(!datesFilled&&Date.now()<dateDeadline){
        for(const frame of page.frames()){
          // Le portail masque les champs tant que « Libre » n'est pas actif.
          // La SPA peut rerendre ce contrôle après notre premier clic : le
          // retenter jusqu'à l'apparition effective des deux champs.
          if(!libreActivated){
            const libre=frame.getByText(/^\s*Libre\s*$/i).filter({visible:true}).first();
            if(await libre.isVisible({timeout:250}).catch(()=>false))
              libreActivated=await libre.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);
          }
          const inputs=frame.locator('input');
          const dateFields=await inputs.evaluateAll(elements=>elements.map((element,index)=>{
            const field=element as HTMLInputElement;
            const rect=field.getBoundingClientRect();
            let context='';let parent:Element|null=field.parentElement;
            // Le premier conteneur portant un libellé est le plus fiable. Un
            // parent trop haut contient les deux libellés et inverse parfois
            // la période selon l'ordre interne choisi par Quasar.
            for(let level=0;level<3&&parent;level++,parent=parent.parentElement){
              const text=(parent.textContent??'').replace(/\s+/g,' ').trim();
              context+=` ${text}`;
              if(/(?:à partir du|jusqu['’]au|date de début|date de fin)/i.test(text))break;
            }
            return {index,value:field.value,type:field.type,placeholder:field.placeholder,
              aria:field.getAttribute('aria-label')??'',context,x:rect.left,visible:rect.width>0&&rect.height>0};
          }).filter(item=>item.visible&&(
            /^\d{2}\/\d{2}\/\d{4}$/.test(item.value)||item.type==='date'||
            /(?:à partir du|jusqu['’]au|date)/i.test(`${item.placeholder} ${item.aria} ${item.context}`)
          ))).catch(()=>[]);
          if(dateFields.length>=2){
            const descriptor=(item:(typeof dateFields)[number])=>
              `${item.placeholder} ${item.aria} ${item.context}`;
            let fromField=dateFields.find(item=>/(?:à partir du|date de début|du\s*:)/i.test(descriptor(item)));
            let toField=dateFields.find(item=>/(?:jusqu['’]au|date de fin|au\s*:)/i.test(descriptor(item)));
            // Sur certaines versions Total, les libellés ne sont pas liés aux
            // inputs. Leur position visuelle reste stable : début à gauche,
            // fin à droite.
            const ordered=[...dateFields].sort((a,b)=>a.x-b.x||a.index-b.index);
            fromField??=ordered[0];
            toField??=ordered.find(item=>item.index!==fromField?.index);
            if(fromField&&toField&&fromField.index!==toField.index){
              await this.selectTotalDateFromCalendar(inputs.nth(fromField.index),extractionStart,fromText);
              const todayIso=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
              await this.selectTotalDateFromCalendar(inputs.nth(toField.index),todayIso,toText);
              const [actualFrom,actualTo]=await Promise.all([
                inputs.nth(fromField.index).inputValue(),inputs.nth(toField.index).inputValue(),
              ]);
              if(actualFrom!==fromText||actualTo!==toText)
                throw new Error(`Période Total incorrecte : début=${actualFrom||'vide'}, fin=${actualTo||'vide'}`);
              datesFilled=true;break;
            }
          }
        }
        if(!datesFilled){
          // Si le composant a été remonté, son état local « Libre » peut être
          // perdu : autoriser un nouveau clic lors de l'itération suivante.
          libreActivated=false;
          await page.waitForTimeout(500);
        }
      }
      if(!datesFilled){
        const inputs=await Promise.all(page.frames().map(frame=>frame.locator('input')
          .evaluateAll(elements=>elements.map(element=>({name:element.getAttribute('name'),className:element.className,type:element.getAttribute('type'),value:(element as HTMLInputElement).value,placeholder:element.getAttribute('placeholder')}))).catch(()=>[])));
        throw new Error(`Filtres de dates introuvables pour ${clientName}. Champs visibles : ${JSON.stringify(inputs.flat().slice(0,12))}`);
      }
      // Ne jamais réutiliser la réponse chargée automatiquement à l'ouverture
      // du rapport (souvent la journée précédente). Seules les réponses
      // déclenchées après la soumission de notre période complète sont valides.
      captured.splice(0,captured.length);
      // Le sélecteur « Libre » de Quasar peut être visuellement fermé tout en
      // laissant un q-dialog aria-hidden et son backdrop au-dessus du bouton
      // Recherche. Il ne s'agit plus d'une fenêtre active : neutraliser
      // uniquement ces calques cachés avant de soumettre le filtre.
      for(const frame of page.frames())await frame.evaluate(()=>{
        for(const dialog of document.querySelectorAll<HTMLElement>('.q-dialog[aria-hidden="true"]')){
          dialog.style.pointerEvents='none';
          for(const backdrop of dialog.querySelectorAll<HTMLElement>('.q-dialog__backdrop'))
            backdrop.style.pointerEvents='none';
        }
      }).catch(()=>undefined);
      let searched=false;
      for(const frame of page.frames()){
        const search=frame.getByRole('button',{name:/^\s*recherch(?:e|er)\s*$/i}).first();
        if(await search.isVisible({timeout:500}).catch(()=>false)){
          // Le bouton est visible et activé. `force` évite qu'un ancien
          // backdrop Quasar réapparu pendant le rendu intercepte le clic.
          await search.click({force:true,timeout:4_000});searched=true;break;
        }
      }
      if(!searched)throw new Error(`Bouton Recherche introuvable pour ${clientName}`);
      const resultDeadline=Date.now()+45_000;
      while(!captured.length&&Date.now()<resultDeadline){
        if(/customer-selection|\/oauth2|access-?denied/i.test(page.url()))
          throw new Error(`Total a quitté le rapport pendant la recherche de ${clientName} : ${page.url()}`);
        await page.waitForTimeout(500);
      }
      if(!captured.length)
        throw new Error(`Total n'a renvoyé aucun résultat après Recherche pour ${clientName} (${fromText} au ${toText})`);
      // Le date-picker Total peut afficher la bonne période tout en conservant
      // une ancienne valeur dans son modèle Vue. La session navigateur reste
      // indispensable pour le login et la sélection du client, mais le rapport
      // final est demandé à l'API officielle avec des DateFrom/DateTo explicites
      // et sa pagination complète. C'est l'unique source importée en base.
      if(reportAccessToken&&reportContext){
        const authoritative=await this.total.syncClientWithAccessToken(
          this.actor,reportAccessToken,companyId,clientName,reportContext,extractionStart,
        ) as Record<string,unknown>;
        return {client:clientName,...authoritative};
      }
      const visibleRows:string[][]=[];
      for(let pageIndex=0;pageIndex<1000;pageIndex++){
        for(const frame of page.frames()){
          visibleRows.push(...await frame.locator('table tbody tr, mat-row, [role="row"]').evaluateAll(elements=>elements.map(row=>
            Array.from(row.querySelectorAll('td, [role="cell"], mat-cell')).map(cell=>(cell.textContent??'').replace(/\s+/g,' ').trim()))
            .filter(cells=>cells.length>=10&&/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]??''))).catch(()=>[]));
        }
        let advanced=false;
        for(const frame of page.frames()){
          const buttons=frame.locator('button');
          const nextIndex=await buttons.evaluateAll(elements=>elements.findIndex(element=>{
            const button=element as HTMLButtonElement;
            const token=[button.textContent,button.getAttribute('aria-label'),button.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
            const visible=Boolean(button.offsetWidth||button.offsetHeight||button.getClientRects().length);
            return visible&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&
              (/chevron_right|navigate_next|keyboard_arrow_right/.test(token)||/next page|page suivante|suivant/.test(token));
          })).catch(()=>-1);
          if(nextIndex<0)continue;
          const before=await frame.locator('table tbody tr, mat-row, [role="row"]').allTextContents().catch(()=>[]);
          await buttons.nth(nextIndex).click({force:true});
          await page.waitForTimeout(900);
          const after=await frame.locator('table tbody tr, mat-row, [role="row"]').allTextContents().catch(()=>[]);
          advanced=after.join('|')!==before.join('|');
          if(advanced)break;
        }
        if(!advanced)break;
      }
      const fromJson=captured.flatMap(value=>this.total.transactionsFromUnknown(value));
      const fromTable:RemoteTransaction[]=visibleRows.map(cells=>({
        transactionDate:cells[0],transactionTime:cells[1],approvalNumber:cells[2],
        cardNumber:cells[4],cardHolderName:cells[5],productName:cells[7],
        transactionVolume:Number(String(cells[8]).replace(',','.')),
        totalAmount:Number(String(cells[9]).replace(',','.')),
        stationName:cells[11],transactionStatus:cells[13],
      }));
      const unique=new Map<string,RemoteTransaction>();
      for(const row of [...fromJson,...fromTable]){
        const key=[row.approvalNumber??row.authorisationCode,row.transactionDate,row.transactionTime,row.cardNumber,row.totalAmount??row.transactedAmount].join('|');
        if(row.transactionDate&&row.cardNumber)unique.set(key,row);
      }
      const rows=[...unique.values()];
      if(!rows.length)throw new Error(`Aucune transaction Total visible pour ${clientName} du ${fromText} au ${toText}`);
      return this.total.importBrowserTransactions(rows,this.actor,clientName,extractionStart);
    }finally{page.off('response',listener);}
  }

  private async openTotalCustomerSelection(){
    const page=this.page;if(!page)throw new Error('La session Total est indisponible');
    // Total ouvre parfois « Choisir un client » dans une q-dialog sans changer
    // l'URL. Ne jamais recliquer le lien d'en-tête lorsque cette fenêtre est
    // déjà au premier plan : son backdrop intercepte volontairement les clics.
    for(const frame of page.frames()){
      const openDialog=frame.locator('.q-dialog[aria-hidden="false"], .q-dialog--modal, [role="dialog"]')
        .filter({has:frame.locator('input[type="radio"], [role="radio"], input[type="search"], input[placeholder*="client" i]')}).first();
      if(await openDialog.isVisible({timeout:400}).catch(()=>false)){
        await frame.waitForTimeout(700);return;
      }
    }
    // Le lien d'en-tête initialise correctement le composant de sélection,
    // contrairement à un accès direct qui peut afficher une SPA sans options.
    if(!/customer-selection/i.test(page.url())){
      for(const frame of page.frames()){
        const chooser=frame.getByText(/choisir un client/i).first();
        if(await chooser.isVisible({timeout:700}).catch(()=>false)){
          const clicked=await chooser.click({timeout:3_000}).then(()=>true).catch(()=>false);
          // Un échec de clic signifie généralement que la q-dialog est déjà
          // ouverte et que son backdrop protège le bouton situé derrière.
          if(!clicked){await frame.waitForTimeout(500);return;}
          await page.waitForURL(/customer-selection/i,{timeout:15_000}).catch(()=>undefined);
          await page.waitForTimeout(2_000);return;
        }
      }
    }
    await page.goto('https://customer.fleet.totalenergies.com/tn/customer-selection',{waitUntil:'domcontentloaded',timeout:60_000});
    await page.waitForTimeout(3_000);
  }

  private async waitForTotalRoute(
    predicate:(url:URL)=>boolean,
    step:string,
    timeout=45_000,
  ){
    const page=this.page;if(!page)throw new Error('La session Total est indisponible');
    // Après la sélection d'un client, Total repasse brièvement par /oauth2
    // et peut effectuer plusieurs navigations successives. waitForURL attend
    // l'événement load de chacune d'elles et expire alors que le SSO avance.
    // Observer simplement l'URL finale reproduit mieux le comportement humain.
    const deadline=Date.now()+timeout;
    let lastUrl=page.url();
    while(Date.now()<deadline){
      lastUrl=page.url();
      try{if(predicate(new URL(lastUrl)))return;}catch{/* URL transitoire */}
      await page.waitForTimeout(300);
    }
    throw new Error(`Délai dépassé pendant ${step}. Dernière page Total : ${lastUrl}`);
  }

  private async selectTotalClientByName(name:string){
    const page=this.page;if(!page)return false;
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const exact=new RegExp(`^\\s*${escaped}\\s*$`,'i');
    const contains=new RegExp(escaped,'i');
    for(const frame of page.frames()){
      const dialog=frame.locator('.q-dialog--modal, [role="dialog"]').filter({visible:true}).last();
      const scope=await dialog.isVisible({timeout:250}).catch(()=>false)?dialog:frame.locator('body');
      // Écran réellement utilisé par Mobility Business Tunisie : quatre
      // q-radio dans la boîte « Veuillez choisir un client ».
      const directRadio=scope.locator('.q-radio, [role="radio"], label').filter({hasText:exact}).first();
      if(await directRadio.isVisible({timeout:700}).catch(()=>false)){
        await directRadio.click({timeout:3_000});await frame.waitForTimeout(500);
        return true;
      }
      const search=frame.locator('input[type="search"], input[placeholder*="recherche" i], input[placeholder*="client" i]').first();
      if(await search.isVisible({timeout:250}).catch(()=>false)){
        await search.fill(name);await frame.waitForTimeout(500);
      }
      // Version actuelle : le client est choisi dans un q-select. Ouvrir le
      // champ avant de chercher l'option, sans cliquer l'icône Material cachée.
      const clientSelect=scope.locator('[role="combobox"], .q-select').first();
      if(await clientSelect.isVisible({timeout:300}).catch(()=>false)){
        await clientSelect.click({timeout:3_000});await frame.waitForTimeout(400);
        const option=frame.locator('[role="option"], .q-menu .q-item, .q-virtual-scroll__content .q-item')
          .filter({hasText:exact}).first();
        if(await option.isVisible({timeout:1_500}).catch(()=>false)){
          await option.click({timeout:3_000});await frame.waitForTimeout(500);
          return true;
        }
      }
      const choices=[
        scope.getByText(exact).first(),
        scope.locator('label, [role="radio"], .q-radio, .q-item').filter({hasText:contains}).first(),
      ];
      for(const choice of choices){
        if(!await choice.isVisible({timeout:500}).catch(()=>false))continue;
        await choice.click({timeout:3_000});
        // Le libellé et le radio sont parfois deux éléments séparés. Remonter
        // jusqu'à la ligne du client et activer explicitement son contrôle.
        const row=choice.locator('xpath=ancestor-or-self::*[contains(@class,"q-radio") or contains(@class,"q-item") or @role="radio"][1]');
        const radio=row.locator('input[type="radio"], [role="radio"]').first();
        if(await radio.count().catch(()=>0)){
          const checked=await radio.isChecked().catch(()=>radio.getAttribute('aria-checked').then(value=>value==='true').catch(()=>false));
          if(!checked)await radio.click({force:true,timeout:2_000}).catch(()=>undefined);
        }
        await frame.waitForTimeout(500);
        return true;
      }
      // Repli DOM pour les nouvelles tuiles Total qui n'exposent plus de
      // role=radio/option exploitable. Choisir le plus petit élément visible
      // contenant le nom ou le numéro client, puis cliquer sa ligne interactive.
      const nativeSelected=name.replace(/[^A-Z0-9]/gi,'').length>=4&&await frame.evaluate((candidate)=>{
        const normalize=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
        const wanted=normalize(candidate);
        const visible=(element:Element)=>{
          const node=element as HTMLElement;const style=getComputedStyle(node);
          return style.display!=='none'&&style.visibility!=='hidden'&&Boolean(node.offsetWidth||node.offsetHeight||node.getClientRects().length);
        };
        const matches=Array.from(document.querySelectorAll<HTMLElement>('label, [role="radio"], [role="option"], .q-radio, .q-item, button, li, tr'))
          .filter(element=>visible(element)&&normalize(element.textContent??'').includes(wanted))
          .sort((left,right)=>(left.textContent??'').length-(right.textContent??'').length);
        const target=matches[0];if(!target)return false;
        (target.closest<HTMLElement>('label, [role="radio"], [role="option"], .q-radio, .q-item, button, li, tr')??target).click();
        return true;
      },name).catch(()=>false);
      if(nativeSelected){
        await frame.waitForTimeout(500);
        return true;
      }
      // Certains comptes demandent aussi un site après le client. Choisir le
      // site configuré, ou à défaut la première option disponible.
      const selects=scope.locator('[role="combobox"], .q-select');
      if(await selects.count()>1){
        const siteSelect=selects.nth(1);
        if(await siteSelect.isVisible().catch(()=>false)){
          await siteSelect.click({timeout:2_000});await frame.waitForTimeout(300);
          const [connection]=await this.db.query<{site_number:string}>(`SELECT site_number FROM total_mobility_connection WHERE enabled LIMIT 1`);
          const site=connection?.site_number?.trim();
          const options=frame.locator('[role="option"], .q-menu .q-item, .q-virtual-scroll__content .q-item').filter({visible:true});
          const target=site?options.filter({hasText:new RegExp(site.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).first():options.first();
          if(await target.isVisible({timeout:1_000}).catch(()=>false))await target.click({timeout:2_000});
          const ok=frame.getByRole('button',{name:/^\s*ok\s*$/i}).first();
          if(await ok.isEnabled({timeout:2_000}).catch(()=>false))return true;
        }
      }
    }
    return false;
  }

  private async confirmTotalCustomerSelection(){
    const page=this.page;if(!page)return false;
    for(const frame of page.frames()){
      const candidates=[
        frame.getByRole('button',{name:/^\s*ok\s*$/i}).first(),
        frame.locator('button, .q-btn, [role="button"]').filter({hasText:/^\s*ok\s*$/i}).first(),
      ];
      for(const ok of candidates){
        if(!await ok.isVisible({timeout:400}).catch(()=>false)||!await ok.isEnabled().catch(()=>true))continue;
        if(await ok.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false))return true;
      }
      const native=await frame.evaluate(()=>{
        const visible=(element:HTMLElement)=>{
          const style=getComputedStyle(element);
          return style.display!=='none'&&style.visibility!=='hidden'&&Boolean(element.offsetWidth||element.offsetHeight||element.getClientRects().length);
        };
        const ok=Array.from(document.querySelectorAll<HTMLElement>('button, .q-btn, [role="button"], div'))
          .filter(element=>visible(element)&&/^\s*ok\s*$/i.test(element.textContent??''))
          .sort((left,right)=>(left.textContent??'').length-(right.textContent??'').length)[0];
        if(!ok)return false;ok.click();return true;
      }).catch(()=>false);
      if(native)return true;
    }
    return false;
  }

  private cardsFromUnknown(input:unknown):RemoteCardStatus[]{
    const result:RemoteCardStatus[]=[];
    const visit=(value:unknown)=>{
      if(Array.isArray(value)){value.forEach(visit);return;}
      if(!value||typeof value!=='object')return;
      const row=value as Record<string,unknown>;
      const read=(pattern:RegExp)=>Object.entries(row).find(([key])=>pattern.test(key))?.[1];
      const cardNumber=read(/card.*(number|no)|pan|numero.*carte|support.*(number|no)/i);
      const paymentNumber=read(/payment.*method.*(number|no)|(?:number|no).*payment.*method|mode.*paiement.*num|num.*mode.*paiement/i);
      const number=cardNumber??paymentNumber;
      const status=read(/card.*status|status.*card|payment.*method.*status|status.*payment.*method|statut|status|state/i);
      const paymentMethodType=read(/payment.*method.*type|type.*payment.*method|type.*mode.*paiement|mode.*paiement.*type/i);
      if((typeof number==='string'||typeof number==='number')&&(typeof status==='string'||typeof status==='number')){
        const cardDigits=String(cardNumber??'').replace(/\D/g,'');
        const paymentDigits=String(paymentNumber??'').replace(/\D/g,'');
        const official=(cardDigits?cardDigits.slice(-4):paymentDigits.slice(0,4)).padStart(4,'0');
        result.push({cardNumber:official,paymentMethodNumber:String(paymentNumber??''),paymentMethodType:String(paymentMethodType??''),status:String(status),
          holderName:String(read(/holder|titulaire|beneficiary|owner/i)??''),registration:String(read(/registration|immatriculation|plate/i)??''),
          expiresOn:this.parseTotalDate(read(/expir|expiry|valid.*until/i)),monthlyLimit:this.parseAmount(read(/monthly.*limit|card.*limit|plafond|ceiling/i)),raw:row});
      }
      Object.values(row).forEach(visit);
    };
    visit(input);return result;
  }

  private cardsFromVisibleText(text:string):RemoteCardStatus[]{
    const lines=text.split(/\r?\n/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean);
    const result:RemoteCardStatus[]=[];
    for(let index=0;index<lines.length;index++){
      if(!/^\d{4}$/.test(lines[index]))continue;
      const window=lines.slice(index+1,index+10);
      const status=window.find(value=>/^(?:valide|active?|inactive?|bloqu[ée]?e?|suspendu?e?|oppos[ée]e?|annul[ée]e?|expir[ée]e?)$/i.test(value));
      if(!status)continue;
      const registration=window.find(value=>/^HORS\s+PARC$/i.test(value)||/\b(?:TU|TN)\b|\d{2,4}\s*(?:TU|TN)/i.test(value));
      const statusIndex=window.indexOf(status);
      const holderName=window.slice(statusIndex+1).find(value=>
        !/^\d{4}(?:\s+\d+)+$/.test(value)&&
        !/\b(?:TU|TN)\b|\d{2,4}\s*(?:TU|TN)/i.test(value)&&
        !/^\d{2}-\d{2}-\d{4}$/.test(value)&&
        !/postpay|prépay|debit|crédit/i.test(value))??'';
      const paymentMethodNumber=window.find(value=>/^(?:\d{6,18}|\d{4}(?:\s+\d+){1,3})$/.test(value));
      const expiresOn=this.parseTotalDate(window.find(value=>/^\d{2}-\d{2}-\d{4}$/.test(value)));
      const paymentMethodType=window.find(value=>/postpay|prépay|prepay|débit|debit|crédit|credit/i.test(value));
      result.push({cardNumber:lines[index],paymentMethodNumber,paymentMethodType,status,registration,holderName,expiresOn,raw:{source:'visible-text'}});
    }
    // Dans la q-table actuelle, innerText peut réunir toutes les cellules
    // d'une ligne. Exemple : « 0004 Postpayée VALIDE 0004 0 8 6987 TU 219
    // t-king 30-06-2030 ». Lire aussi cette représentation aplatie.
    const flat=text.replace(/\s+/g,' ').trim();
    const pattern=/(?:^|\s)(\d{4})\s+(?:postpay[ée]e?|pr[ée]pay[ée]e?|carte|badge)\s+(valide|active?|inactive?|bloqu[ée]e?|suspendu?e?|oppos[ée]e?|annul[ée]e?|expir[ée]e?)(?=\s)/giu;
    for(const match of flat.matchAll(pattern)){
      const tail=flat.slice((match.index??0)+match[0].length,(match.index??0)+match[0].length+180);
      const registration=tail.match(/\b\d{1,4}\s*(?:TU|TN)\s*\d{1,4}\b/i)?.[0];
      const expiry=tail.search(/\b\d{2}-\d{2}-\d{4}\b/);
      const beforeExpiry=expiry>=0?tail.slice(0,expiry):tail;
      const holderName=beforeExpiry.replace(/^\s*\d{4}(?:\s+\d+)+\s*/,'')
        .replace(registration??'','').trim().split(/\s{2,}/)[0]??'';
      const paymentMethodNumber=tail.match(/^\s*((?:\d{6,18}|\d{4}(?:\s+\d+){1,3}))\b/)?.[1];
      result.push({cardNumber:match[1],paymentMethodNumber,paymentMethodType:match[0].match(/postpay[ée]e?|pr[ée]pay[ée]e?/i)?.[0],status:match[2],registration,holderName,
        expiresOn:this.parseTotalDate(tail.match(/\b\d{2}-\d{2}-\d{4}\b/)?.[0]),raw:{source:'flat-visible-text'}});
    }
    return result;
  }
  private parseTotalDate(value:unknown){
    const match=String(value??'').match(/^(\d{2})[-/]([0-1]\d)[-/](\d{4})$/);return match?`${match[3]}-${match[2]}-${match[1]}`:undefined;
  }
  private parseAmount(value:unknown){
    const amount=Number(String(value??'').replace(/[^\d,.-]/g,'').replace(',','.'));return Number.isFinite(amount)&&amount>=0?amount:undefined;
  }
  private uniqueCards(cards:RemoteCardStatus[]){
    const merged=new Map<string,RemoteCardStatus>();
    for(const card of cards){
      const rawDigits=card.cardNumber.replace(/\D/g,'');
      const digits=rawDigits&&rawDigits.length<=4?rawDigits.padStart(4,'0'):rawDigits.slice(-4);
      const paymentDigits=String(card.paymentMethodNumber??'').replace(/\D/g,'');
      const corroborated=paymentDigits.length>4||Boolean(card.registration?.trim())||Boolean(card.holderName?.trim())||Boolean(card.expiresOn);
      // Les numéros de carte Total visibles dans « Gérer » ont exactement
      // quatre chiffres. Cette validation évite de prendre les compteurs du
      // paginator (0, 1, 10...) pour des cartes.
      if(digits.length!==4||!corroborated)continue;
      const key=digits;
      const previous=merged.get(key);
      merged.set(key,{...previous,...card,cardNumber:key,
        paymentMethodNumber:card.paymentMethodNumber||previous?.paymentMethodNumber,
        paymentMethodType:card.paymentMethodType||previous?.paymentMethodType,
        holderName:card.holderName||previous?.holderName,registration:card.registration||previous?.registration,
        expiresOn:card.expiresOn||previous?.expiresOn,
        monthlyLimit:card.monthlyLimit!==undefined?card.monthlyLimit:previous?.monthlyLimit,
        raw:{...(previous?.raw??{}),...(card.raw??{})}});
    }
    return [...merged.values()];
  }

  private async fillFirst(page: Page, selectors: string[], value: string) {
    if (await this.tryFillFirst(page, selectors, value, 30_000)) return;
    throw new Error(
      'Le formulaire de connexion Total a changé (champ introuvable)',
    );
  }

  private async tryFillFirst(
    page: Page,
    selectors: string[],
    value: string,
    timeout = 8_000,
  ) {
    const input = await this.findVisible(page, selectors, timeout);
    if (input) {
      const editable = await input.isEditable().catch(() => false);
      if (!editable) return false;
      await input.fill(value);
      return true;
    }
    return false;
  }

  private async clickSubmit(page: Page) {
    const button = await this.findVisible(
      page,
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Connexion")',
        'button:has-text("Se connecter")',
        'button:has-text("Continuer")',
        'button:has-text("Suivant")',
        'button:has-text("Valider")',
        'button:has-text("Vérifier")',
        'button:has-text("Verify")',
      ],
      10_000,
    );
    if (!button)
      throw new Error('Le bouton de connexion Total est introuvable');
    await button.click();
  }

  private async clickLoginEntryIfPresent(page: Page) {
    const username = await this.findVisible(
      page,
      ['input[type="email"]', 'input[name="loginID"]', 'input[autocomplete="username"]'],
      3_000,
    );
    if (username) return;
    const entry = await this.findVisible(
      page,
      [
        'a:has-text("Connexion")',
        'button:has-text("Connexion")',
        'a:has-text("Se connecter")',
        'button:has-text("Se connecter")',
        '[data-testid*="login" i]',
      ],
      5_000,
    );
    if (entry) {
      await entry.click();
      await page.waitForTimeout(500);
    }
  }

  private async findVisible(
    page: Page,
    selectors: string[],
    timeout: number,
  ): Promise<Locator | undefined> {
    const deadline = Date.now() + timeout;
    do {
      for (const frame of page.frames()) {
        const found = await this.findVisibleInFrame(frame, selectors);
        if (found) return found;
      }
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
    return undefined;
  }

  private async findVisibleInFrame(frame: Frame, selectors: string[]) {
    for (const selector of selectors) {
      const candidates = frame.locator(selector);
      const count = Math.min(await candidates.count().catch(() => 0), 10);
      for (let index = 0; index < count; index++) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    return undefined;
  }

  private otpSelectors() {
    return [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[name*="code" i]',
      'input[id*="code" i]',
    ];
  }

  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(message);
    this.setStatus('FAILED', message);
    void this.closeBrowser();
  }

  private async closeBrowser() {
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }

  private status(state: AgentState, message: string): AgentStatus {
    return { state, message, updatedAt: new Date().toISOString() };
  }

  private setStatus(state: AgentState, message: string) {
    this.statusValue = this.status(state, message);
    if(this.requestedMode==='REFERENCE')this.referenceStatusValue=this.statusValue;
    this.logger.log(`État agent Total ${state} — ${message}`);
  }
}
