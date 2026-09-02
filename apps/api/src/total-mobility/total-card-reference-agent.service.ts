import { Injectable } from '@nestjs/common';
import { TotalLoginAgentService } from './total-login-agent.service';

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
export class TotalCardReferenceAgentService {
  constructor(private readonly coordinator: TotalLoginAgentService) {}

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
}
