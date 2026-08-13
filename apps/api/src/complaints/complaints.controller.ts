import { Body,Controller,Get,Param,ParseUUIDPipe,Patch,Post,Req,UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsIn,IsOptional,IsString,MinLength } from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { ComplaintsService } from './complaints.service';
class CreateComplaintDto {@IsString() @MinLength(3) subject!:string;@IsString() @MinLength(5) description!:string;@IsIn(['NORMAL','HIGH','URGENT']) priority!:'NORMAL'|'HIGH'|'URGENT';@IsIn(['NAJIB_ASSIGNER','ZIN_FINANCE','DIRECTION_GENERAL']) targetRole!:string;}
class MessageDto {@IsString() @MinLength(2) message!:string;}
class StatusDto {@IsIn(['OPEN','IN_PROGRESS','RESOLVED','CLOSED']) status!:string;@IsOptional() @IsString() resolution?:string;}
type Actor={sub:string;email:string;role:string};
@UseGuards(AuthGuard('jwt'),RolesGuard) @Controller('complaints')
export class ComplaintsController {
 constructor(private readonly service:ComplaintsService){}
 @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') list(@Req() req:{user:Actor}){return this.service.list(req.user);}
 @Post() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') create(@Body() dto:CreateComplaintDto,@Req() req:{user:Actor}){return this.service.create(dto,req.user);}
 @Post(':id/messages') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') message(@Param('id',ParseUUIDPipe) id:string,@Body() dto:MessageDto,@Req() req:{user:Actor}){return this.service.message(id,dto.message,req.user);}
 @Patch(':id/status') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') status(@Param('id',ParseUUIDPipe) id:string,@Body() dto:StatusDto,@Req() req:{user:Actor}){return this.service.status(id,dto,req.user);}
}
