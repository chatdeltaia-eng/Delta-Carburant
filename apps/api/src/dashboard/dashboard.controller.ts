import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DashboardService } from './dashboard.service';

@UseGuards(AuthGuard('jwt'))
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get('summary') summary(@Req() req: { user: { sub: string; role: string } }) { return this.dashboard.summary(req.user); }
  @Get('direction') direction() { return this.dashboard.direction(); }
}
