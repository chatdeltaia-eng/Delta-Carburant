import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { TotalMobilityService } from './total-mobility.service';
import { TotalLoginAgentService } from './total-login-agent.service';

class ConfigureTotalMobilityDto {
  @IsString() @MinLength(10) customerId!: string;
  @IsString() @MinLength(1) customerNumber!: string;
  @IsString() @MinLength(1) siteNumber!: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() username?: string;
  @IsString() @MinLength(20) refreshToken!: string;
  @IsOptional() @IsInt() @Min(15) @Max(1440) syncIntervalMinutes?: number;
}
class ToggleDto {
  @IsBoolean() enabled!: boolean;
}
class SyncTotalMobilityDto {
  @IsOptional() @IsDateString() fromDate?: string;
}
class ReconnectTotalMobilityDto {
  @IsString() @MinLength(20) refreshToken!: string;
}
class SyncTotalMobilitySessionDto {
  @IsString() @MinLength(20) accessToken!: string;
  @IsOptional() @IsDateString() fromDate?: string;
}
class TotalVerificationCodeDto {
  @IsString() @MinLength(4) code!: string;
}

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('SUPER_ADMIN', 'DIRECTION_GENERAL')
@Controller('total-mobility')
export class TotalMobilityController {
  constructor(
    private readonly total: TotalMobilityService,
    private readonly agent: TotalLoginAgentService,
  ) {}
  @Get('agent/status') agentStatus() {
    return this.agent.getStatus();
  }
  @Post('agent/start') startAgent(
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.agent.start(req.user);
  }
  @Post('agent/code') submitAgentCode(@Body() dto: TotalVerificationCodeDto) {
    return this.agent.submitCode(dto.code);
  }
  @Get('status') status() {
    return this.total.status();
  }
  @Get('runs') runs() {
    return this.total.runs();
  }
  @Get('cards/reconciliation') cardReconciliation() {
    return this.total.cardReconciliation();
  }
  @Post('connect') connect(
    @Body() dto: ConfigureTotalMobilityDto,
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.total.connect(dto, req.user);
  }
  @Post('reconnect') reconnect(
    @Body() dto: ReconnectTotalMobilityDto,
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.total.reconnect(dto.refreshToken, req.user);
  }
  @Patch('enabled') toggle(
    @Body() dto: ToggleDto,
    @Req() req: { user: { email: string } },
  ) {
    return this.total.toggle(dto.enabled, req.user.email);
  }
  @Post('sync') sync(
    @Body() dto: SyncTotalMobilityDto,
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.total.syncNow(req.user, dto.fromDate);
  }
  @Post('sync-session') syncSession(
    @Body() dto: SyncTotalMobilitySessionDto,
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.total.syncWithAccessToken(
      req.user,
      dto.accessToken,
      dto.fromDate,
    );
  }
}
