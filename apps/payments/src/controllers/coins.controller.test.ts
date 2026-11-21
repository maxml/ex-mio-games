import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import {
  COIN_COMMANDS,
  COIN_VALUE_ACTIONS,
  HEADER_ACTING_TENANT,
  MAX_COIN_AMOUNT,
  PAYMENTS_ERROR_CODES,
} from '@ex-mio/contracts';
import { LedgerError } from '../services/ledger.errors';
import { WebhookSignatureError } from '../services/providers/payment-provider';
import { buildApp, type BuiltApp } from '../testing/app';

// Choke point: the HTTP layer of the REAL application module (zod parse, service identity guard,
// acting-tenant ban, error mapping, route table) with the services mocked and the database, broker
// and Redis replaced by stubs. Spec: docs/specs/payments.md, sections 3 and 5.

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
const operator = (extra: Record<string, string> = {}) => ({
  'x-tenant-id': T,
  'x-principal-id': 'op-1',
  'x-principal-kind': 'operator',
  ...extra,
});
const player = { 'x-tenant-id': T, 'x-principal-id': P, 'x-principal-kind': 'player' };

const body = {
  reserve: { player_id: P, reserve_id: R, amount: 5 },
  capture: { reserve_id: R },
  release: { reserve_id: R },
  refund: { reserve_id: R },
};
const COMMANDS = COIN_COMMANDS;

