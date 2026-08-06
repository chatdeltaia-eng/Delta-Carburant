import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { CardsService } from './cards.service';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';

const statuses = ['DRAFT','REQUESTED','ORDERED','RECEIVED','TO_ASSIGN','ASSIGNED','ACTIVE','SUSPENDED','OPPOSED','LOST','STOLEN','DAMAGED','EXPIRED','REPLACED','CANCELLED','RETURNED','SAFE'];
class UpdateCardDto {
  @IsOptional() @IsIn(statuses) status?: string;
  @IsOptional() @IsNumber() @Min(0) monthlyLimit?: number;
  @IsOptional() @IsBoolean() thresholdAlertEnabled?: boolean;
}
class CreateCardDto {
  @IsString() cardNumber!: string;
  @IsNumber() @Min(0) monthlyLimit!: number;
  @IsOptional() @IsUUID() beneficiaryId?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsIn(['PERSONALIZED','OFF_PARK']) cardCategory?: 'PERSONALIZED'|'OFF_PARK';
}
class ReplaceCardDto { @IsUUID() replacementCardId!: string; @IsString() reason!: string; }

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}
  @Get() list(@Query('page') page='1', @Query('search') search='', @Query('status') status='',
    @Req() req: { user: { sub: string; role: string } }) {
    return this.cards.list(Math.max(1, Number(page) || 1), search, status, req.user);
  }
  @Post() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  create(@Body() dto: CreateCardDto, @Req() req: { user: { sub: string; email: string } }) {
    return this.cards.create(dto, req.user.sub, req.user.email);
  }
  @Patch(':id')
  @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCardDto,
    @Req() req: { user: { sub: string; email: string } }) {
    return this.cards.update(id, dto, req.user.email);
  }
  @Get(':id') details(@Param('id', ParseUUIDPipe) id: string) { return this.cards.details(id); }
  @Post(':id/replace') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceCardDto,
    @Req() req: { user: { sub: string; email: string } }) {
    return this.cards.replace(id,dto.replacementCardId,dto.reason,req.user.sub,req.user.email);
  }
  @Delete(':id')
  @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { sub: string; email: string } }) {
    return this.cards.remove(id, req.user.sub, req.user.email);
  }
}
