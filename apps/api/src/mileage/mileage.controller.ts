import { Body,Controller,Get,Param,ParseUUIDPipe,Patch,Post,Req,UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsIn,IsNumber,IsOptional,IsString,IsUUID,Min } from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { MileageService } from './mileage.service';
class MileageDto { @IsUUID() vehicleId!:string; @IsNumber() @Min(0) mileage!:number; @IsOptional() @IsString() note?:string; }
class MileageDecisionDto { @IsIn(['VALIDATED','REJECTED']) decision!:'VALIDATED'|'REJECTED'; @IsOptional() @IsString() reason?:string; }
type Actor={sub:string;email:string;role:string};
@UseGuards(AuthGuard('jwt'),RolesGuard) @Controller('mileage')
export class MileageController {
 constructor(private readonly mileage:MileageService){}
 @Get() @Roles('NAJIB_ASSIGNER','ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN') list(@Req() req:{user:Actor}){return this.mileage.list(req.user);}
 @Post() @Roles('NAJIB_ASSIGNER') create(@Body() dto:MileageDto,@Req() req:{user:Actor}){return this.mileage.create(dto,req.user);}
 @Patch(':id/decision') @Roles('ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN') decide(@Param('id',ParseUUIDPipe) id:string,@Body() dto:MileageDecisionDto,@Req() req:{user:Actor}){return this.mileage.decide(id,dto,req.user);}
}
