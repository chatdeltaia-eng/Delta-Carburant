import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { CardFollowupService } from './card-followup.service';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE')
@Controller('management-mail')
export class MailingController {
  constructor(private readonly followup: CardFollowupService) {}
  @Get('preview') preview() { return this.followup.summary(); }
  @Post('send') send() { return this.followup.sendDirectionReport(); }
}
