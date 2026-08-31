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
  private activeClientName?: string;
  private refreshToken?: string;
  private accessToken?: string;
  private liveTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private lastCardDiagnostic='';
  private statusValue: AgentStatus = this.status('IDLE', 'Agent Total prêt');

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
    return this.statusValue;
  }

  start(actor: Actor, companyId?: string) {
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
    this.actor = actor;
    this.requestedCompanyId = companyId;
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
    // En mode ciblé, extractSelectedCompany réalise lui-même l'unique
    // sélection demandée. L'ancien enchaînement sélectionnait DC ici puis le
    // resélectionnait immédiatement, ce que Total refusait.
    if(!this.requestedCompanyId)await this.selectConfiguredClient();
    this.setStatus('EXTRACTING', 'Client Total sélectionné. Extraction des transactions…');
    if(refreshToken)await this.total.reconnect(refreshToken, this.actor);
    else if(!accessToken)throw new Error('Total n’a fourni aucun jeton de session exploitable');
    this.setStatus('EXTRACTING', this.requestedCompanyId
      ? 'Extraction des transactions du client sélectionné…'
      : 'Extraction complète des transactions de tous les clients…');
    const selectedCompanyId=this.requestedCompanyId;
    const clients=selectedCompanyId
      ? [await this.extractSelectedCompany(selectedCompanyId)]
      : await this.extractAllClientCards();
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
    this.scheduleLiveRefresh();
  }

  private scheduleLiveRefresh(){
    if(this.liveTimer)clearInterval(this.liveTimer);
    const minutes=Math.max(1,Number(process.env.TOTAL_LIVE_SYNC_MINUTES??1));
    this.liveTimer=setInterval(()=>void this.liveRefresh(),minutes*60_000);this.liveTimer.unref();
  }
  private async liveRefresh(){
    if(!this.actor||['STARTING','SIGNING_IN','CODE_REQUIRED','EXTRACTING'].includes(this.statusValue.state))return;
    if(!this.browser||!this.page||this.page.isClosed()){
      this.fail(new Error('Session Total interrompue; l’agent va se reconnecter automatiquement'));
      return;
    }
    try{
      this.setStatus('EXTRACTING','Actualisation des transactions Total…');
      // La passe précédente se termine sur le dernier client. Revenir au
      // client configuré avant chaque cycle empêche d'attribuer les données du
      // dernier client à DELTA CUISINE lors de la prochaine extraction.
      const clients=this.requestedCompanyId
        ? [await this.extractSelectedCompany(this.requestedCompanyId)]
        : await this.extractAllClientCards();
      const summary=this.summarizeClientResults(clients);
      if(summary.fetched<1)
        throw new Error('Total n’a renvoyé aucune transaction : données existantes conservées');
      this.statusValue={...this.status('SUCCESS',`${summary.visible} transaction(s) Total actualisée(s) automatiquement`),result:{clients,...summary,live:true}};
    }catch(error){this.fail(error);}
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
      const expectedName=aliases[String(connection.company_code??'').toUpperCase()]??String(connection.customer_name??'').trim().toUpperCase();
      const knownNames=Object.values(aliases).sort((left,right)=>right.length-left.length);
      for(const frame of page.frames()){
        const visible=await frame.locator('header, .q-header, nav, [class*="customer" i], [class*="client" i]')
          .allTextContents().catch(()=>[]);
        const normalized=visible.join(' ').toUpperCase().replace(/[^A-Z0-9]/g,'');
        const detected=knownNames.find(name=>normalized.includes(name.replace(/[^A-Z0-9]/g,'')));
        if(detected&&detected===expectedName){
          this.activeClientName=detected;
          return;
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
      await this.openManageCardsFromMenu();
      this.setStatus('EXTRACTING','Total : lecture de la grille des cartes…');
      await page.waitForTimeout(2_500);
      // La page « Gérer » n'appelle pas toujours l'API des cartes au premier
      // rendu. Le clic sur Recherche est nécessaire, comme dans le parcours
      // utilisateur visible sur Mobility Business.
      for(const frame of page.frames()){
        const search=frame.getByRole('button',{name:/^\s*recherche\s*$/i}).first();
        if(await search.isVisible({timeout:500}).catch(()=>false)){
          await search.click();break;
        }
      }
      await page.waitForTimeout(1_500);
      this.setStatus('EXTRACTING','Total : affichage de 50 cartes par page…');
      const pageSize50=await this.setCardRowsPerPage50();
      if(!pageSize50)throw new Error('Le sélecteur « Lignes par page » ne propose pas 50 cartes');
      await page.waitForTimeout(1_000);
      // Attendre la disparition du panneau « Récupération de vos
      // informations » avant de lire le tableau.
      await Promise.all(page.frames().map(frame=>frame.getByText(/récupération de vos informations/i)
        .waitFor({state:'hidden',timeout:20_000}).catch(()=>undefined)));
      for(const frame of page.frames())await frame.evaluate(async()=>{
        const candidates=[document.scrollingElement,...Array.from(document.querySelectorAll<HTMLElement>('[role="grid"], [role="table"], .table-container, .mat-table, main'))].filter(Boolean) as HTMLElement[];
        for(const element of candidates){element.scrollTop=element.scrollHeight;}
        await new Promise(resolve=>setTimeout(resolve,700));
      }).catch(()=>undefined);
      const rows:string[][]=[];
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
      const expectedTotal=paginatorTotals.length?Math.max(...paginatorTotals):undefined;
      if(expectedTotal!==undefined)result=result.map(card=>({...card,raw:{...(card.raw??{}),expectedTotal}}));
      // Le tableau « Gérer » n'expose pas le plafond mensuel. Total le place
      // uniquement dans Modifier > Produit de la carte > Limite. Lire ce
      // détail sans enregistrer la fiche, puis le rattacher au numéro de carte.
      const detailedLimits=await this.extractCardProductLimits(result).catch(error=>{
        this.logger.warn(`Plafonds Total : ${error instanceof Error?error.message:String(error)}`);
        return new Map<string,number>();
      });
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
      this.setStatus('EXTRACTING',`Plafonds Total : carte ${cardIndex+1}/${cards.length} — ${card.cardNumber}`);
      detailPayloads.length=0;
      await this.openManageCardsFromMenu();
      await page.waitForTimeout(600);
      let row:Locator|undefined;
      for(const frame of page.frames()){
        // Rechercher la carte afin de ne pas dépendre de la pagination du
        // tableau. Le portail possède plusieurs filtres : ne remplir que le
        // champ explicitement associé au numéro de carte/mode de paiement.
        const inputs=frame.locator('input:visible');
        let filterFilled=false;
        for(let index=0;index<await inputs.count();index++){
          const input=inputs.nth(index);
          const token=await input.evaluate(element=>[
            element.getAttribute('placeholder'),element.getAttribute('name'),element.getAttribute('aria-label'),
            element.closest('label,mat-form-field,.q-field')?.textContent,
          ].filter(Boolean).join(' ')).catch(()=>'');
          if(!/num[ée]ro.*(?:carte|mode de paiement)|(?:carte|mode de paiement).*num[ée]ro/i.test(token))continue;
          // Le filtre Total porte sur le numéro DU MODE DE PAIEMENT, pas sur
          // le numéro de carte affiché dans la première colonne.
          await input.fill(String(card.paymentMethodNumber??card.cardNumber).replace(/\s+/g,''));
          filterFilled=true;break;
        }
        if(!filterFilled)continue;
        const search=frame.getByRole('button',{name:/^\s*recherche\s*$/i}).first();
        if(await search.isVisible({timeout:300}).catch(()=>false)){
          await search.click({force:true}).catch(()=>undefined);await page.waitForTimeout(600);
        }
        const candidate=frame.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row')
          .filter({hasText:new RegExp(`(?:^|\\D)${card.cardNumber}(?:\\D|$)`) }).first();
        if(await candidate.isVisible({timeout:700}).catch(()=>false)){row=candidate;break;}
      }
      if(!row){this.logger.warn(`Plafond Total ${card.cardNumber} : ligne introuvable`);continue;}
      const radio=row.locator('input[type="radio"], [role="radio"], mat-radio-button').first();
      if(await radio.isVisible({timeout:300}).catch(()=>false))await radio.click({force:true});
      // La grille Total utilise une colonne « Modifier » dont l'icône crayon
      // n'a parfois aucun texte/aria-label. Repérer l'index de l'en-tête puis
      // cliquer le contrôle de la cellule correspondante.
      let columnEdit:Locator|undefined;
      const table=row.locator('xpath=ancestor::table[1]');
      if(await table.count().catch(()=>0)){
        const headers=await table.locator('thead th').allTextContents().catch(()=>[]);
        const editIndex=headers.findIndex(value=>/^\s*modifier\s*$/i.test(value));
        if(editIndex>=0)columnEdit=row.locator('td').nth(editIndex).locator('button, [role="button"], svg, i').first();
      }
      const editCandidates=[
        ...(columnEdit?[columnEdit]:[]),
        row.locator('button[aria-label*="modifier" i], button[title*="modifier" i], button:has-text("edit"), .q-icon:has-text("edit")').first(),
        row.locator('mat-icon:has-text("edit"), .material-icons:has-text("edit"), svg[aria-label*="modifier" i]').first(),
        row.locator('button, [role="button"]').filter({hasText:/modifier|edit/i}).first(),
      ];
      let opened=false;
      for(const edit of editCandidates){
        if(!await edit.isVisible({timeout:300}).catch(()=>false))continue;
        opened=await edit.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);if(opened)break;
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
      if(!opened){this.logger.warn(`Plafond Total ${card.cardNumber} : bouton Modifier introuvable`);continue;}
      await page.waitForURL(/\/cards\/edit-card/i,{timeout:10_000}).catch(()=>undefined);
      // La première étape contient « Limite de Crédit » (ligne de crédit du
      // client, ex. 16 000 TND). Ce n'est jamais le plafond de la carte. Le
      // parcours officiel impose Continuer avant d'ouvrir Produit de la carte.
      let continued=false;
      for(const frame of page.frames()){
        const next=frame.getByRole('button',{name:/^\s*continuer\s*$/i}).first();
        if(await next.isVisible({timeout:1_000}).catch(()=>false)){
          continued=await next.click({force:true,timeout:3_000}).then(()=>true).catch(()=>false);break;
        }
      }
      if(!continued){this.logger.warn(`Plafond Total ${card.cardNumber} : bouton Continuer introuvable`);continue;}
      // La deuxième étape peut s'ouvrir sur un autre panneau. Le plafond
      // recherché est exclusivement dans « Produit de la carte ».
      for(const frame of page.frames()){
        const product=frame.getByText(/^\s*Produit de la carte\s*$/i).filter({visible:true}).first();
        if(await product.isVisible({timeout:500}).catch(()=>false)){
          await product.click({force:true,timeout:3_000}).catch(()=>undefined);
          break;
        }
      }
      await Promise.all(page.frames().map(frame=>frame.getByText(/^\s*Limite de\s*$/i).first()
        .waitFor({state:'visible',timeout:10_000}).catch(()=>undefined)));
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
      if(amount!==undefined){limits.set(card.cardNumber,amount);this.logger.log(`Plafond Total ${card.cardNumber} : ${amount} TND`);}
      else this.logger.warn(`Plafond Total ${card.cardNumber} : valeur introuvable dans Produit de la carte`);
      // Revenir sans sauvegarder : l'agent est strictement en lecture seule.
      for(const frame of page.frames()){
        const cancel=frame.getByRole('button',{name:/^\s*annuler\s*$/i}).first();
        if(await cancel.isVisible({timeout:300}).catch(()=>false)){await cancel.click({force:true}).catch(()=>undefined);break;}
      }
      await page.waitForTimeout(350);
    }
    }finally{page.off('response',detailListener);}
    return limits;
  }

  private async setCardRowsPerPage50(){
    const page=this.page;if(!page)return false;
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
          await option.click({force:true,timeout:3_000});
        }
        await frame.waitForTimeout(900);
        if(await this.cardPaginatorShowsCompleteDcInventory())return true;
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
        await frame.waitForTimeout(700);
        if(await this.cardPaginatorShowsCompleteDcInventory())return true;
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
        await option.click({force:true,timeout:3_000});await frame.waitForTimeout(700);
        if(await this.cardPaginatorShowsCompleteDcInventory())return true;
      }
    }
    return false;
  }

  private async cardPaginatorShowsCompleteDcInventory(){
    const page=this.page;if(!page)return false;
    // Pour les autres sociétés le total varie. Pour DC, les captures Total
    // du 31/08/2026 confirment 40 moyens de paiement VALIDE et 50 lignes/page.
    if(this.activeClientName!=='DELTA CUISINE')return true;
    for(const frame of page.frames()){
      const text=await frame.locator('.q-table__bottom, .mat-paginator, [class*="paginator"], body')
        .allTextContents().catch(()=>[]);
      if(/1\s*[-–]\s*40\s*(?:sur|of)\s*40/i.test(text.join(' ')))return true;
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
    if(/\/cards\/manage-card/i.test(page.url()))return;
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
    const waitForManageCardsReady=async()=>{
      const deadline=Date.now()+20_000;
      while(Date.now()<deadline){
        if(/\/cards\/manage-card/i.test(page.url()))return true;
        for(const currentFrame of page.frames()){
          // Sur la version actuelle du portail tunisien, « Gérer » charge le
          // composant de recherche dans /tn/cards sans changer l'URL. La route
          // /manage-card n'est donc plus un critère obligatoire.
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
    // Toujours repartir du client configuré : une passe précédente se termine
    // sur STE LES TECHNIQUES DE MARBRE et le navigateur reste sur ce client.
    await this.selectConfiguredClient();
    try{
      results.push(await this.extractCurrentClientData('DELTA CUISINE'));
    }catch(error){
      results.push({client:'DELTA CUISINE',error:error instanceof Error?error.message:String(error)});
    }
    // Si l'utilisateur a choisi une société pendant ce cycle automatique,
    // arrêter immédiatement le parcours groupe et honorer ce périmètre seul.
    if(this.requestedCompanyId)
      return [await this.extractSelectedCompany(this.requestedCompanyId)];
    // Ne pas déduire les noms depuis tous les labels Quasar : leurs icônes
    // Material (« arrow_drop_down », etc.) sont aussi exposées comme du texte
    // et seraient prises à tort pour des clients.
    const names=knownClients.filter(name=>name!=='DELTA CUISINE');
    for(const name of names){
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
      try{
        results.push(await this.extractCurrentClientData(name));
      }catch(error){
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

  private async extractCurrentClientData(clientName:string){
    if(!this.actor)throw new Error('Utilisateur de synchronisation Total absent');
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
    const cardRows=await this.extractCardStatuses().catch(error=>{
      this.logger.warn(`Cartes Total ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const cards=cardRows.length
      ?await this.total.importCardStatuses(cardRows,this.actor,clientName)
      :{extracted:0,error:`Aucune carte visible (${this.lastCardDiagnostic})`};
    const transactions=await this.extractCurrentClientTransactions(clientName,company.id);
    const driverRows=await this.extractDrivers().catch(error=>{
      this.logger.warn(`Chauffeurs Total ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const drivers=driverRows.length?await this.total.importDrivers(driverRows,this.actor,clientName):{received:0};
    const vehicleRows=await this.extractVehicles().catch(error=>{
      this.logger.warn(`Véhicules Total ${clientName} : ${error instanceof Error?error.message:String(error)}`);return [];
    });
    const vehicles=vehicleRows.length?await this.total.importVehicles(vehicleRows,this.actor,clientName):{received:0};
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
      if((typeof number==='string'||typeof number==='number')&&(typeof status==='string'||typeof status==='number'))
        result.push({cardNumber:String(cardNumber??paymentNumber??number).replace(/\D/g,'').slice(-4),paymentMethodNumber:String(paymentNumber??''),paymentMethodType:String(paymentMethodType??''),status:String(status),
          holderName:String(read(/holder|titulaire|beneficiary|owner/i)??''),registration:String(read(/registration|immatriculation|plate/i)??''),
          expiresOn:this.parseTotalDate(read(/expir|expiry|valid.*until/i)),monthlyLimit:this.parseAmount(read(/monthly.*limit|card.*limit|plafond|ceiling/i)),raw:row});
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
      const digits=card.cardNumber.replace(/\D/g,'');
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
    this.logger.log(`État agent Total ${state} — ${message}`);
  }
}
