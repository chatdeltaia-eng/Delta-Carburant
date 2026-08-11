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

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('SUPER_ADMIN', 'DIRECTION_GENERAL')
@Controller('total-mobility')
export class TotalMobilityController {
  constructor(private readonly total: TotalMobilityService) {}
  @Get('status') status() {
    return this.total.status();
  }
  @Get('runs') runs() {
    return this.total.runs();
  }
  @Post('connect') connect(
    @Body() dto: ConfigureTotalMobilityDto,
    @Req() req: { user: { sub: string; email: string } },
  ) {
    return this.total.connect(dto, req.user);
  }
  @Patch('enabled') toggle(
    @Body() dto: ToggleDto,
    @Req() req: { user: { email: string } },
  ) {
    return this.total.toggle(dto.enabled, req.user.email);
  }
  @Post('sync') sync(@Req() req: { user: { sub: string; email: string } }) {
    return this.total.syncNow(req.user);
  }
}
