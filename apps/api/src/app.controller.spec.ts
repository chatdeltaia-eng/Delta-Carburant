import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';

describe('AppController', () => {
  let appController: AppController;
  const database = { query: jest.fn() };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: DatabaseService, useValue: database }],
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
