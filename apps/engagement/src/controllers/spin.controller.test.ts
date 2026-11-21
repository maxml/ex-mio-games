import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PublicWheel, SpinResponse } from '@ex-mio/contracts';
import { TenancyModule } from '@ex-mio/tenancy';
import { SpinController } from './spin.controller'; // RED: module missing
import { SpinService } from '../services/spin.service'; // RED: module missing

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
  const spin = jest.fn(async () => ({ spin_id: SPIN, segment_label: 'Win', reward_coins: 25 }));
  const wheel = jest.fn(async () => ({
    wheel_id: WHEEL,
    segments: [{ label: 'Win' }, { label: 'Nothing' }],
  }));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [TenancyModule.forRoot()],
      controllers: [SpinController],
      providers: [{ provide: SpinService, useValue: { spin, wheel } }],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  const headers = { 'x-tenant-id': T, 'x-principal-id': A, 'idempotency-key': 'k-1' };
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

  it('requires a tenant (401) and an Idempotency-Key (400)', async () => {
    expect((await post({}, {})).statusCode).toBe(401);
    expect((await post({}, { 'x-tenant-id': T, 'x-principal-id': A })).statusCode).toBe(400);
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
});
