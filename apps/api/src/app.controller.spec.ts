import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import { TotalLoginAgentService } from './total-mobility/total-login-agent.service';

describe('AppController', () => {
  let appController: AppController;
  const database = { query: jest.fn() };
  const totalAgent = { getStatus: jest.fn(() => ({ state:'SIGNING_IN',message:'Connexion automatique à Total Mobility…',updatedAt:'2026-08-31T10:14:03.000Z' })) };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: DatabaseService, useValue: database },
        { provide: TotalLoginAgentService, useValue: totalAgent }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should identify the API', () => {
      expect(appController.getHello()).toBe('DeltaCarburant API');
    });
  });

  describe('health', () => {
    it('reports readiness when PostgreSQL is reachable', async () => {
      database.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(appController.getHealth()).resolves.toEqual({
        status: 'ready',
        database: 'connected',
        version: process.env.RENDER_GIT_COMMIT?.slice(0,7) ?? 'local',
        totalAgent: totalAgent.getStatus(),
      });
    });

    it('reports unavailability when PostgreSQL cannot be reached', async () => {
      database.query.mockRejectedValueOnce(new Error('offline'));

      await expect(appController.getHealth()).rejects.toThrow(
        'Database unavailable',
      );
    });
  });
});
