import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { VehiclesService } from './vehicles.service';
class VehicleDto { @IsString() @MinLength(2) registration!: string; @IsOptional() @IsString() brand?: string; @IsOptional() @IsString() model?: string; @IsOptional() @IsBoolean() active?: boolean; }
type Actor = { sub: string; email: string; companyId?: string };
@UseGuards(AuthGuard('jwt'), RolesGuard) @Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}
  @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') list() { return this.vehicles.list(); }
  @Post() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') create(@Body() dto: VehicleDto, @Req() req: { user: Actor }) { return this.vehicles.create(dto, req.user); }
  @Patch(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') update(@Param('id',ParseUUIDPipe) id:string,@Body() dto:VehicleDto,@Req() req:{user:Actor}) { return this.vehicles.update(id,dto,req.user); }
  @Delete(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') remove(@Param('id',ParseUUIDPipe) id:string,@Req() req:{user:Actor}) { return this.vehicles.remove(id,req.user); }
}
