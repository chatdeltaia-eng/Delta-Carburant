import { BadRequestException } from '@nestjs/common';
import { RequestsService } from './requests.service';

type RequestState = Record<string, unknown>;

describe('RequestsService workflow', () => {
  const notification = { notifyRoles: jest.fn().mockResolvedValue([]) };

  beforeEach(() => jest.clearAllMocks());

  it('exige un motif pour tout refus', async () => {
    const service = new RequestsService({} as never, notification as never);
    await expect(
      service.decide(
        'request-id',
        { decision: 'REJECTED' },
        { sub: 'dg-id', role: 'DIRECTION_GENERAL' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige les deux validations avant une alimentation de carte', async () => {
    const state: RequestState = {
      id: 'request-id',
      request_number: 'D-2026-1234567',
      request_type: 'REACTIVATION',
      status: 'SUBMITTED',
      requested_by: 'najib-id',
      beneficiary_id: 'beneficiary-id',
      vehicle_id: 'vehicle-id',
      fuel_card_id: 'target-card-id',
      source_card_id: 'source-card-id',
      requested_limit: 900,
      zin_approved_at: null,
      dg_approved_at: null,
      company_id: 'company-id',
    };
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT cr.*,b.company_id')) return { rows: [state] };
        if (sql.includes('SET zin_approved_by')) {
          state.zin_approved_at = new Date();
          state.status = 'UNDER_REVIEW';
          return { rows: [] };
        }
        if (sql.includes('SET dg_approved_by')) {
          state.dg_approved_at = new Date();
          state.status = 'UNDER_REVIEW';
          return { rows: [] };
        }
        if (
          sql.includes("UPDATE fuel_card SET monthly_limit=$2,status='DISTRIBUTED'")
        ) {
          return { rows: [{ masked_card_number: '****3506' }] };
        }
        if (sql.includes('UPDATE card_request SET status=$2::request_status')) {
          state.status = 'APPROVED';
          return {
            rows: [
              {
                id: state.id,
                status: state.status,
                fuelCardId: state.fuel_card_id,
                receiptNumber: 'RC-2026-1234567',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const db = {
      transaction: jest.fn((work: (value: typeof client) => unknown) =>
        work(client),
      ),
    };
    const service = new RequestsService(db as never, notification as never);

    const first = await service.decide(
      'request-id',
      { decision: 'APPROVED' },
      { sub: 'zin-id', email: 'zin@delta.tn', role: 'ZIN_FINANCE' },
    );

    expect(first).toMatchObject({
      status: 'UNDER_REVIEW',
      pendingSecondApproval: true,
    });
    expect(queries.some((sql) => sql.includes('UPDATE fuel_card'))).toBe(false);
    expect(notification.notifyRoles).toHaveBeenCalledWith(
      ['DIRECTION_GENERAL'],
      'Deuxième validation requise',
      expect.any(String),
      'requests',
      'card_request',
      'request-id',
    );

    queries.length = 0;
    const second = await service.decide(
      'request-id',
      { decision: 'APPROVED' },
      { sub: 'dg-id', email: 'dg@delta.tn', role: 'DIRECTION_GENERAL' },
    );

    expect(second).toMatchObject({ status: 'APPROVED' });
    expect(
      queries.some((sql) =>
        sql.includes("UPDATE fuel_card SET monthly_limit=$2,status='DISTRIBUTED'"),
      ),
    ).toBe(true);
    expect(queries.some((sql) => sql.includes("'CARD_FUNDING'"))).toBe(true);
  });

  it('exige les validations personnelles de Zin et de la DG pour une restitution', async () => {
    const state: RequestState = {
      id: 'request-id',
      request_number: 'D-2026-7654321',
      request_type: 'ASSIGNMENT_CHANGE',
      status: 'SUBMITTED',
      requested_by: 'najib-id',
      beneficiary_id: 'beneficiary-id',
      vehicle_id: 'vehicle-id',
      fuel_card_id: 'card-id',
      requested_card_status: 'SAFE',
      zin_approved_by: 'admin-id',
      zin_approved_at: null,
      dg_approved_at: null,
      company_id: 'company-id',
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT cr.*,b.company_id')) return { rows: [state] };
        if (sql.includes('100*coalesce(sum(ft.amount_incl_tax)')) return { rows: [{ masked_card_number: '70000001', monthly_limit: 100, rate: 100 }] };
        if (
          sql.includes('zin_approved_by=$2') &&
          sql.includes('dg_approved_by=$2')
        ) {
          state.zin_approved_at = state.dg_approved_at = new Date();
          return { rows: [] };
        }
        if (sql.includes('UPDATE card_request SET status=$2::request_status')) {
          return { rows: [{ id: 'request-id', status: 'APPROVED' }] };
        }
        return { rows: [] };
      }),
    };
    const db = {
      transaction: jest.fn((work: (value: typeof client) => unknown) =>
        work(client),
      ),
    };
    const service = new RequestsService(db as never, notification as never);

    await expect(
      service.decide(
        'request-id',
        { decision: 'APPROVED' },
        { sub: 'admin-id', email: 'admin@delta.tn', role: 'SUPER_ADMIN' },
      ),
    ).rejects.toThrow('La restitution exige les validations personnelles de Zin et de la DG');
  });

  it('archive une demande traitée sans supprimer son historique', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('UPDATE card_request SET archived_at=now()')) {
          return { rows: [{ id: 'request-id', requestNumber: 'D-2026-1', archivedAt: new Date() }] };
        }
        return { rows: [] };
      }),
    };
    const db = { transaction: jest.fn((work: (value: typeof client) => unknown) => work(client)) };
    const service = new RequestsService(db as never, notification as never);

    await expect(service.archive('request-id', { sub:'zin-id', email:'zin@delta.tn', role:'ZIN_FINANCE' }))
      .resolves.toMatchObject({ id:'request-id', requestNumber:'D-2026-1' });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("'ARCHIVE','card_request'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM card_request'))).toBe(false);
  });
});
