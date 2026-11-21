import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import { HealthModule } from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
import { MAX_COIN_AMOUNT } from '@ex-mio/contracts';
import { BalanceController } from './balance.controller';
import { CoinsController } from './coins.controller';
import { SERVICE_TOKENS } from './service-token.guard';
import { LedgerError } from '../services/ledger.errors';
import { BalanceService } from '../services/balance.service';
import { LedgerService } from '../services/ledger.service';

// Choke point: the HTTP layer (zod parse, service identity guard, error mapping) with mocked services.
// Spec: docs/specs/payments.md, sections 3 and 5.

const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const P = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const R = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2d';
const S = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2e';

const service = {
  'x-tenant-id': T,
  'x-principal-id': 'engagement',
  'x-service-id': 'engagement',
  'x-service-token': 'engagement-secret',
  'idempotency-key': 'key-12345678',
};

const COMMANDS = ['credit', 'reserve', 'capture', 'release', 'refund'] as const;
const body = {
  credit: { player_id: P, spin_id: S, amount: 5 },
  reserve: { player_id: P, reserve_id: R, amount: 5 },
  capture: { reserve_id: R },
  release: { reserve_id: R },
  refund: { reserve_id: R },
};

describe('payments HTTP layer', () => {
  let app: NestFastifyApplication;
  const ledger = Object.fromEntries(COMMANDS.map((c) => [c, jest.fn()])) as Record<
    (typeof COMMANDS)[number],
    jest.Mock
  >;
  const balances = { readByPlayer: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [TenancyModule.forRoot(), HealthModule.register({ useFactory: () => ({}) })],
      controllers: [CoinsController, BalanceController],
      providers: [
        { provide: LedgerService, useValue: ledger },
        { provide: BalanceService, useValue: balances },
        { provide: SERVICE_TOKENS, useValue: { engagement: 'engagement-secret' } },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    for (const fn of Object.values(ledger))
      fn.mockResolvedValue({ status: 201, body: {}, replayed: false });
  });

  const send = (cmd: string, payload: unknown, headers: Record<string, string> = service) =>
    app.inject({
      method: 'POST',
      url: `/internal/v1/coins/${cmd}`,
      headers,
      payload: payload as never,
    });
  const none = () => COMMANDS.every((c) => ledger[c].mock.calls.length === 0);

  describe('INV-X1 only the engagement service can move coins', () => {
    // Mutation: drop the ServiceTokenGuard from CoinsController, or register a public credit route.
    it.each(COMMANDS)('%s without a service token is 403 and reaches no service', async (cmd) => {
      const { 'x-service-token': _t, ...noToken } = service;
      expect((await send(cmd, body[cmd], noToken)).statusCode).toBe(403);
      expect(none()).toBe(true);
    });

    it.each(COMMANDS)('%s with a wrong token or another service id is 403', async (cmd) => {
      expect(
        (await send(cmd, body[cmd], { ...service, 'x-service-token': 'guess' })).statusCode,
      ).toBe(403);
      expect(
        (await send(cmd, body[cmd], { ...service, 'x-service-id': 'identity' })).statusCode,
      ).toBe(403);
      expect(none()).toBe(true);
    });

    it.each(['player', 'operator'])(
      'a %s principal cannot call credit, even with a service header',
      async (kind) => {
        const res = await send('credit', body.credit, {
          ...service,
          'x-service-id': '',
          'x-service-token': '',
          'x-principal-kind': kind,
        });
        expect(res.statusCode).toBe(403);
        expect(none()).toBe(true);
      },
    );

    // Mutation: re-add the foundation's POST /v1/credits.
    it('no public route can credit: /v1/credits and /v1/coins/* do not exist', async () => {
      for (const url of ['/v1/credits', '/v1/coins/credit', '/v1/coins/reserve']) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: service,
          payload: body.credit as never,
        });
        expect(res.statusCode).toBe(404);
      }
    });

    it('the command routes are exactly credit, reserve, capture, release, refund', () => {
      const routes = app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false });
      for (const c of COMMANDS) expect(routes).toContain(c);
      expect(routes).not.toMatch(/adjust|mint|set-balance|balance\s*\(POST\)/);
    });
  });

  describe('INV-X2 input is validated before any service runs', () => {
    // Mutation: pass `body` to the service without parseInput.
    it.each([0, -1, 1.5, '10', MAX_COIN_AMOUNT + 1])(
      'a coin amount of %p is 400 validation_failed',
      async (amount) => {
        for (const cmd of ['credit', 'reserve'] as const) {
          const res = await send(cmd, { ...body[cmd], amount });
          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({ code: 'validation_failed' });
        }
        expect(none()).toBe(true);
      },
    );

    it('another currency is 400', async () => {
      expect((await send('reserve', { ...body.reserve, currency: 'EUR' })).statusCode).toBe(400);
      expect(none()).toBe(true);
    });

    // Mutation: use .passthrough() on ReserveRefRequest.
    it.each(['capture', 'release', 'refund'] as const)(
      "%s with an amount field is 400: the amount is the reserve's own",
      async (cmd) => {
        expect((await send(cmd, { ...body[cmd], amount: 5 })).statusCode).toBe(400);
        expect(none()).toBe(true);
      },
    );

    it.each(COMMANDS)(
      '%s without an Idempotency-Key is 400 idempotency_key_required',
      async (cmd) => {
        const { 'idempotency-key': _k, ...noKey } = service;
        const res = await send(cmd, body[cmd], noKey);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
        expect(none()).toBe(true);
      },
    );

    it('a request without a tenant is refused', async () => {
      const { 'x-tenant-id': _t, ...noTenant } = service;
      expect((await send('credit', body.credit, noTenant)).statusCode).toBe(401);
      expect(none()).toBe(true);
    });
  });

  describe('INV-X3 every failure has a defined status and error code', () => {
    // Mutation: let LedgerError or the idempotency errors fall through as 500.
    it.each([
      [new LedgerError('insufficient_funds'), 409, 'insufficient_funds'],
      [new LedgerError('invalid_reserve_transition'), 409, 'invalid_reserve_transition'],
      [new LedgerError('reserve_not_found'), 404, 'reserve_not_found'],
      [new LedgerError('operation_conflict'), 409, 'operation_conflict'],
      [new IdempotencyInFlightError(), 409, 'idempotency_in_progress'],
      [new IdempotencyMismatchError(), 422, 'idempotency_key_reused'],
    ])('%p -> %i %s', async (error, status, code) => {
      ledger.reserve.mockRejectedValueOnce(error);
      const res = await send('reserve', body.reserve);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code });
    });

    it('an unexpected error is 500 and carries no stored success', async () => {
      ledger.reserve.mockRejectedValueOnce(new Error('boom'));
      expect((await send('reserve', body.reserve)).statusCode).toBe(500);
    });

    it('a replay is flagged and keeps the stored status', async () => {
      ledger.credit.mockResolvedValueOnce({
        status: 201,
        body: { transaction_id: R },
        replayed: true,
      });
      const res = await send('credit', body.credit);
      expect(res.statusCode).toBe(201);
      expect(res.headers['idempotent-replayed']).toBe('true');
    });
  });

  describe('INV-B4 a player reads only their own balance', () => {
    // Mutation: read the player id from a query/param on /v1/me/balance instead of the principal.
    it('/v1/me/balance uses the principal and ignores a player id in the query', async () => {
      balances.readByPlayer.mockResolvedValue({
        wallet_id: R,
        available: 1,
        held: 0,
        currency: 'COIN',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/me/balance?player_id=${S}`,
        headers: { 'x-tenant-id': T, 'x-principal-id': P, 'x-principal-kind': 'player' },
      });
      expect(res.statusCode).toBe(200);
      expect(balances.readByPlayer).toHaveBeenCalledWith(P);
    });

    // Mutation: drop the operator check from /v1/players/:player_id/balance.
    it('/v1/players/:id/balance is for operators only', async () => {
      balances.readByPlayer.mockClear();
      const url = `/v1/players/${S}/balance`;
      const asPlayer = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-tenant-id': T, 'x-principal-id': P, 'x-principal-kind': 'player' },
      });
      expect(asPlayer.statusCode).toBe(403);
      expect(balances.readByPlayer).not.toHaveBeenCalled();
      balances.readByPlayer.mockResolvedValue({
        wallet_id: R,
        available: 1,
        held: 0,
        currency: 'COIN',
      });
      const asOperator = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-tenant-id': T, 'x-principal-id': 'op-1', 'x-principal-kind': 'operator' },
      });
      expect(asOperator.statusCode).toBe(200);
      expect(balances.readByPlayer).toHaveBeenCalledWith(S);
    });

    it('a missing wallet is 404 wallet_not_found', async () => {
      balances.readByPlayer.mockRejectedValueOnce(new LedgerError('wallet_not_found'));
      const res = await app.inject({
        method: 'GET',
        url: `/v1/players/${S}/balance`,
        headers: { 'x-tenant-id': T, 'x-principal-id': 'op-1', 'x-principal-kind': 'operator' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'wallet_not_found' });
    });
  });
});
