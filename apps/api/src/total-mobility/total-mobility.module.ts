import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { TotalMobilityController } from './total-mobility.controller';
import { TotalMobilityService } from './total-mobility.service';
import { TotalLoginAgentService } from './total-login-agent.service';
import { TotalCardReferenceAgentService } from './total-card-reference-agent.service';

@Module({
  imports: [TransactionsModule],
  controllers: [TotalMobilityController],
  providers: [TotalMobilityService, TotalLoginAgentService, TotalCardReferenceAgentService],
  exports: [TotalLoginAgentService],
})
export class TotalMobilityModule {}