describe('payments HTTP layer', () => {
  let built: BuiltApp;
  let app: NestFastifyApplication;
  const ledger = Object.fromEntries(COMMANDS.map((c) => [c, jest.fn()])) as Record<
    (typeof COMMANDS)[number],
    jest.Mock
  >;
  const balances = { readByPlayer: jest.fn(), readByWallet: jest.fn() };
  const billing = {
    listPlans: jest.fn(),
    createAttempt: jest.fn(),
    getAttempt: jest.fn(),
    cancelAttempt: jest.fn(),
    currentSubscription: jest.fn(),
    listInvoices: jest.fn(),
    handleWebhook: jest.fn(),
  };

  beforeAll(async () => {
    built = await buildApp({ ledger, balances, billing });
    app = built.app;
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

  describe('INV-X1 route table: the surface is exactly what the spec lists', () => {
    // Mutation: keep the foundation's CreditsController registered (POST /v1/credits), or add any
    // POST route (adjust, mint, set-balance, a credit under any path). This is the MIO-150-02 test:
    // it fails on the route table of the real module, not on a list of words.
    it('the POST routes are exactly the four coin commands, the attempt create and cancel, and the webhook', () => {
      expect([...built.routes.filter((r) => r.startsWith('POST '))].sort()).toEqual(
        [
          'POST /internal/v1/coins/capture',
          'POST /internal/v1/coins/refund',
          'POST /internal/v1/coins/release',
          'POST /internal/v1/coins/reserve',
          'POST /v1/billing/attempts',
          'POST /v1/billing/attempts/:id/cancel',
          'POST /v1/billing/webhooks',
        ].sort(),
      );
    });

    it('no route of any method can credit, mint, adjust or accept a sandbox flag', () => {
      expect(built.routes.filter((r) => /credit|mint|adjust|set-balance|sandbox/i.test(r))).toEqual(
        [],
      );
    });

    it('/v1/credits and every credit path answer 404', async () => {
      for (const url of ['/v1/credits', '/v1/coins/credit', '/internal/v1/coins/credit']) {
        for (const method of ['POST', 'GET'] as const) {
          const res = await app.inject({ method, url, headers: service, payload: {} as never });
          expect(res.statusCode).toBe(404);
        }
      }
      expect(none()).toBe(true);
    });
  });

  describe('INV-X1 only the engagement service can move coins', () => {
    // Mutation: drop the ServiceTokenGuard from CoinsController.
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

    // F18: a player principal WITH a valid service token is still refused (the no-token case is above).
    // Mutation: check the service token but not the principal kind.
    it.each(['player', 'operator'])(
      'a valid service token with principal kind %s is 403',
      async (kind) => {
        for (const cmd of COMMANDS) {
          const res = await send(cmd, body[cmd], { ...service, 'x-principal-kind': kind });
          expect(res.statusCode).toBe(403);
        }
        expect(none()).toBe(true);
      },
    );
  });

  describe('INV-X5 a token that carries acting_tenant moves no coins (decision D-5)', () => {
    // The check sits at the payments choke point (the guard of the coins controller), not only in
    // identity. The claim is read from the auth context; until the identity token lands it is the
    // placeholder header `x-acting-tenant`.
    // Mutation: drop the ActingTenantGuard, or apply it to some routes only.
    it('the pinned list of coin-value actions: each action with a route is refused with 403', async () => {
      expect(COIN_VALUE_ACTIONS).toEqual(['credit', 'reserve', 'capture', 'release', 'refund']);
      for (const action of COIN_VALUE_ACTIONS.filter((a) => a !== 'credit')) {
        const res = await send(action, body[action as (typeof COMMANDS)[number]], {
          ...service,
          [HEADER_ACTING_TENANT]: T,
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'forbidden' });
      }
      expect(none()).toBe(true);
    });

    // Every POST route under /internal/v1/coins must be one of the pinned actions, so a new coin
    // route cannot appear without joining the list (and its guard test above).
    it('every coin route is a pinned action; `credit` has no route (spin coins come by event)', () => {
      const coinRoutes = built.routes
        .filter((r) => r.startsWith('POST /internal/v1/coins/'))
        .map((r) => r.replace('POST /internal/v1/coins/', ''));
      expect(coinRoutes.sort()).toEqual(
        [...COIN_VALUE_ACTIONS].filter((a) => a !== 'credit').sort(),
      );
    });
  });

  describe('INV-X2 input is validated before any service runs', () => {
    // Mutation: pass `body` to the service without parseInput.
    it.each([0, -1, 1.5, '10', MAX_COIN_AMOUNT + 1])(
      'a coin amount of %p is 400 validation_failed',
      async (amount) => {
        const res = await send('reserve', { ...body.reserve, amount });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'validation_failed' });
        expect(none()).toBe(true);
      },
    );

    it('another currency, or a sandbox flag, is 400', async () => {
      expect((await send('reserve', { ...body.reserve, currency: 'EUR' })).statusCode).toBe(400);
      expect((await send('reserve', { ...body.reserve, sandbox: true })).statusCode).toBe(400);
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
      expect((await send('reserve', body.reserve, noTenant)).statusCode).toBe(401);
      expect(none()).toBe(true);
    });
  });

  describe('INV-X3 every failure has a defined status and error code', () => {
    // Mutation: let LedgerError or the idempotency errors fall through as 500, or answer a conflict
    // with the wrong status.
    const domain = Object.entries(PAYMENTS_ERROR_CODES).filter(
      ([code]) =>
        ![
          'validation_failed',
          'idempotency_key_required',
          'forbidden',
          'idempotency_in_progress',
          'idempotency_key_reused',
          'invalid_signature',
        ].includes(code),
    );
    it.each(domain)('LedgerError(%s) -> %i', async (code, status) => {
      ledger.capture.mockRejectedValueOnce(new LedgerError(code as never));
      const res = await send('capture', body.capture);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ code });
    });

    it.each([
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
      ledger.capture.mockResolvedValueOnce({
        status: 200,
        body: { transaction_id: R },
        replayed: true,
      });
      const res = await send('capture', body.capture);
      expect(res.statusCode).toBe(200);
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
        headers: player,
      });
      expect(res.statusCode).toBe(200);
      expect(balances.readByPlayer).toHaveBeenCalledWith(P);
    });

    // Mutation: drop the operator check from /v1/players/:player_id/balance.
    it('/v1/players/:id/balance is for operators only', async () => {
      balances.readByPlayer.mockClear();
      const url = `/v1/players/${S}/balance`;
      expect((await app.inject({ method: 'GET', url, headers: player })).statusCode).toBe(403);
      expect(balances.readByPlayer).not.toHaveBeenCalled();
      balances.readByPlayer.mockResolvedValue({
        wallet_id: R,
        available: 1,
        held: 0,
        currency: 'COIN',
      });
      expect((await app.inject({ method: 'GET', url, headers: operator() })).statusCode).toBe(200);
      expect(balances.readByPlayer).toHaveBeenCalledWith(S);
    });

    it('a missing wallet is 404 wallet_not_found', async () => {
      balances.readByPlayer.mockRejectedValueOnce(new LedgerError('wallet_not_found'));
      const res = await app.inject({
        method: 'GET',
        url: `/v1/players/${S}/balance`,
        headers: operator(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'wallet_not_found' });
    });
  });

  describe('INV-W2 billing routes: operator only, token not card, webhook public and raw', () => {
    const attemptBody = { plan_id: P, card_number: '4242424242424242' };
    const post = (url: string, payload: unknown, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url, headers, payload: payload as never });
    const key = { 'idempotency-key': 'key-12345678' };

    // Mutation: let a player create or cancel an attempt, or accept an unknown field or a token here.
    it('create attempt is operator-only, needs an Idempotency-Key, takes a card number and nothing else', async () => {
      const url = '/v1/billing/attempts';
      expect((await post(url, attemptBody, { ...player, ...key })).statusCode).toBe(403);
      expect((await post(url, attemptBody, operator())).statusCode).toBe(400);
      expect(
        (await post(url, { plan_id: P, payment_method: 'tok_4242' }, operator(key))).statusCode,
      ).toBe(400);
      expect((await post(url, { ...attemptBody, sandbox: true }, operator(key))).statusCode).toBe(
        400,
      );
      expect(billing.createAttempt).not.toHaveBeenCalled();
      billing.createAttempt.mockResolvedValueOnce({
        status: 201,
        body: { id: R, state: 'processing' },
        replayed: false,
      });
      const ok = await post(url, attemptBody, operator(key));
      expect(ok.statusCode).toBe(201);
      expect(billing.createAttempt).toHaveBeenCalledWith(attemptBody, 'key-12345678');
    });

    // The state is read by id; the answer never echoes a card number.
    it('read and cancel an attempt: operator-only; 404 attempt_not_found; 409 attempt_not_cancellable; 422 card_not_accepted', async () => {
      const get = (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: `/v1/billing/attempts/${R}`, headers });
      expect((await get(player)).statusCode).toBe(403);
      billing.getAttempt.mockResolvedValueOnce({
        id: R,
        state: 'processing',
        card_last4: '4242',
        card_brand: 'visa',
      });
      const read = await get(operator());
      expect(read.statusCode).toBe(200);
      expect(JSON.stringify(read.json())).not.toMatch(/\d{12,}/);
      billing.getAttempt.mockRejectedValueOnce(new LedgerError('attempt_not_found'));
      expect((await get(operator())).statusCode).toBe(404);
      const cancel = (headers: Record<string, string>) =>
        post(`/v1/billing/attempts/${R}/cancel`, {}, headers);
      expect((await cancel({ ...player, ...key })).statusCode).toBe(403);
      expect((await cancel(operator())).statusCode).toBe(400);
      billing.cancelAttempt.mockRejectedValueOnce(new LedgerError('attempt_not_cancellable'));
      expect((await cancel(operator(key))).statusCode).toBe(409);
      billing.createAttempt.mockRejectedValueOnce(new LedgerError('card_not_accepted'));
      expect((await post('/v1/billing/attempts', attemptBody, operator(key))).statusCode).toBe(422);
    });

    // Mutation: parse the body and re-serialise it before verifying (the signature covers the bytes).
    it('the webhook needs no tenant or token, and hands the EXACT raw body and signature to the service', async () => {
      const raw = '{"eventId":"evt_1",  "version":1}'; // odd spacing: a re-serialised body would differ
      billing.handleWebhook.mockResolvedValueOnce({ outcome: 'applied' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 'sig-abc' },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'applied' });
      expect(billing.handleWebhook).toHaveBeenCalledWith(raw, 'sig-abc');
    });

    it('a signature failure is 401 invalid_signature; any other failure is 500, never 200 (MIO-150-07)', async () => {
      const post = () =>
        app.inject({
          method: 'POST',
          url: '/v1/billing/webhooks',
          headers: { 'content-type': 'application/json', 'x-webhook-signature': 'x' },
          payload: '{}',
        });
      billing.handleWebhook.mockRejectedValueOnce(new WebhookSignatureError());
      const bad = await post();
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toMatchObject({ code: 'invalid_signature' });
      billing.handleWebhook.mockRejectedValueOnce(new Error('database is down'));
      expect((await post()).statusCode).toBe(500);
    });
  });
});
