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
import { DriversModule } from './drivers/drivers.module';
import { FuelPricesModule } from './fuel-prices/fuel-prices.module';
import { TotalMobilityModule } from './total-mobility/total-mobility.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { DocumentsModule } from './documents/documents.module';
import { MailingModule } from './mailing/mailing.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    DashboardModule,
    CardsModule,
    RequestsModule,
    TransactionsModule,
    NotificationsModule,
    VehiclesModule,
    MileageModule,
    DriversModule,
    FuelPricesModule,
    TotalMobilityModule,
    ComplaintsModule,
    DocumentsModule,
    MailingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
