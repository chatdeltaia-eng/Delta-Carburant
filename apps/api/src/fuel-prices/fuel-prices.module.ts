import { Module } from '@nestjs/common'; import { FuelPricesController } from './fuel-prices.controller'; import { FuelPricesService } from './fuel-prices.service';
@Module({controllers:[FuelPricesController],providers:[FuelPricesService]}) export class FuelPricesModule{}
