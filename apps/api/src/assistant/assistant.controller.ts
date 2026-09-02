import { Body, Controller, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { AssistantService } from './assistant.service';

class AssistantQuestionDto {
  @IsString() @MinLength(2) @MaxLength(2000) question!: string;
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @IsArray() history?: { role: 'user'|'assistant'; text: string }[];
}

class AssistantEmailDto extends AssistantQuestionDto {}

@UseGuards(AuthGuard('jwt'),RolesGuard)
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant:AssistantService) {}

  @Post('ask')
  @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER')
  async ask(@Body() dto:AssistantQuestionDto,@Req() req:{user:{sub:string;role:string;email:string}}) {
    if(!process.env.OPENAI_API_KEY) throw new ServiceUnavailableException('Assistant IA non configuré');
    return this.assistant.ask(dto,req.user);
  }


  @Post('send-email')
  @Roles('SUPER_ADMIN','DIRECTION_GENERAL','ZIN_FINANCE','NAJIB_ASSIGNER')
  async sendEmail(@Body() dto:AssistantEmailDto,@Req() req:{user:{sub:string;role:string;email:string}}) {
    if(!process.env.OPENAI_API_KEY) throw new ServiceUnavailableException('Assistant IA non configuré');
    return this.assistant.sendConsumptionEmail(dto,req.user);
  }
}
