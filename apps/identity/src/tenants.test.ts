import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { TenancyModule } from '@ex-mio/tenancy';
import { HealthModule } from '@ex-mio/service-kit';
import { PLATFORM_ADMIN_TOKEN, PlatformAdminGuard } from './controllers/platform-admin.guard';
import { TenantsController } from './controllers/tenants.controller';
import { TenantsService } from './services/tenants.service';

const TOKEN = 'dev-platform-token-0000';
const create = jest.fn(async (input: { name: string; slug: string }) => ({
  id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
  ...input,
  created_at: new Date().toISOString(),
}));

describe('identity HTTP layer', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [TenancyModule.forRoot(), HealthModule.register({ useFactory: () => ({}) })],
      controllers: [TenantsController],
      providers: [
        PlatformAdminGuard,
        { provide: PLATFORM_ADMIN_TOKEN, useValue: TOKEN },
        { provide: TenantsService, useValue: { create, get: jest.fn() } },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  it('serves /healthz/live without a tenant', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('rejects tenant creation without the platform token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      payload: { name: 'A', slug: 'aa' },
    });
    expect(res.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('validates the body before the service sees it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { 'x-platform-admin-token': TOKEN },
      payload: { name: '', slug: 'Not A Slug' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a tenant for a valid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { 'x-platform-admin-token': TOKEN },
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({ name: 'Acme', slug: 'acme' });
  });
});
