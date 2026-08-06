import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { RequestsService } from './requests.service';

class CreateRequestDto {
  @IsIn(['NEW_CARD','LIMIT_CHANGE','CARD_FUNDING']) requestType!: 'NEW_CARD' | 'LIMIT_CHANGE' | 'CARD_FUNDING';
  @IsOptional() @IsUUID() fuelCardId?: string;
  @IsOptional() @IsUUID() sourceCardId?: string;
  @IsString() @MinLength(2) beneficiary!: string;
  @IsString() @MinLength(2) department!: string;
  @IsString() @MinLength(2) vehicle!: string;
  @IsNumber() @Min(0) requestedLimit!: number;
  @IsString() @MinLength(3) reason!: string;
}
class DecisionDto {
  @IsIn(['APPROVED','REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() @MinLength(3) cardNumber?: string;
}

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}
  @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER')
  list(@Req() req: { user: { sub: string; role: string } }) { return this.requests.list(req.user); }
  @Post() @Roles('NAJIB_ASSIGNER')
  create(@Body() dto: CreateRequestDto, @Req() req: { user: { sub: string; email: string; companyId?: string } }) { return this.requests.create(dto, req.user); }
  @Patch(':id/cancel') @Roles('NAJIB_ASSIGNER')
  cancel(@Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { sub: string; email: string } }) { return this.requests.cancel(id, req.user); }
  @Patch(':id/decision') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto,
    @Req() req: { user: { sub: string; email: string } }) { return this.requests.decide(id, dto, req.user); }
}
