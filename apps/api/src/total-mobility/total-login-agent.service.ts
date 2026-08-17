import {
  BadRequestException,
  ConflictException,
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
      throw new ConflictException('Une connexion Total est déjà en cours');
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
    const context = await this.browser.newContext({ locale: 'fr-FR' });
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
    this.setStatus('EXTRACTING', 'Chauffeurs actualisés. Synchronisation des véhicules et kilométrages…');
    const vehicles=await this.total.importVehicles(await this.extractVehicles(),this.actor);
    this.setStatus('EXTRACTING', 'Véhicules et kilométrages actualisés. Ouverture de « Gérer les cartes »…');
    const cardRows = await this.extractCardStatuses();
    const cards = await this.total.importCardStatuses(cardRows, this.actor);
    this.statusValue = {
      ...this.status('SUCCESS', 'Transactions, chauffeurs, véhicules, kilométrages et cartes Total actualisés'),
      result: { ...transactions, drivers, vehicles, cards },
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
      this.setStatus('EXTRACTING','Actualisation Total : transactions, chauffeurs, véhicules, kilomètres et cartes…');
      const transactions=await this.total.syncNow(this.actor);
      const drivers=await this.total.importDrivers(await this.extractDrivers(),this.actor);
      const vehicles=await this.total.importVehicles(await this.extractVehicles(),this.actor);
      const cards=await this.total.importCardStatuses(await this.extractCardStatuses(),this.actor);
      this.statusValue={...this.status('SUCCESS','Données Total actualisées automatiquement'),result:{...transactions,drivers,vehicles,cards,live:true}};
    }catch(error){this.fail(error);}
  }

  private async extractDrivers():Promise<RemoteDriver[]>{
    const page=this.page;if(!page)throw new Error('Le navigateur Total a été fermé avant l’extraction des chauffeurs');
    const captured:unknown[]=[];
    const listener=async(response:import('playwright').Response)=>{if(!/driver|chauffeur/i.test(response.url()))return;try{captured.push(await response.json());}catch{/* non JSON */}};
    page.on('response',listener);
    try{
      await page.goto('https://customer.fleet.totalenergies.com/tn/drivers',{waitUntil:'domcontentloaded',timeout:60_000});
      await page.waitForTimeout(4_000);
      const jsonDrivers=this.driversFromUnknown(captured);if(jsonDrivers.length)return this.uniqueDrivers(jsonDrivers);
      // Le portail Total utilise selon sa version un tableau HTML, Angular
      // Material ou une grille ARIA. Il ne faut donc pas dépendre uniquement
      // de `table tbody tr`.
      const rowTexts=await page.locator('table tbody tr, mat-row, [role="row"], .mat-mdc-row, .mat-row')
        .evaluateAll(elements=>elements.map(row=>(row.textContent??'').replace(/\s+/g,' ').trim()).filter(Boolean));
      const fromRows=this.driversFromVisibleRows(rowTexts);if(fromRows.length)return this.uniqueDrivers(fromRows);
      // Dernier recours robuste pour la grille virtuelle actuelle de Mobility
      // Business : lecture du texte visible (0001, prénom, nom, etc.).
      const bodyText=await page.locator('body').innerText();
      return this.uniqueDrivers(this.driversFromVisibleText(bodyText));
    }finally{page.off('response',listener);}
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
      await page.waitForTimeout(4_000);
      const fromJson=this.cardsFromUnknown(captured);
      if(fromJson.length)return this.uniqueCards(fromJson);
      const rows=await page.locator('table tbody tr').evaluateAll(elements=>elements.map(row=>
        Array.from(row.querySelectorAll('td')).map(cell=>(cell.textContent??'').trim())));
      const fromTable=rows.map(cells=>({cardNumber:cells.find(value=>/\d{4,}/.test(value))??'',
        status:cells.find(value=>/active|inactive|bloqu|suspend|oppos|actif|inactif/i.test(value))??'',
        holderName:cells[1],registration:cells.find(value=>/\bTU\b|\d{2,4}\s*TU/i.test(value)),raw:{cells}}))
        .filter(row=>row.cardNumber&&row.status);
      return this.uniqueCards(fromTable);
    }finally{page.off('response',listener);}
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
