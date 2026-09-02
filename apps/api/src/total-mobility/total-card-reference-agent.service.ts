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

  constructor(total: TotalMobilityService, db: DatabaseService) {
    this.db = db;
    // Instance volontairement indépendante de l'agent Transactions fourni par
    // Nest. Elle possède son propre Chromium, sa page, ses cookies et son état
    // de société ; son onModuleInit n'est pas appelé, donc aucun worker temps
    // réel ne démarre dans cet agent manuel.
    this.coordinator = new TotalLoginAgentService(total, db);
  }

  onModuleDestroy() {
    this.coordinator.onModuleDestroy();
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
    return {
      ...this.coordinator.triggerCardReference(actor,companyId),
      agentType:'CARD_REFERENCE' as const,
      lockedCompanyId:companyId,
      lockedCompanyCode:company.code,
    };
  }
}
