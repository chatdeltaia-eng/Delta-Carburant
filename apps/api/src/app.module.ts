import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CardsModule } from './cards/cards.module';
import { RequestsModule } from './requests/requests.module';
import { TransactionsModule } from './transactions/transactions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { MileageModule } from './mileage/mileage.module';

@Module({
  imports: [DatabaseModule, AuthModule, DashboardModule, CardsModule, RequestsModule, TransactionsModule, NotificationsModule, VehiclesModule, MileageModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
