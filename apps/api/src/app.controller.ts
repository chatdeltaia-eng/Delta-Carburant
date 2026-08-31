import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { TotalLoginAgentService } from './total-mobility/total-login-agent.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly database: DatabaseService,
    private readonly totalAgent: TotalLoginAgentService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth(): Promise<{ status: 'ready'; database: 'connected'; version: string; totalAgent: {state:string;message:string;updatedAt:string} }> {
    try {
      await this.database.query('SELECT 1');
      const agent=this.totalAgent.getStatus();
      return { status: 'ready', database: 'connected', version: process.env.RENDER_GIT_COMMIT?.slice(0,7) ?? 'local',
        totalAgent:{state:agent.state,message:agent.message,updatedAt:agent.updatedAt} };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
