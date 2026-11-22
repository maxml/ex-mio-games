import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { IdempotencyInFlightError, IdempotencyMismatchError } from '@ex-mio/idempotency';
import {
  COIN_COMMANDS,
  COIN_VALUE_ACTIONS,
  MAX_COIN_AMOUNT,
  PAYMENTS_ERROR_CODES,
  PAYMENTS_INTERNAL_ROUTES,
} from '@ex-mio/contracts';
import { LedgerError } from '../services/ledger.errors';
import { WebhookSignatureError } from '../services/providers/payment-provider';
import { buildApp, type BuiltApp } from '../testing/app';
import { bearer, PLAYER, T, T_OTHER, tokens } from '../testing/auth';

// Choke point: the HTTP layer of the REAL application module (the service-kit entry point with
// fixture keys, zod parse, caller allow-list, error mapping, route table) with the services mocked
// and the database, broker and Redis replaced by stubs. Spec: docs/specs/payments.md, sections 3
// and 5. There are NO header placeholders (X-9): every request carries a JWT, and the tenant of an
// internal route is in the path (X-4, D-4).

const R = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2d';
const S = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2e';
const P = PLAYER;

const KEY = { 'idempotency-key': 'key-12345678' };
const service = { ...bearer(tokens.service()), ...KEY };
const operator = (extra: Record<string, string> = {}) => ({
  ...bearer(tokens.operator()),
  ...extra,
});
const player = bearer(tokens.player());

const body = {
  reserve: { player_id: P, reserve_id: R, amount: 5, sandbox: false },
  capture: {},
  release: {},
  refund: {},
};
const COMMANDS = COIN_COMMANDS;
const urlOf = (cmd: string, tenant = T, reserve = R) =>
  cmd === 'reserve'
    ? `/internal/v1/tenants/${tenant}/reserves`
    : `/internal/v1/tenants/${tenant}/reserves/${reserve}/${cmd}`;
