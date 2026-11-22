import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createEvent } from '@ex-mio/contracts';
import { HealthModule } from '@ex-mio/service-kit';
import { ProjectionsController } from './controllers/projections.controller';
import { ProjectionsService } from './services/projections.service';
import { authModule, bearer, playerToken } from './testing/auth.fixture';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const getOwn = jest.fn(async () => ({
  tenant_id: TENANT,
  name: 'Acme',
  slug: 'acme',
  applied_count: 1,
}));

describe('engagement HTTP layer', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      // The one auth entry point (D-4): the tenant comes from a verified token, never a header.
      imports: [authModule(), HealthModule.register({ useFactory: () => ({}) })],
      controllers: [ProjectionsController],
      providers: [{ provide: ProjectionsService, useValue: { getOwn } }],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  it('serves /healthz/live without a tenant', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz/live' })).statusCode).toBe(200);
  });

  it('refuses a tenant route without a tenant', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/tenant-projection' })).statusCode).toBe(
      401,
    );
    expect(getOwn).not.toHaveBeenCalled();
  });

  it('serves the projection for a verified token of the tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenant-projection',
      headers: bearer(playerToken(TENANT, '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001')),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied_count).toBe(1);
  });
});

describe('ProjectionsService.onTenantCreated', () => {
  it('rejects an event whose payload is not a tenant-created payload', async () => {
    const repo = { applyTenantCreated: jest.fn() };
    const service = new ProjectionsService({} as never, repo as never);
    const bad = {
      ...createEvent({
        type: 'identity.tenant.created',
        tenantId: TENANT,
        sandbox: false,
        payload: { name: 'A', slug: 'a' },
      }),
      payload: {},
    };
    await expect(service.onTenantCreated({} as never, bad)).rejects.toThrow();
    expect(repo.applyTenantCreated).not.toHaveBeenCalled();
  });
});
