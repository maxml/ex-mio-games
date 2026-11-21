import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import { HealthModule } from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
import { CreditsController } from './controllers/credits.controller';
import { CreditsService } from './services/credits.service';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const PLAYER = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const headers = {
  'x-tenant-id': TENANT,
  'x-principal-id': 'op-1',
  'idempotency-key': 'key-12345678',
};

describe('payments HTTP layer', () => {
  let app: NestFastifyApplication;
  const credit = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [TenancyModule.forRoot(), HealthModule.register({ useFactory: () => ({}) })],
      controllers: [CreditsController],
      providers: [{ provide: CreditsService, useValue: { credit, list: jest.fn() } }],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const post = (payload: unknown, h: Record<string, string> = headers) =>
    app.inject({ method: 'POST', url: '/v1/credits', headers: h, payload: payload as never });

  it('refuses a request without a tenant', async () => {
    const { 'x-tenant-id': _t, ...noTenant } = headers;
    expect((await post({ player_id: PLAYER, amount: 5 }, noTenant)).statusCode).toBe(401);
    expect(credit).not.toHaveBeenCalled();
  });

  it('validates the body and the idempotency key before the service', async () => {
    expect((await post({ player_id: 'x', amount: -1 })).statusCode).toBe(400);
    const { 'idempotency-key': _k, ...noKey } = headers;
    expect((await post({ player_id: PLAYER, amount: 5 }, noKey)).statusCode).toBe(400);
    expect(credit).not.toHaveBeenCalled();
  });

  it('answers 201 for a new credit and flags a replay', async () => {
    const body = { id: PLAYER, player_id: PLAYER, amount: 5, created_at: new Date().toISOString() };
    credit.mockResolvedValueOnce({ status: 201, body, replayed: false });
    credit.mockResolvedValueOnce({ status: 201, body, replayed: true });
    const first = await post({ player_id: PLAYER, amount: 5 });
    const second = await post({ player_id: PLAYER, amount: 5 });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('maps in-flight to 409 and a changed body to 422', async () => {
    credit.mockRejectedValueOnce(new IdempotencyInFlightError());
    expect((await post({ player_id: PLAYER, amount: 5 })).statusCode).toBe(409);
    credit.mockRejectedValueOnce(new IdempotencyMismatchError());
    expect((await post({ player_id: PLAYER, amount: 6 })).statusCode).toBe(422);
  });
});
