import { Controller, Get, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { NotificationsService } from './notifications.service';
@UseGuards(AuthGuard('jwt')) @Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get() list(@Req() req: { user: { sub: string } }) { return this.notifications.list(req.user.sub); }
  @Patch('read-all') readAll(@Req() req: { user: { sub: string } }) { return this.notifications.readAll(req.user.sub); }
  @Patch('unread-all') unreadAll(@Req() req: { user: { sub: string } }) { return this.notifications.unreadAll(req.user.sub); }
  @Patch(':id/read') read(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { sub: string } }) { return this.notifications.read(id, req.user.sub); }
}
