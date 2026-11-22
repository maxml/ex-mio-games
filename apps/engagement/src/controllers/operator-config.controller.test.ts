import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { OperatorConfigController } from './operator-config.controller';
import { OperatorConfigService } from '../services/operator-config.service';
import {
  actingToken,
  auditEvents,
  authModule,
  bearer,
  operatorToken,
  playerToken,
} from '../testing/auth.fixture';

/*
 * HTTP layer of `PUT /v1/operator/wheel` and `PUT /v1/operator/rules` (D-27). The service is mocked:
 * these tests pin what the controller itself guarantees (role before body, validation before the
 * service, the principal recorded from the VERIFIED TOKEN, an acting request audited and refused).
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const OP = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f00a1';
const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001';
const WHEEL = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0abc';

const wheel = {
  name: 'Wheel',
  segments: [
    { label: 'a', weight: 6, reward: { type: 'coins', amount: 200 } },
    { label: 'b', weight: 4, reward: { type: 'nothing' } },
  ],
};
const rule = { name: 'Deposit 20', min_amount_minor: 2000, currency: 'EUR', spins: 1 };

describe('operator wheel and rules HTTP layer', () => {
  let app: NestFastifyApplication;
  const service = { putWheel: jest.fn(), putRule: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [authModule()],
      controllers: [OperatorConfigController],
      providers: [{ provide: OperatorConfigService, useValue: service }],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    auditEvents.length = 0;
  });

  const put = (url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method: 'PUT', url, headers, payload: payload as never });
  const admin = bearer(operatorToken(TENANT, OP));

  // Mutation: remove `requireRole(principal, 'operator_admin')` from either handler.
  it.each([
    ['/v1/operator/wheel', wheel, 'putWheel'],
    ['/v1/operator/rules', rule, 'putRule'],
  ] as const)(
    '%s: only operator_admin; staff, player and an acting admin get 403 before the service',
    async (url, body, fn) => {
      for (const headers of [
        bearer(operatorToken(TENANT, OP, 'operator_staff')),
        bearer(playerToken(TENANT, P1)),
        bearer(actingToken(TENANT, OP)),
      ]) {
        expect((await put(url, headers, body)).statusCode).toBe(403);
      }
      expect((await put(url, {}, body)).statusCode).toBe(401);
      expect(service[fn]).not.toHaveBeenCalled();
      service[fn].mockResolvedValueOnce({ id: WHEEL, version: 2 });
      const ok = await put(url, admin, body);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ id: WHEEL, version: 2 });
    },
  );

  // Mutation: stop the controller from recording the verified principal.
  it('is audited: the version is recorded with the token principal, and an acting request lands in the audit trail', async () => {
    service.putWheel.mockResolvedValueOnce({ id: WHEEL, version: 1 });
    service.putRule.mockResolvedValueOnce({ id: 'deposit', version: 1 });
    await put('/v1/operator/wheel', admin, wheel);
    await put('/v1/operator/rules', admin, rule);
    expect(service.putWheel).toHaveBeenCalledWith(expect.objectContaining({ name: 'Wheel' }), OP);
    expect(service.putRule).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: 'deposit', spins: 1 }),
      OP,
    );
    // An acting platform admin is refused, and the entry point audited the attempt.
    const refused = await put('/v1/operator/wheel', bearer(actingToken(TENANT, OP)), wheel);
    expect(refused.statusCode).toBe(403);
    const audited = auditEvents.filter((e) => e.type === 'audit.acting_request');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.payload).toMatchObject({ route: 'PUT /v1/operator/wheel' });
  });

  // Mutation: let the body choose the tenant, or drop the strict schema.
  it.each([
    ['/v1/operator/wheel', { ...wheel, tenant_id: TENANT }],
    ['/v1/operator/wheel', { ...wheel, segments: [] }],
    ['/v1/operator/wheel', { ...wheel, segments: [{ ...wheel.segments[0], weight: 0 }] }],
    ['/v1/operator/wheel', { ...wheel, segments: [{ ...wheel.segments[0], weight: 1.5 }] }],
    ['/v1/operator/wheel', { ...wheel, segments: [{ ...wheel.segments[0], weight: 1_000_001 }] }],
    [
      '/v1/operator/wheel',
      { ...wheel, segments: [{ ...wheel.segments[0], reward: { type: 'coins', amount: -1 } }] },
    ],
    ['/v1/operator/wheel', { ...wheel, wheel_id: 'not-a-uuid' }],
    ['/v1/operator/rules', { ...rule, tenant_id: TENANT }],
    ['/v1/operator/rules', { ...rule, spins: 0 }],
    ['/v1/operator/rules', { ...rule, spins: 101 }],
    ['/v1/operator/rules', { ...rule, min_amount_minor: -1 }],
    ['/v1/operator/rules', { ...rule, currency: 'eur' }],
    ['/v1/operator/rules', { ...rule, rule_id: 'Bad Id!' }],
    ['/v1/operator/rules', { ...rule, wheel_id: 'nope' }],
    ['/v1/operator/rules', {}],
  ])(
    '%s rejects an invalid body with 400 and never reaches the service (%#)',
    async (url, body) => {
      const res = await put(url, admin, body);
      expect(res.statusCode).toBe(400);
      expect(service.putWheel).not.toHaveBeenCalled();
      expect(service.putRule).not.toHaveBeenCalled();
    },
  );

  it('a wheel with the total weight at the cap is accepted; one above it is 400', async () => {
    service.putWheel.mockResolvedValue({ id: WHEEL, version: 1 });
    const seg = (weight: number) => ({ label: 'x', weight, reward: { type: 'nothing' } });
    const at = { name: 'cap', segments: [seg(500_000), seg(500_000)] };
    const over = { name: 'cap', segments: [seg(500_000), seg(500_001)] };
    expect((await put('/v1/operator/wheel', admin, at)).statusCode).toBe(200);
    expect((await put('/v1/operator/wheel', admin, over)).statusCode).toBe(400);
  });

  it('surfaces the service refusals with their status and code', async () => {
    const { HttpException } = await import('@nestjs/common');
    service.putRule.mockRejectedValueOnce(
      new HttpException({ code: 'wheel_missing', message: 'publish a wheel first' }, 409),
    );
    const res = await put('/v1/operator/rules', admin, rule);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'wheel_missing' });
  });
});
