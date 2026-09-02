import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { MailingModule } from '../mailing/mailing.module';

@Module({ imports:[MailingModule], controllers: [AssistantController], providers: [AssistantService] })
export class AssistantModule {}
