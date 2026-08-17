import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { MailingService } from './mailing.service';

type AuthenticatedRequest = Request & {
  user?: { sub?: string; email?: string; role?: string };
};

@Injectable()
export class OperationMailInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OperationMailInterceptor.name);

  constructor(private readonly mailing: MailingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.mustNotify(request)) return next.handle();

    const startedAt = new Date();
    return next.handle().pipe(tap({
      next: (result) => {
        const entityId = this.entityId(result);
        void this.mailing.sendDirectionOperation({
          actorEmail: request.user?.email || request.user?.sub || 'Utilisateur inconnu',
          actorRole: request.user?.role || 'Rôle inconnu',
          method: request.method,
          path: request.originalUrl || request.url,
          entityId,
          occurredAt: startedAt,
        }).catch((error) => this.logger.error(
          `Alerte opération non envoyée : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
        ));
      },
    }));
  }

  private mustNotify(request: AuthenticatedRequest) {
    if (!request.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
    const path = request.originalUrl || request.url;
    return !path.includes('/auth/')
      && !path.includes('/notifications/')
      && !path.includes('/mailing/');
  }

  private entityId(result: unknown) {
    if (!result || typeof result !== 'object') return undefined;
    const value = result as Record<string, unknown>;
    const id = value.id ?? value.requestId ?? value.cardId ?? value.batchId;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  }
}
