import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { DashboardService } from './dashboard.service';

@UseGuards(AuthGuard('jwt'),RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get('summary') summary(@Req() req: { user: { sub: string; role: string } }) { return this.dashboard.summary(req.user); }
  @Get('direction') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') direction() { return this.dashboard.direction(); }
}
