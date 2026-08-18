import { Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { DashboardService } from './dashboard.service';

@UseGuards(AuthGuard('jwt'),RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get('summary') summary(@Query('companyId') companyId='',@Req() req: { user: { sub: string; role: string } }) { return this.dashboard.summary(req.user,companyId); }
  @Get('history') history(@Query('month') month:string,@Query('companyId') companyId='',@Req() req:{user:{sub:string;role:string}}){return this.dashboard.history(month,req.user,companyId);}
  @Get('direction') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') direction() { return this.dashboard.direction(); }
  @Get('anomalies') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') anomalies() { return this.dashboard.anomalies(); }
  @Patch('anomalies/:id/resolve') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
  resolveAnomaly(@Param('id',ParseUUIDPipe) id:string,@Req() req:{user:{sub:string;email:string}}) {
    return this.dashboard.resolveAnomaly(id,req.user);
  }
}
