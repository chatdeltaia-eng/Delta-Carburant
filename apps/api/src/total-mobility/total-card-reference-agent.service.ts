import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { TotalLoginAgentService } from './total-login-agent.service';
import { TotalMobilityService } from './total-mobility.service';
import { DatabaseService } from '../database/database.service';

type Actor = { sub: string; email: string };

/**
 * Agent manuel spécialisé dans le référentiel cartes/plafonds.
 *
 * Il utilise le coordinateur de session Total pour garantir qu'une seule SPA
 * est manipulée à la fois, mais n'expose aucune action transactions. Le
 * companyId est transmis sans repli : un lancement IKIT ne peut donc importer
 * ni DC, ni DCD, ni TCM.
 */
@Injectable()
export class TotalCardReferenceAgentService implements OnModuleDestroy {
  private readonly coordinator: TotalLoginAgentService;
  private readonly db: DatabaseService;
  private watchdog?: NodeJS.Timeout;
  private currentRequest?: {actor:Actor;companyId:string};
  private restarting=false;

  constructor(total: TotalMobilityService, db: DatabaseService) {
    this.db = db;
    // Instance volontairement indépendante de l'agent Transactions fourni par
    // Nest. Elle possède son propre Chromium, sa page, ses cookies et son état
    // de société ; son onModuleInit n'est pas appelé, donc aucun worker temps
    // réel ne démarre dans cet agent manuel.
    this.coordinator = new TotalLoginAgentService(total, db);
    // L'instance manuelle n'est pas gérée par le cycle de vie Nest du
    // coordinateur et ne possédait donc aucun watchdog. Surveiller les étapes
    // afin qu'un clic Quasar ou une reconnexion figée ne laisse jamais la
    // fenêtre sur « carte 4/7 » indéfiniment.
    this.watchdog=setInterval(()=>void this.recoverIfStalled(),30_000);
    this.watchdog.unref();
  }

  onModuleDestroy() {
    if(this.watchdog)clearInterval(this.watchdog);
    this.coordinator.onModuleDestroy();
  }

  private async recoverIfStalled(){
    if(this.restarting||!this.currentRequest)return;
    const status=this.coordinator.getReferenceStatus();
    if(!['STARTING','SIGNING_IN','EXTRACTING','FAILED'].includes(status.state))return;
    const age=Date.now()-new Date(status.updatedAt).getTime();
    const failed=status.state==='FAILED';
    if(!failed&&age<180_000)return;
    this.restarting=true;
    try{
      await this.coordinator.restartCardReference(
        this.currentRequest.actor,this.currentRequest.companyId,
        failed?`Reprise après erreur : ${status.message}`:
          `Aucune progression depuis ${Math.round(age/60_000)} minute(s) à l'étape « ${status.message} »`,
      );
    }finally{this.restarting=false;}
  }

  status() {
    return { ...this.coordinator.getReferenceStatus(), agentType: 'CARD_REFERENCE' as const };
  }

  start(actor: Actor, companyId?: string) {
    return {
      ...this.coordinator.triggerCardReference(actor, companyId),
      agentType: 'CARD_REFERENCE' as const,
      lockedCompanyId: companyId ?? null,
    };
  }

  async startSelected(actor: Actor, companyId: string) {
    const [company]=await this.db.query<{code:string}>(
      `SELECT code FROM company WHERE id=$1 AND active LIMIT 1`,[companyId],
    );
    if(!company)throw new Error('La société sélectionnée est introuvable ou inactive');
    this.currentRequest={actor,companyId};
    return {
      ...this.coordinator.triggerCardReference(actor,companyId),
      agentType:'CARD_REFERENCE' as const,
      lockedCompanyId:companyId,
      lockedCompanyCode:company.code,
    };
  }
}
