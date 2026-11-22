import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { OperatorConfigController } from './operator-config.controller';
import { OperatorConfigService } from '../services/operator-config.service';
import { actingToken, auditEvents, authModule, bearer } from '../testing/auth.fixture';

/*
 * D-31 (coordinator default): acting staff (support acting as an operator) are REFUSED on every
 * configuration write. Here: `PUT /v1/operator/wheel` and `PUT /v1/operator/rules`. The refusal is
 * the typed ACTING_FORBIDDEN, the service is never called, and the audit event says `refused`.
 * Mutation: remove `@UseGuards(ActingBanGuard)` from OperatorConfigController -> the code is no
 * longer ACTING_FORBIDDEN (the role check answers `forbidden`) and this goes red.
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const OP = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f00a1';
const wheel = {
  name: 'Wheel',
  segments: [
    { label: 'a', weight: 6, reward: { type: 'coins', amount: 200 } },
    { label: 'b', weight: 4, reward: { type: 'nothing' } },
  ],
};
const rule = { name: 'Deposit 20', min_amount_minor: 2000, currency: 'EUR', spins: 1 };

describe('D-31 acting staff cannot write the operator configuration (engagement)', () => {
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

  it.each([
    ['/v1/operator/wheel', wheel],
    ['/v1/operator/rules', rule],
  ] as const)(
    'REVIEW-ACT-1 PUT %s by an acting admin: ACTING_FORBIDDEN, audited refused',
    async (url, body) => {
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: bearer(actingToken(TENANT, OP)),
        payload: body as never,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
      expect(service.putWheel).not.toHaveBeenCalled();
      expect(service.putRule).not.toHaveBeenCalled();
      const audited = auditEvents.filter((e) => e.type === 'audit.acting_request');
      expect(audited).toHaveLength(1);
      expect(audited[0]?.payload).toMatchObject({ decision: 'refused', status: 403 });
    },
  );
});
