import { Controller,Get,Param,ParseUUIDPipe,Patch,Query,Req,UseGuards } from '@nestjs/common';import { AuthGuard } from '@nestjs/passport';import { IsIn,IsOptional,IsString } from 'class-validator';import { Roles } from '../common/roles';import { RolesGuard } from '../common/roles.guard';import { DocumentsService } from './documents.service';
class StatementQuery {@IsIn(['WEEK','MONTH']) period!:'WEEK'|'MONTH';@IsOptional() @IsString() start?:string;}
type Actor={sub:string;email:string;role:string};
@UseGuards(AuthGuard('jwt'),RolesGuard) @Controller('documents') export class DocumentsController {constructor(private readonly service:DocumentsService){}
 @Get('statement') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') statement(@Query() query:StatementQuery,@Req() req:{user:Actor}){return this.service.statement(query.period,query.start,req.user);}
 @Get('receipts') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') receipts(@Req() req:{user:Actor}){return this.service.receipts(req.user);}
 @Patch('receipts/:id/approve') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') approve(@Param('id',ParseUUIDPipe) id:string,@Req() req:{user:Actor}){return this.service.approve(id,req.user);}
}
