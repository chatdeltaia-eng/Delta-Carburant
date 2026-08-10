import { Body,Controller,Delete,Get,Param,ParseUUIDPipe,Patch,Post,Query,Req,UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsBoolean,IsOptional,IsString,IsUUID,MinLength } from 'class-validator';
import { Roles } from '../common/roles'; import { RolesGuard } from '../common/roles.guard'; import { DriversService } from './drivers.service';
class DriverDto{@IsUUID() companyId!:string;@IsString()@MinLength(1) customerNumber!:string;@IsString()@MinLength(2) customerName!:string;@IsString()@MinLength(1) driverNumber!:string;@IsString()@MinLength(2) firstName!:string;@IsString()@MinLength(2) lastName!:string;@IsString()@MinLength(1) driverCode!:string;@IsOptional()@IsBoolean() active?:boolean;}
@UseGuards(AuthGuard('jwt'),RolesGuard) @Controller('drivers') export class DriversController{
 constructor(private readonly service:DriversService){}
 @Get() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') list(@Query('companyId') companyId='',@Req() req:{user:{sub:string;role:string}}){return this.service.list(companyId,req.user);}
 @Post() @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') create(@Body() dto:DriverDto,@Req() req:{user:{sub:string;email:string;role:string;companyId?:string}}){return this.service.create(dto,req.user);}
 @Patch(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER') update(@Param('id',ParseUUIDPipe) id:string,@Body() dto:DriverDto,@Req() req:{user:{sub:string;email:string;role:string;companyId?:string}}){return this.service.update(id,dto,req.user);}
 @Delete(':id') @Roles('SUPER_ADMIN','DIRECTION_GENERAL','NAJIB_ASSIGNER') remove(@Param('id',ParseUUIDPipe) id:string,@Req() req:{user:{sub:string;email:string;role:string;companyId?:string}}){return this.service.remove(id,req.user);}
}
