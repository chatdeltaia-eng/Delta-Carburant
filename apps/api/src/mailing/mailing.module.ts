import { Module } from '@nestjs/common';
import { MailingController } from './mailing.controller';
import { MailingService } from './mailing.service';
import { CardFollowupService } from './card-followup.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OperationMailInterceptor } from './operation-mail.interceptor';
import { AnomalyMailService } from './anomaly-mail.service';
@Module({
  controllers:[MailingController],
  providers:[MailingService,CardFollowupService,AnomalyMailService,{provide:APP_INTERCEPTOR,useClass:OperationMailInterceptor}],
  exports:[MailingService],
})
export class MailingModule {}
