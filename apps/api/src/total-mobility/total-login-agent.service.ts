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
import type { RemoteCardStatus, RemoteDriver, RemoteVehicle } from './total-mobility.service';

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
  private refreshToken?: string;
  private liveTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
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
    if (!['IDLE', 'FAILED'].includes(this.statusValue.state)) return;
    if (!process.env.TOTAL_USERNAME?.trim() || !process.env.TOTAL_PASSWORD) return;
    const [connection] = await this.db.query<{ enabled: boolean }>(
      `SELECT enabled FROM total_mobility_connection WHERE enabled LIMIT 1`,
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
      this.start({ sub: user.id, email: user.email });
    } catch (error) {
      this.logger.warn(`Agent Total non redémarré : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getStatus() {
    return this.statusValue;
  }

  start(actor: Actor) {
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
    this.refreshToken = undefined;
    this.setStatus('STARTING', 'Démarrage sécurisé de l’agent Total…');
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
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.refreshToken) return this.finish(this.refreshToken);
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
    throw new Error('Total n’a pas terminé la connexion dans le délai prévu');
  }

  private captureTokens(page: Page) {
    page.on('response', async (response) => {
      if (!/(oauth2\/token|\/token(?:\?|$))/i.test(response.url())) return;
      try {
        const json = (await response.json()) as Record<string, unknown>;
        const token = json.refresh_token;
        if (typeof token === 'string' && token.length > 20)
          this.refreshToken = token;
      } catch {
        /* La réponse observée n’est pas du JSON OAuth. */
      }
    });
  }

  private async finish(refreshToken: string) {
    if (!this.actor || this.statusValue.state === 'EXTRACTING') return;
    this.setStatus(
      'EXTRACTING',
      'Connexion réussie. Extraction des transactions…',
    );
    await this.total.reconnect(refreshToken, this.actor);
    const transactions = await this.total.syncNow(this.actor, '2026-08-01');
    this.setStatus('EXTRACTING', 'Transactions actualisées. Synchronisation des chauffeurs…');
    const driverRows=await this.extractDrivers();
    const drivers=await this.total.importDrivers(driverRows,this.actor);
    this.setStatus('EXTRACTING', 'Chauffeurs actualisés. Extraction des cartes de tous les clients…');
    const cards=await this.extractAllClientCards();
    this.statusValue = {
      ...this.status('SUCCESS', 'Transactions, kilométrages, chauffeurs et cartes Total actualisés'),
      result: { ...transactions, drivers, cards },
    };
    this.scheduleLiveRefresh();
  }

  private scheduleLiveRefresh(){
    if(this.liveTimer)clearInterval(this.liveTimer);
    const minutes=Math.max(1,Number(process.env.TOTAL_LIVE_SYNC_MINUTES??5));
    this.liveTimer=setInterval(()=>void this.liveRefresh(),minutes*60_000);this.liveTimer.unref();
  }
  private async liveRefresh(){
    if(!this.actor||!this.page||['STARTING','SIGNING_IN','CODE_REQUIRED','EXTRACTING'].includes(this.statusValue.state))return;
    try{
      this.setStatus('EXTRACTING','Actualisation Total : transactions, kilométrages, chauffeurs et cartes…');
      const transactions=await this.total.syncNow(this.actor);
      const drivers=await this.total.importDrivers(await this.extractDrivers(),this.actor);
      const cards=await this.extractAllClientCards();
      this.statusValue={...this.status('SUCCESS','Données Total actualisées automatiquement'),result:{...transactions,drivers,cards,live:true}};
    }catch(error){this.fail(error);}
  }

  private async extractDrivers():Promise<RemoteDriver[]>{
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé avant l’extraction des chauffeurs');
    const captured:unknown[]=[];
    const listener=async(response:import('playwright').Response)=>{if(!/driver|chauffeur/i.test(response.url()))return;try{captured.push(await response.json());}catch{/* non JSON */}};
    page.on('response',listener);
    try{
      await this.selectConfiguredClient();
      await this.openDriversFromTotalMenu();
      await page.waitForTimeout(4_000);
      const jsonDrivers=this.driversFromUnknown(captured);
      // Force le rendu des dernières lignes, y compris lorsque Total charge le
      // module dans une iframe.
      for(const frame of page.frames())await frame.evaluate(async()=>{
        const candidates=[document.scrollingElement,...Array.from(document.querySelectorAll<HTMLElement>('[role="grid"], [role="table"], .table-container, .mat-table, main'))].filter(Boolean) as HTMLElement[];
        for(const element of candidates){element.scrollTop=element.scrollHeight;}
        await new Promise(resolve=>setTimeout(resolve,700));
      }).catch(()=>undefined);
      // Le portail Total utilise selon sa version un tableau HTML, Angular
      // Material ou une grille ARIA. Il ne faut donc pas dépendre uniquement
      // de `table tbody tr`.
      const rowTexts:string[]=[];const bodyTexts:string[]=[];
      for(const frame of page.frames()){
        rowTexts.push(...await frame.locator('table tr, mat-row, [role="row"], .mat-mdc-row, .mat-row, [class*="row" i]')
          .evaluateAll(elements=>elements.map(row=>(row.textContent??'').replace(/\s+/g,' ').trim()).filter(Boolean)).catch(()=>[]));
        const text=await frame.locator('body').innerText().catch(()=>'');if(text)bodyTexts.push(text);
      }
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
      const chooser=page.getByText(/choisir un client/i).first();
      if(await chooser.isVisible({timeout:1_500}).catch(()=>false)){
        await chooser.click();await page.waitForTimeout(2_500);
      }
      const search=page.locator('input[type="search"], input[placeholder*="recherche" i], input[placeholder*="client" i]').filter({visible:true}).first();
      const names=[connection.customer_name,connection.company_code]
        .map(value=>value?.trim()).filter((value):value is string=>Boolean(value));
      // Sur cette version du portail, la recherche accepte le nom commercial
      // (« DELTA CUISINE »), pas le numéro client 10391.
      if(await search.isVisible({timeout:1_000}).catch(()=>false)){
        await search.fill(names[0]??'');await page.waitForTimeout(1_200);
      }
      // La version tunisienne affiche des boutons radio suivis d'un bouton
      // « Ok ». Cliquer seulement le texte/la carte ne valide pas le client et
      // laisse l'agent bloqué sur /customer-selection.
      if(/customer-selection/i.test(page.url())){
        let selected=false;
        for(const frame of page.frames()){
          for(const name of names){
            const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            const exactName=new RegExp(`^\\s*${escaped}\\s*$`,'i');
            const text=frame.getByText(exactName).first();
            if(!await text.isVisible({timeout:500}).catch(()=>false))continue;
            // Le radio Quasar possède un input natif caché qui ne reflète pas
            // toujours immédiatement son état. Cliquer sur le texte visible,
            // comme le fait l'utilisateur, déclenche correctement le modèle.
            await text.click({timeout:3_000});
            await frame.waitForTimeout(700);
            selected=true;
            break;
          }
          if(selected)break;
        }
        if(!selected)throw new Error(`client ${names.join(' / ')||customer} introuvable`);

        let confirmed=false;
        for(const frame of page.frames()){
          const ok=frame.getByRole('button',{name:/^\s*ok\s*$/i}).first();
          if(await ok.isVisible({timeout:500}).catch(()=>false)){
            await ok.click();confirmed=true;break;
          }
          const fallback=frame.locator('button, [role="button"], input[type="submit"]')
            .filter({hasText:/^\s*ok\s*$/i}).first();
          if(await fallback.isVisible({timeout:300}).catch(()=>false)){
            await fallback.click();confirmed=true;break;
          }
        }
        if(!confirmed)throw new Error('bouton Ok de sélection du client introuvable');
        await page.waitForURL(url=>!url.pathname.includes('customer-selection'),{timeout:15_000});
        await page.waitForLoadState('domcontentloaded').catch(()=>undefined);
      }
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
      if(!/card|carte|support/i.test(response.url()))return;
      try{captured.push(await response.json());}catch{/* Réponse Total non JSON. */}
    };
    page.on('response',listener);
    try{
      await page.goto('https://customer.fleet.totalenergies.com/tn/cards/manage-card',{waitUntil:'domcontentloaded',timeout:60_000});
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
          const next=frame.locator('button[aria-label*="next page" i], button[aria-label*="page suivante" i], button[title*="suivant" i]').first();
          if(await next.isVisible({timeout:250}).catch(()=>false)&&await next.isEnabled().catch(()=>false)){
            await next.click();await page.waitForTimeout(900);advanced=true;break;
          }
        }
        if(!advanced)break;
      }
      const fromJson=this.cardsFromUnknown(captured);
      const fromTable=rows.map(cells=>({cardNumber:cells[1]?.match(/^\d{4,}$/)?.[0]??cells.find(value=>/^\d{4,}$/.test(value))??'',
        status:cells[3]&&/valid|active|inactive|bloqu|suspend|oppos|actif|inactif|annul|expir/i.test(cells[3])?cells[3]:cells.find(value=>/valid|active|inactive|bloqu|suspend|oppos|actif|inactif|annul|expir/i.test(value))??'',
        holderName:cells[6]??'',registration:cells.find(value=>/\b(?:TU|TN)\b|\d{2,4}\s*(?:TU|TN)/i.test(value)),raw:{cells}}))
        .filter(row=>row.cardNumber&&row.status);
      const result=this.uniqueCards([...fromJson,...fromTable]);
      if(!result.length){
        const visible=(await Promise.all(page.frames().map(frame=>frame.locator('body').innerText().catch(()=>''))))
          .join(' ').replace(/\s+/g,' ').slice(0,400);
        this.logger.warn(`Aucune carte lue sur ${page.url()}. Contenu visible : ${visible||'vide'}`);
      }
      return result;
    }finally{page.off('response',listener);}
  }

  private async extractAllClientCards(){
    const page=this.page;if(!page||!this.actor)throw new Error('La session Total est indisponible pour les cartes');
    await page.goto('https://customer.fleet.totalenergies.com/tn/customer-selection',{waitUntil:'domcontentloaded',timeout:60_000});
    await page.waitForTimeout(2_500);
    const names:string[]=[];
    const knownClients=['DELTA CUISINE','IKIT TN','DELTA CUISINE DISTRIBUTION','STE LES TECHNIQUES DE MARBRE'];
    for(const frame of page.frames()){
      const candidates=await frame.locator('label, [role="radio"], .q-radio, .q-item:has([role="radio"]), .q-item:has(input[type="radio"])').evaluateAll(elements=>elements.map(element=>(element.textContent??'').replace(/\s+/g,' ').trim()).filter(Boolean)).catch(()=>[]);
      for(const name of candidates){
        const clean=name.replace(/^\s*[○◉●]\s*/,'').trim();
        if(clean.length>2&&!/choisir|bienvenue|continuer|annuler|^ok$/i.test(clean)&&!names.includes(clean))names.push(clean);
      }
      const body=(await frame.locator('body').innerText().catch(()=>''));
      for(const known of knownClients)if(body.toUpperCase().includes(known)&&!names.includes(known))names.push(known);
    }
    if(!names.length)throw new Error('Aucun client Total trouvé dans « Choisir un client »');
    const results:unknown[]=[];
    for(const name of names){
      if(!/customer-selection/i.test(page.url())){
        await page.goto('https://customer.fleet.totalenergies.com/tn/customer-selection',{waitUntil:'domcontentloaded',timeout:60_000});
        await page.waitForTimeout(1_500);
      }
      const selected=await this.selectTotalClientByName(name);
      if(!selected){results.push({client:name,error:'Client non sélectionnable'});continue;}
      let confirmed=false;
      for(const frame of page.frames()){
        const ok=frame.getByRole('button',{name:/^\s*ok\s*$/i}).first();
        if(await ok.isVisible({timeout:500}).catch(()=>false)){await ok.click();confirmed=true;break;}
      }
      if(!confirmed){results.push({client:name,error:'Bouton Ok introuvable'});continue;}
      await page.waitForURL(url=>!url.pathname.includes('customer-selection'),{timeout:15_000});
      await page.waitForTimeout(1_500);
      try{
        const cards=await this.extractCardStatuses();
        results.push(cards.length
          ?await this.total.importCardStatuses(cards,this.actor,name)
          :{client:name,extracted:0,created:0,matched:0,message:'Aucune carte disponible'});
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        this.logger.warn(`Extraction des cartes Total pour ${name} : ${message}`);
        results.push({client:name,error:message});
      }
    }
    return results;
  }

  private async selectTotalClientByName(name:string){
    const page=this.page;if(!page)return false;
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const exact=new RegExp(`^\\s*${escaped}\\s*$`,'i');
    const contains=new RegExp(escaped,'i');
    for(const frame of page.frames()){
      const search=frame.locator('input[type="search"], input[placeholder*="recherche" i], input[placeholder*="client" i]').first();
      if(await search.isVisible({timeout:250}).catch(()=>false)){
        await search.fill(name);await frame.waitForTimeout(500);
      }
      const choices=[
        frame.getByText(exact).first(),
        frame.locator('label, [role="radio"], .q-radio, .q-item').filter({hasText:contains}).first(),
      ];
      for(const choice of choices){
        if(!await choice.isVisible({timeout:500}).catch(()=>false))continue;
        await choice.click({timeout:3_000});await frame.waitForTimeout(500);return true;
      }
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
      const number=read(/card.*(number|no)|pan|numero.*carte/i);
      const status=read(/card.*status|status.*card|statut|state/i);
      if((typeof number==='string'||typeof number==='number')&&(typeof status==='string'||typeof status==='number'))
        result.push({cardNumber:String(number),status:String(status),holderName:String(read(/holder|titulaire|beneficiary/i)??''),registration:String(read(/registration|immatriculation|plate/i)??''),raw:row});
      Object.values(row).forEach(visit);
    };
    visit(input);return result;
  }
  private uniqueCards(cards:RemoteCardStatus[]){
    const seen=new Set<string>();return cards.filter(card=>{const key=card.cardNumber.replace(/\D/g,'');if(!key||seen.has(key))return false;seen.add(key);return true;});
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
  }
}
