import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { TransactionsService } from './transactions.service';
class CorrectTransactionDto {
  @IsOptional() @IsString() station?: string;
  @IsOptional() @IsNumber() @Min(0.001) liters?: number;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsString() reason!: string;
}
class AllocateTransactionDto {
  @IsUUID() driverId!: string;
  @IsUUID() vehicleId!: string;
  @IsNumber() @Min(0.001) amount!: number;
  @IsNumber() @Min(0) mileage!: number;
  @IsOptional() @IsNumber() @Min(0.001) liters?: number;
  @IsOptional() @IsString() note?: string;
}
class ImportRowDto {
  @IsDateString() date!: string;
  @IsString() cardNumber!: string;
  @IsOptional() @IsString() vehicle?: string;
  @IsOptional() @IsString() beneficiary?: string;
  @IsString() @MinLength(1) station!: string;
  @IsString() @MinLength(1) product!: string;
  @IsNumber() @Min(0.001) liters!: number;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsNumber() @Min(0) previousMileage?: number;
  @IsOptional() @IsNumber() @Min(0) mileage?: number;
  @IsOptional() @IsString() authorizationCode?: string;
}
class ImportTransactionsDto {
  @IsString() filename!: string;
  @IsArray() @ValidateNested({each:true}) @Type(() => ImportRowDto) rows!: ImportRowDto[];
}
class ReviewDecisionDto {
  @IsIn(['ACCEPTED','REJECTED']) decision!: 'ACCEPTED'|'REJECTED';
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsUUID() fuelCardId?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsString() newVehicleRegistration?: string;
  @IsOptional() @IsString() newVehicleType?: string;
  @IsOptional() @IsUUID() newVehicleCompanyId?: string;
  @IsOptional() @IsString() beneficiaryName?: string;
}
class AllocationDecisionDto { @IsIn(['APPROVED','REJECTED']) decision!:'APPROVED'|'REJECTED'; @IsOptional() @IsString() reason?:string; }
class ObservationDto { @IsString() @MinLength(3) observation!:string; }
class RevertBatchDto { @IsString() @MinLength(5) reason!:string; }

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}
  @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') list(@Req() req: { user: { sub: string; role: string } }) { return this.transactions.list(req.user); }
  @Post('import') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') import(@Body() dto: ImportTransactionsDto, @Req() req: { user: { sub:string; email:string } }) { return this.transactions.import(dto,req.user); }
  @Get('reviews') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') reviews() { return this.transactions.reviews(); }
  @Get('imports') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') imports() { return this.transactions.imports(); }
  @Patch('imports/:id/revert') @Roles('SUPER_ADMIN','DIRECTION_GENERAL') revertImport(@Param('id',ParseUUIDPipe) id:string,@Body() dto:RevertBatchDto,@Req() req:{user:{sub:string;email:string}}){return this.transactions.revertImport(id,dto.reason,req.user);}
  @Patch('reviews/:id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') review(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReviewDecisionDto,@Req() req:{user:{sub:string;email:string}}) { return this.transactions.review(id,dto,req.user); }
  @Patch('allocations/:id/decision') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') decideAllocation(@Param('id',ParseUUIDPipe) id:string,@Body() dto:AllocationDecisionDto,@Req() req:{user:{sub:string;email:string}}){return this.transactions.decideAllocation(id,dto,req.user);}
  @Post(':id/allocations') @Roles('NAJIB_ASSIGNER') allocate(@Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AllocateTransactionDto, @Req() req: { user: { sub: string; email: string } }) {
    return this.transactions.allocate(id,dto,req.user);
  }
  @Post(':id/observations') @Roles('NAJIB_ASSIGNER','ZIN_FINANCE') observe(@Param('id',ParseUUIDPipe) id:string,
    @Body() dto:ObservationDto,@Req() req:{user:{sub:string;email:string;role:string}}){return this.transactions.observe(id,dto.observation,req.user);}
  @Patch(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') correct(@Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectTransactionDto, @Req() req: { user: { sub: string; email: string } }) { return this.transactions.correct(id,dto,req.user); }
  @Delete('batch/all') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') removeAll(@Req() req: { user: { sub: string; email: string } }) { return this.transactions.removeAll(req.user); }
  @Delete(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { sub: string; email: string } }) { return this.transactions.remove(id, req.user); }
}
