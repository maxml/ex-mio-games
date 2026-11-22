import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { StoreItemsController } from './store-items.controller';
import { StoreItemsService } from '../services/store-items.service';
import { actingToken, auditEvents, authModule, bearer } from '../testing/auth.fixture';

/*
 * Fix round 2 re-review, D-32 (F2 CORE): acting staff never write the store catalog. Unlike the
 * wheel and rules, the store routes have no ActingBanGuard; the refusal comes from `requireRole`:
 * an acting token carries `platform_admin` only (identity sessions.service), never `operator_admin`.
 *
 * FR2-ACT-3 (green at 6298275): POST /v1/store/items and PATCH /v1/store/items/:id by an acting
 *   admin are 403, the service is never called, and the audit event says `refused`.
 *   Mutation: let an acting principal pass `requireRole` (e.g. treat `acting` as operator_admin in
 *   principal.ts) -> red.
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const OP = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f00a1';
const ITEM = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f00b2';
const item = {
  name: 'Bonus',
  price: 100,
  reward: { type: 'bonus', params: { amount_minor: 500, currency: 'EUR' } },
};

describe('D-32 acting staff cannot write the store catalog (engagement)', () => {
  let app: NestFastifyApplication;
  const service = {
    create: jest.fn(),
    update: jest.fn(),
    listActive: jest.fn(),
    listAll: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [authModule()],
      controllers: [StoreItemsController],
      providers: [{ provide: StoreItemsService, useValue: service }],
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
    ['POST', '/v1/store/items', item],
    ['PATCH', `/v1/store/items/${ITEM}`, { price: 200 }],
  ] as const)(
    'FR2-ACT-3 %s %s by an acting admin: 403, audited refused',
    async (method, url, body) => {
      const res = await app.inject({
        method,
        url,
        headers: bearer(actingToken(TENANT, OP)),
        payload: body as never,
      });
      expect(res.statusCode).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      const audited = auditEvents.filter((e) => e.type === 'audit.acting_request');
      expect(audited).toHaveLength(1);
      expect(audited[0]?.payload).toMatchObject({ decision: 'refused', status: 403 });
    },
  );
});
