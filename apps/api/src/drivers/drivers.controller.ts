import { Body,Controller,Delete,Get,Param,ParseUUIDPipe,Patch,Post,Query,Req,UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsBoolean,IsOptional,IsString,IsUUID,MinLength } from 'class-validator';
import { Roles } from '../common/roles'; import { RolesGuard } from '../common/roles.guard'; import { DriversService } from './drivers.service';
class DriverDto{@IsUUID() companyId!:string;@IsString()@MinLength(2) fullName!:string;@IsOptional()@IsString() cin?:string;@IsOptional()@IsString() phone?:string;@IsOptional()@IsString() licenseNumber?:string;@IsOptional()@IsBoolean() active?:boolean;}
@UseGuards(AuthGuard('jwt'),RolesGuard) @Controller('drivers') export class DriversController{
 constructor(private readonly service:DriversService){}
 @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') list(@Query('companyId') companyId='',@Req() req:{user:{sub:string;role:string}}){return this.service.list(companyId,req.user);}
 @Post() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') create(@Body() dto:DriverDto,@Req() req:{user:{sub:string;email:string}}){return this.service.create(dto,req.user);}
 @Patch(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE') update(@Param('id',ParseUUIDPipe) id:string,@Body() dto:DriverDto,@Req() req:{user:{sub:string;email:string}}){return this.service.update(id,dto,req.user);}
 @Delete(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL') remove(@Param('id',ParseUUIDPipe) id:string,@Req() req:{user:{sub:string;email:string}}){return this.service.remove(id,req.user);}
}
