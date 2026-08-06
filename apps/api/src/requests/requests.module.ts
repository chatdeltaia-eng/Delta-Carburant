import { Module } from '@nestjs/common';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { NotificationsModule } from '../notifications/notifications.module';
@Module({ imports: [NotificationsModule], controllers: [RequestsController], providers: [RequestsService] })
export class RequestsModule {}