/** `POST /internal/v1/tenants/:tenantId/reserves` -> the path part. */
const templateOf = (entry: string) => entry.split(' ')[1] as string;

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

  const send = (
    cmd: string,
    payload: unknown,
    headers: Record<string, string> = service,
    url = urlOf(cmd),
  ) => app.inject({ method: 'POST', url, headers, payload: payload as never });
  const none = () => COMMANDS.every((c) => ledger[c].mock.calls.length === 0);

  describe('INV-X1 route table: the surface is exactly what the spec lists', () => {
    // Mutation: keep the foundation's CreditsController registered (POST /v1/credits), or add any
    // POST route (adjust, mint, set-balance, a credit under any path). This is the MIO-150-02 test:
    // it fails on the route table of the real module, not on a list of words.
    it('the POST routes are exactly the four coin commands (PAYMENTS_INTERNAL_ROUTES), the attempt create and cancel, and the webhook', () => {
      const coin = [
        PAYMENTS_INTERNAL_ROUTES.reserve,
        PAYMENTS_INTERNAL_ROUTES.capture,
        PAYMENTS_INTERNAL_ROUTES.release,
        PAYMENTS_INTERNAL_ROUTES.refund,
      ];
      expect([...built.routes.filter((r) => r.startsWith('POST '))].sort()).toEqual(
        [
          ...coin,
          'POST /v1/billing/attempts',
          'POST /v1/billing/attempts/:id/cancel',
          'POST /v1/billing/webhooks',
        ].sort(),
      );
      // the one internal read is the balance
      expect(
        built.routes.filter((r) => /\/internal\/v1\//.test(r) && r.startsWith('GET ')),
      ).toEqual([PAYMENTS_INTERNAL_ROUTES.balance]);
    });

    it('no route of any method can credit, mint, adjust or accept a sandbox flag in a URL', () => {
      expect(built.routes.filter((r) => /credit|mint|adjust|set-balance|sandbox/i.test(r))).toEqual(
        [],
      );
    });

    it('/v1/credits and every credit path answer 404', async () => {
      for (const url of [
        '/v1/credits',
        '/v1/coins/credit',
        `/internal/v1/tenants/${T}/coins/credit`,
        `/internal/v1/tenants/${T}/credits`,
      ]) {
        for (const method of ['POST', 'GET'] as const) {
          const res = await app.inject({ method, url, headers: service, payload: {} as never });
          expect([url, method, res.statusCode]).toEqual([url, method, 404]);
        }
      }
      expect(none()).toBe(true);
    });
  });

  describe('INV-X1 only the engagement service can move coins (service token, aud=payments, caller allow-list)', () => {
    // Mutation: drop the service-token requirement from the internal routes.
    it.each(COMMANDS)('%s without a token is 401 and reaches no service', async (cmd) => {
      expect((await send(cmd, body[cmd], KEY)).statusCode).toBe(401);
      expect(none()).toBe(true);
    });

    // Mutation: accept a user token (operator, staff, player, acting) on an internal route.
    it.each([
      ['operator', () => tokens.operator()],
      ['staff', () => tokens.staff()],
      ['player', () => tokens.player()],
      ['acting', () => tokens.acting()],
    ])('a %s token on an internal coin route is 401', async (_name, make) => {
      for (const cmd of COMMANDS) {
        const res = await send(cmd, body[cmd], { ...bearer(make()), ...KEY });
        expect([cmd, res.statusCode]).toEqual([cmd, 401]);
      }
      expect(none()).toBe(true);
    });

    // Mutation: drop the aud comparison for service tokens.
    it.each(COMMANDS)('%s with a service token for another audience is 401', async (cmd) => {
      const res = await send(cmd, body[cmd], {
        ...bearer(tokens.service('engagement', 'identity')),
        ...KEY,
      });
      expect(res.statusCode).toBe(401);
      expect(none()).toBe(true);
    });

    // X-18. Mutation: check `aud` only, not the caller. svc:identity may hold a payments token and
    // must still be refused: only svc:engagement is in SERVICE_CALL_POLICY for these routes.
    it.each(COMMANDS)(
      '%s from svc:identity with aud=payments is 403 SERVICE_CALL_FORBIDDEN',
      async (cmd) => {
        const res = await send(cmd, body[cmd], {
          ...bearer(tokens.service('identity', 'payments')),
          ...KEY,
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'SERVICE_CALL_FORBIDDEN' });
        expect(none()).toBe(true);
      },
    );

    // X-4/D-4. Mutation: take the tenant from the body or a header instead of the path.
    it('the tenant of a command is the tenant in the path; a body tenant_id is 400', async () => {
      await send('reserve', body.reserve, service, urlOf('reserve', T_OTHER));
      expect(ledger.reserve).toHaveBeenCalledTimes(1);
      const res = await send('reserve', { ...body.reserve, tenant_id: T });
      expect(res.statusCode).toBe(400);
      expect(ledger.reserve).toHaveBeenCalledTimes(1);
    });
  });

  describe('INV-X5 a token that carries `act` moves no coins (decision D-5, D-14)', () => {
    // The choke point at payments: the internal coin routes accept service tokens only, which carry
    // no `act`; a user token (acting included) is refused by the entry point before any handler.
    // User-mode routes carry no coin effect, so the acting guard has nothing to guard there, and
    // the route scan below pins that. The guard itself and the walk over the module tree are
    // pinned in acting-ban.test.ts and wiring.test.ts (identity epic, INV-ACTBAN, INV-WIRE).
    // Mutation: add a user-mode route that moves coins, or add/drop an action in the list.
    it('the pinned list of coin-value actions is exactly these five (a literal, not the constant)', () => {
      expect([...COIN_VALUE_ACTIONS]).toEqual([
        'credit',
        'reserve',
        'capture',
        'release',
        'refund',
      ]);
    });

    it('every state-changing user-mode route is in a reviewed list, and every coin route is internal', () => {
      const userMode = built.routes.filter(
        (r) => !r.startsWith('GET ') && !r.includes(' /internal/v1/'),
      );
      expect(userMode.sort()).toEqual(
        [
          'POST /v1/billing/attempts',
          'POST /v1/billing/attempts/:id/cancel',
          'POST /v1/billing/webhooks',
        ].sort(),
      );
      const coinRoutes = built.routes
        .filter((r) => r.includes(' /internal/v1/'))
        .map(templateOf)
        .filter((p) => /\/reserves/.test(p));
      expect(coinRoutes.length).toBe(4);
    });

    // D-11/X-12: the entry point audits an acting request that is refused here.
    it('an acting token on an internal coin route is 401 and handler-free', async () => {
      const res = await send('reserve', body.reserve, { ...bearer(tokens.acting()), ...KEY });
      expect(res.statusCode).toBe(401);
      expect(none()).toBe(true);
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

    it('another currency is 400, and the environment flag is required and boolean (X-4)', async () => {
      expect((await send('reserve', { ...body.reserve, currency: 'EUR' })).statusCode).toBe(400);
      const { sandbox: _s, ...noFlag } = body.reserve;
      expect((await send('reserve', noFlag)).statusCode).toBe(400);
      expect((await send('reserve', { ...body.reserve, sandbox: 'true' })).statusCode).toBe(400);
      expect(none()).toBe(true);
      // the flag reaches the service exactly as the caller sent it
      await send('reserve', { ...body.reserve, sandbox: true });
      expect(ledger.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ sandbox: true }),
        'key-12345678',
      );
    });

    // Mutation: use .passthrough() on ReserveRefRequest.
    it.each(['capture', 'release', 'refund'] as const)(
      "%s with an amount field is 400: the amount is the reserve's own",
      async (cmd) => {
        expect((await send(cmd, { amount: 5 })).statusCode).toBe(400);
        expect(none()).toBe(true);
      },
    );

    it.each(['capture', 'release', 'refund'] as const)(
      '%s names the reserve in the path: a path that is not a uuid is 400',
      async (cmd) => {
        const res = await send(
          cmd,
          {},
          service,
          `/internal/v1/tenants/${T}/reserves/not-a-uuid/${cmd}`,
        );
        expect(res.statusCode).toBe(400);
        expect(none()).toBe(true);
      },
    );

    it.each(COMMANDS)(
      '%s without an Idempotency-Key is 400 idempotency_key_required',
      async (cmd) => {
        const res = await send(cmd, body[cmd], bearer(tokens.service()));
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
        expect(none()).toBe(true);
      },
    );

    it('a tenant that is not a uuid is 400 and reaches no service', async () => {
      const res = await send(
        'reserve',
        body.reserve,
        service,
        '/internal/v1/tenants/acme/reserves',
      );
      expect(res.statusCode).toBe(400);
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
          'acting_forbidden',
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
    it('/v1/me/balance uses the token subject and ignores a player id in the query', async () => {
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
      expect(balances.readByPlayer).toHaveBeenCalledWith(P, { sandbox: false });
    });

    // X-2/X-3. Mutation: pick the environment from a header or a query, or ignore the `sbx` claim.
    it('the wallet environment comes from the token claim `sbx`, never from the request', async () => {
      balances.readByPlayer.mockResolvedValue({
        wallet_id: R,
        available: 1,
        held: 0,
        currency: 'COIN',
      });
      balances.readByPlayer.mockClear();
      const sbx = bearer(tokens.player({ sbx: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/balance?sandbox=false',
        headers: { ...sbx, 'x-sandbox': '0' },
      });
      expect(res.statusCode).toBe(200);
      expect(balances.readByPlayer).toHaveBeenCalledWith(P, { sandbox: true });
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
      expect(balances.readByPlayer).toHaveBeenCalledWith(S, { sandbox: false });
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
    const key = KEY;

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
