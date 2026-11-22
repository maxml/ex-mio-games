import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MySpinsResponse, PublicWheel, SpinResponse } from '@ex-mio/contracts';
import { tryTenantContext } from '@ex-mio/tenancy';
import { SpinController } from './spin.controller';
import { SpinService } from '../services/spin.service';
import { asPlayer, authModule, bearer, playerToken } from '../testing/auth.fixture';

/**
 * POST /v1/spins and GET /v1/wheel (MIO-063, MIO-062, MIO-151). The controller validates every
 * input with a zod schema and 422s a schema failure (the engagement error contract, spec section 9).
 *
 * Mutations:
 *  - drop `.strict()` / use the loose parse on the body         -> INV-SPIN-NO-CHOICE.
 *  - read the user id from the body or a query param            -> INV-SPIN-PRINCIPAL-ONLY.
 *  - return the service result without parsing it with PublicWheel from GET /v1/wheel
 *    (the service mock returns a weight-bearing object in the second wheel test)
 *                                                               -> INV-WHEEL-PUBLIC-NO-WEIGHTS.
 *    SpinService.wheel itself is pinned in services/spin.service.test.ts.
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const A = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const B = '0190a1b2-c3d4-4e5f-8a6b-0000000000b2';
const CREDIT = '0190a1b2-c3d4-4e5f-8a6b-00000000c001';
const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const SPIN = '0190a1b2-c3d4-4e5f-8a6b-00000000d001';

describe('spin controller', () => {
  let app: NestFastifyApplication;
  const spin = jest.fn(async () => ({
    spin_id: SPIN,
    segment_index: 0,
    segment_label: 'Win',
    reward_coins: 25,
  }));
  const availableSpins = jest.fn(async () => ({ available: 3 }));
  const wheel = jest.fn(async () => ({
    wheel_id: WHEEL,
    segments: [{ label: 'Win' }, { label: 'Nothing' }],
  }));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [authModule()], // the one entry point (D-4); tokens come from service-kit/testing
      controllers: [SpinController],
      providers: [{ provide: SpinService, useValue: { spin, wheel, availableSpins } }],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  const headers = { ...asPlayer(T, A), 'idempotency-key': 'k-1' };
  const post = (payload: unknown, h: Record<string, string> = headers) =>
    app.inject({ method: 'POST', url: '/v1/spins', headers: h, payload: payload as object });

  it('INV-SPIN-NO-CHOICE: any field that tries to steer the outcome is 422 and never reaches the service', async () => {
    for (const body of [
      { weights: [1, 1000] },
      { segment: 0 },
      { seed: 'x' },
      { table_version: 1 },
      { table: { segments: [] } },
      { credit_id: CREDIT, outcome: 'jackpot' },
    ]) {
      const res = await post(body);
      expect(res.statusCode).toBe(422);
    }
    expect(spin).not.toHaveBeenCalled();
  });

  it('INV-SPIN-PRINCIPAL-ONLY: a user id in the body, query or path is refused; the service gets no user input', async () => {
    for (const body of [{ user_id: B }, { player_id: B }, { external_player_id: 'x' }]) {
      expect((await post(body)).statusCode).toBe(422);
    }
    const q = await app.inject({
      method: 'POST',
      url: `/v1/spins?user_id=${B}`,
      headers,
      payload: {},
    });
    expect(q.statusCode).toBe(201);
    expect(spin).toHaveBeenLastCalledWith({ idempotencyKey: 'k-1' }); // query param ignored
  });

  it('a valid spin request is 201 with the SpinResponse shape; credit_id is passed through', async () => {
    const res = await post({ credit_id: CREDIT });
    expect(res.statusCode).toBe(201);
    expect(SpinResponse.safeParse(res.json()).success).toBe(true);
    expect(spin).toHaveBeenLastCalledWith({ idempotencyKey: 'k-1', creditId: CREDIT });
  });

  it('requires a valid token (401) and an Idempotency-Key (400)', async () => {
    spin.mockClear();
    expect((await post({}, { 'idempotency-key': 'k-1' })).statusCode).toBe(401); // no token
    expect(
      (
        await post(
          {},
          { ...bearer(playerToken(T, A, { aud: 'payments' })), 'idempotency-key': 'k-1' },
        )
      ).statusCode,
    ).toBe(401); // a token for another service
    expect((await post({}, asPlayer(T, A))).statusCode).toBe(400); // token, no Idempotency-Key
    expect(spin).not.toHaveBeenCalled();
  });

  // Mutation: read the tenant or the principal from anywhere but the verified token (a header, the
  // body, a default tenant). The service must run under the token's tenant and principal.
  it('INV-SPIN-PRINCIPAL-ONLY: the service runs under the tenant and principal of the token, and a second player gets their own', async () => {
    const seen: Array<unknown> = [];
    spin.mockImplementation(async () => {
      seen.push(tryTenantContext());
      return { spin_id: SPIN, segment_index: 0, segment_label: 'Win', reward_coins: 25 };
    });
    await post({}, { ...asPlayer(T, A), 'idempotency-key': 'k-2' });
    await post({}, { ...asPlayer(T, B), 'idempotency-key': 'k-3' });
    expect(seen).toEqual([
      { tenantId: T, principalId: A },
      { tenantId: T, principalId: B },
    ]);
  });

  // X-3/D-13. The environment of a spin is server-side state: the `sbx` claim of the verified token.
  // Mutation: read `sandbox` from the body or a header, ignore the claim, or pass `sandbox: true` for
  // a production token.
  it('INV-SPIN-SANDBOX-CLAIM: a sandbox token makes the service run with sandbox: true; a production token passes none; a client flag is refused', async () => {
    spin.mockClear();
    spin.mockResolvedValue({ spin_id: SPIN, segment_index: 0, segment_label: 'Win', reward_coins: 25 });
    const sbx = { ...bearer(playerToken(T, A, { sbx: true })), 'idempotency-key': 'k-sbx' };
    expect((await post({}, sbx)).statusCode).toBe(201);
    expect(spin).toHaveBeenLastCalledWith({ idempotencyKey: 'k-sbx', sandbox: true });
    expect((await post({}, headers)).statusCode).toBe(201);
    expect(spin).toHaveBeenLastCalledWith({ idempotencyKey: 'k-1' }); // no sandbox key at all
    spin.mockClear();
    expect((await post({ sandbox: true })).statusCode).toBe(422); // the body cannot ask for it
    const viaHeader = await post({}, { ...headers, 'x-sandbox': '1' });
    expect(viaHeader.statusCode).toBe(201);
    expect(spin).toHaveBeenLastCalledWith({ idempotencyKey: 'k-1' }); // a header is ignored
  });

  // W-2: the widget does not know the wheel id, so the tenant's active wheel has a route of its own.
  // Mutation: drop the route, or return weights/version on it.
  it('W-2: GET /v1/wheel answers the tenant active wheel as PublicWheel (labels only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/wheel', headers });
    expect(res.statusCode).toBe(200);
    expect(PublicWheel.parse(res.json()).wheel_id).toBe(WHEEL);
    expect(res.body).not.toMatch(/weight|seed|version/i);
  });

  it('INV-WHEEL-PUBLIC-NO-WEIGHTS: GET /v1/wheel/:wheelId returns labels only', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/wheel/${WHEEL}`, headers });
    expect(res.statusCode).toBe(200);
    expect(PublicWheel.safeParse(res.json()).success).toBe(true);
    expect(res.body).not.toMatch(/weight|seed|version/i);
  });

  it('INV-WHEEL-PUBLIC-NO-WEIGHTS: the controller parses what the service returns with PublicWheel; a weight-bearing object never reaches the client', async () => {
    // the service (wrongly) returns the stored table: weights, version and all
    wheel.mockResolvedValueOnce({
      wheel_id: WHEEL,
      version: 3,
      seed: 'server-seed',
      segments: [
        { label: 'Win', weight: 1, reward: { type: 'coins', amount: 25 } },
        { label: 'Nothing', weight: 999, reward: { type: 'nothing' } },
      ],
    } as never);
    const res = await app.inject({ method: 'GET', url: `/v1/wheel/${WHEEL}`, headers });
    expect(res.statusCode).toBe(500); // the output schema is strict: a leak is a server error
    expect(res.body).not.toMatch(/weight|seed|version|999|server-seed/i);
  });

  // Mutation: drop the output parse (a service result with extra fields reaches the client), read
  // a user id from the query or path, or serve it without a token.
  it('INV-ME-SPINS: GET /v1/me/spins needs a token, takes no user input, answers { available } for the token principal only', async () => {
    availableSpins.mockClear();
    const url = '/v1/me/spins';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const seen: unknown[] = [];
    availableSpins.mockImplementation(async () => {
      seen.push(tryTenantContext());
      return { available: 3 };
    });
    const ok = await app.inject({
      method: 'GET',
      url: `${url}?user_id=${B}`,
      headers: asPlayer(T, A),
    });
    expect(ok.statusCode).toBe(200);
    expect(MySpinsResponse.parse(ok.json())).toEqual({ available: 3 });
    await app.inject({ method: 'GET', url, headers: asPlayer(T, B) });
    expect(seen).toEqual([
      { tenantId: T, principalId: A }, // the query param is ignored
      { tenantId: T, principalId: B },
    ]);
    expect(availableSpins).toHaveBeenCalledWith(); // the service gets no user input
    // the output is parsed strictly: a service that leaks credit rows or ids is a 500
    availableSpins.mockResolvedValueOnce({
      available: 1,
      credits: [{ id: CREDIT }],
      user_id: A,
    } as never);
    const leak = await app.inject({ method: 'GET', url, headers: asPlayer(T, A) });
    expect(leak.statusCode).toBe(500);
    expect(leak.body).not.toContain(CREDIT);
  });

  it('a spin response carries segment_index with the label and coins', async () => {
    const res = await post({ credit_id: CREDIT });
    expect(SpinResponse.parse(res.json())).toMatchObject({
      segment_index: 0,
      segment_label: 'Win',
    });
  });
});
