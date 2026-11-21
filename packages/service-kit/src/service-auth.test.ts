import 'reflect-metadata';
import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  PLATFORM_TENANT_ID,
  TENANT_STATUS_CACHE_SECONDS,
} from '@ex-mio/contracts';
import * as tenancy from '@ex-mio/tenancy';
import { Public } from '@ex-mio/tenancy';
import { currentAuth, InternalTenantless, ServiceAuthModule } from './service-auth'; // RED: module does not exist yet
import { accessClaims, generateRsaKey, serviceClaims, signJwt } from './testing/jwt-fixtures';

/*
 * Choke point (D-4, review finding F2): the ONE service-kit auth entry point,
 * `ServiceAuthModule.forService(...)`, that identity, engagement and payments all use.
 * It builds the verifier, the guard and the tenant context itself and has no resolver
 * option, so no service can wire its own way of reading a tenant. These tests boot a
 * tiny Nest app through the real entry point (not a hand-built TenantGuard), the way
 * a service does, and call it over HTTP.
 *
 * Each test header names the mutation that must turn it red.
 */

const NOW = 1_800_000_000;
const T_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a';
const T_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const USER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const key1 = generateRsaKey('k1');
const stranger = generateRsaKey('k1');

@Controller()
class Probe {
  @Get('v1/whoami')
  whoami(@Query() _q: unknown) {
    return { auth: currentAuth(), tenant: tenancy.currentTenant() };
  }

  @Post('v1/echo')
  echo(@Body() _body: unknown) {
    return { auth: currentAuth(), tenant: tenancy.currentTenant() };
  }

  @Public()
  @Get('healthz')
  health() {
    return { ok: true };
  }

  @Get('internal/v1/tenants/:tenantId/ping')
  internalPath(@Param('tenantId') _id: string) {
    return { auth: currentAuth(), tenant: tenancy.currentTenant() };
  }

  @Post('internal/v1/ping')
  internalBody(@Body() _body: unknown) {
    return { auth: currentAuth(), tenant: tenancy.currentTenant() };
  }

  @InternalTenantless()
  @Post('internal/v1/webhooks/verify')
  internalTenantless() {
    return { auth: currentAuth(), tenant: tenancy.tryTenantContext() ?? null };
  }
}

interface Booted {
  app: NestFastifyApplication;
  inject: (opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }) => Promise<{ statusCode: number; json: () => any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  clock: { now: number };
  statusCalls: string[];
  status: { value: 'active' | 'suspended'; fail: boolean };
}

const open: NestFastifyApplication[] = [];
afterAll(async () => {
  await Promise.all(open.map((a) => a.close()));
});

async function boot(audience = 'engagement'): Promise<Booted> {
  const clock = { now: NOW };
  const statusCalls: string[] = [];
  const status = { value: 'active' as 'active' | 'suspended', fail: false };
  @Module({
    imports: [
      ServiceAuthModule.forService({
        audience,
        jwks: async () => ({ keys: [key1.publicJwk] }),
        tenantStatus: async (tenantId: string) => {
          statusCalls.push(tenantId);
          if (status.fail) throw new Error('identity unreachable');
          return status.value;
        },
        nowSeconds: () => clock.now,
      }),
    ],
    controllers: [Probe],
  })
  class App {}
  const app = await NestFactory.create<NestFastifyApplication>(App, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  open.push(app);
  return {
    app,
    clock,
    statusCalls,
    status,
    inject: (opts) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject(opts as never) as never,
  };
}

const userToken = (over: Partial<Parameters<typeof accessClaims>[0]> = {}) =>
  signJwt({
    alg: 'RS256',
    key: key1.privateKey,
    kid: 'k1',
    claims: accessClaims({ now: NOW, sub: USER, tid: T_A, ttl: 900, ...over }),
  });
const svcToken = (over: Partial<Parameters<typeof serviceClaims>[0]> = {}, extra = {}) =>
  signJwt({
    alg: 'RS256',
    key: key1.privateKey,
    kid: 'k1',
    claims: serviceClaims({ now: NOW, service: 'payments', aud: 'engagement', ...over, extra }),
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('INV-AUTH: one entry point, tenant only from the verified claim (every service)', () => {
  // Mutation: restore a header fallback anywhere in the entry point.
  it('INV-AUTH-1 x-tenant-id / x-principal-id without a token is 401', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { 'x-tenant-id': T_A, 'x-principal-id': USER },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: expect.stringMatching(/^(TENANT_REQUIRED|TOKEN_INVALID)$/),
    });
  });

  // Mutation: prefer the header, query, body or Host tenant over the claim.
  it('INV-AUTH-2 a token for A with a header, query, body and Host naming B is served as A', async () => {
    const b = await boot();
    const h = { ...bearer(userToken()), 'x-tenant-id': T_B, host: `${T_B}.example.test` };
    const get = await b.inject({ method: 'GET', url: `/v1/whoami?tenant_id=${T_B}`, headers: h });
    expect(get.statusCode).toBe(200);
    expect(get.json().tenant).toEqual({ tenantId: T_A, principalId: USER });
    expect(get.json().auth).toMatchObject({ mode: 'user', tenantId: T_A, principalId: USER });
    const post = await b.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: h,
      payload: { tenant_id: T_B, tenantId: T_B },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().tenant).toEqual({ tenantId: T_A, principalId: USER });
  });

  // Mutation: skip the verifier on non-@Public routes / default tenant on failure.
  it('INV-AUTH-3 no token, a forged token, an expired token, a token for another audience: all 401, never served', async () => {
    const b = await boot('engagement');
    const forged = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'k1',
      claims: accessClaims({ now: NOW, sub: USER, tid: T_A }),
    });
    const expired = userToken({ ttl: 60 });
    b.clock.now = NOW + 60 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS + 1;
    for (const headers of [
      {},
      bearer(forged),
      bearer(expired),
      bearer(userToken({ aud: 'payments' })),
    ]) {
      const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  // Mutation: @Public stops working, or the guard is no longer deny-by-default.
  it('INV-AUTH-4 only a @Public route answers without a token', async () => {
    const b = await boot();
    expect((await b.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await b.inject({ method: 'GET', url: '/v1/whoami' })).statusCode).toBe(401);
  });

  // Mutation: honour `act` only in identity, or ignore it in the shared entry point.
  it('INV-AUTH-5 an acting token is served as the acting tenant; the auth context carries the real actor and the acting claim', async () => {
    const b = await boot();
    const token = userToken({
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      act: { tenant_id: T_B, reason: 'ticket 42' },
    });
    const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant).toEqual({ tenantId: T_B, principalId: USER });
    expect(res.json().auth).toMatchObject({
      mode: 'user',
      tenantId: T_B,
      principalId: USER,
      roles: ['platform_admin'],
      acting: { tenantId: T_B, reason: 'ticket 42' },
    });
  });

  it('INV-AUTH-5 an ordinary token has no acting in the auth context', async () => {
    const b = await boot();
    const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(userToken()) });
    expect(res.json().auth.acting).toBeUndefined();
  });
});

describe('INV-AUTH-6 the entry point has no resolver option and fails closed when misconfigured', () => {
  const base = {
    audience: 'engagement',
    jwks: async () => ({ keys: [] }),
    tenantStatus: async () => 'active',
  };

  // Mutation: add a `resolver` option (the foundation's TenancyModule.forRoot({resolver})).
  it('a `resolver` option (or any unknown option) is refused at boot', () => {
    expect(() =>
      ServiceAuthModule.forService({ ...base, resolver: () => ({ tenantId: T_A }) } as never),
    ).toThrow();
    expect(() =>
      ServiceAuthModule.forService({ ...base, tenantResolver: () => undefined } as never),
    ).toThrow();
  });

  // Mutation: default the audience (a service that forgets it would accept any token).
  it('no audience, or an audience that is not a service, is refused at boot', () => {
    expect(() => ServiceAuthModule.forService({} as never)).toThrow();
    expect(() => ServiceAuthModule.forService({ ...base, audience: undefined } as never)).toThrow();
    expect(() => ServiceAuthModule.forService({ ...base, audience: 'nobody' } as never)).toThrow();
  });

  // Mutation: make the tenant status source optional (a service that forgets it never sees suspension).
  it('no tenant status source (and no identity URL to read it from) is refused at boot', () => {
    const { tenantStatus: _t, ...noStatus } = base;
    expect(() => ServiceAuthModule.forService(noStatus as never)).toThrow();
  });

  // Mutation: keep TenancyModule.forRoot({resolver}) exported next to the new entry point.
  it('the tenancy package no longer offers a module that takes a resolver', () => {
    expect('TenancyModule' in tenancy).toBe(false);
  });
});

describe('INV-AUTH-7 tenant status: cached, at most 30 s stale (D-6, Q1)', () => {
  // Mutation: no status check (a suspended tenant keeps working until the token expires).
  it('a token of a suspended tenant is refused with 403 TENANT_SUSPENDED once the cache window passed', async () => {
    const b = await boot();
    const ok = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(userToken()) });
    expect(ok.statusCode).toBe(200);
    b.status.value = 'suspended';
    b.clock.now = NOW + TENANT_STATUS_CACHE_SECONDS;
    const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(userToken()) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
  });

  // Mutation: no cache (one identity call per request) or a cache that never expires.
  it('the status is read once per tenant per 30 s, not per request', async () => {
    const b = await boot();
    for (let i = 0; i < 5; i++) {
      await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(userToken()) });
    }
    expect(b.statusCalls).toEqual([T_A]);
    b.status.value = 'suspended';
    b.clock.now = NOW + TENANT_STATUS_CACHE_SECONDS - 1;
    const stillCached = await b.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: bearer(userToken()),
    });
    expect(stillCached.statusCode).toBe(200);
    expect(b.statusCalls).toEqual([T_A]);
  });

  // Mutation: serve the last known status when identity is unreachable.
  it('an unreachable status source fails closed: 503 TENANT_STATUS_UNAVAILABLE, handler not run', async () => {
    const b = await boot();
    b.status.fail = true;
    const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(userToken()) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'TENANT_STATUS_UNAVAILABLE' });
  });

  // Mutation: apply the status check to the acting tenant (support on a suspended tenant is allowed).
  it('an acting session on a suspended tenant is still served (spec section 2)', async () => {
    const b = await boot();
    b.status.value = 'suspended';
    const token = userToken({
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      act: { tenant_id: T_B, reason: 'support' },
    });
    const res = await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
  });
});

describe('INV-AUTH-8 internal endpoints accept ONLY service tokens, tenant from the path or body (D-4)', () => {
  // Mutation: serve /internal/v1 to a user token, or serve a user route to a service token.
  it('a service token on a user route is 401; a user token on an internal route is 401', async () => {
    const b = await boot();
    expect(
      (await b.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(svcToken()) }))
        .statusCode,
    ).toBe(401);
    const res = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T_A}/ping`,
      headers: bearer(userToken()),
    });
    expect(res.statusCode).toBe(401);
  });

  // Mutation: set the tenant context from the token, the header or the Host on an internal route.
  it('tenant_id from the path sets the tenant context in service mode; x-tenant-id is ignored', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T_A}/ping`,
      headers: { ...bearer(svcToken()), 'x-tenant-id': T_B },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant).toMatchObject({ tenantId: T_A });
    expect(res.json().auth).toMatchObject({ mode: 'service', tenantId: T_A, service: 'payments' });
    expect(res.json().auth.acting).toBeUndefined();
  });

  it('tenant_id from the body sets the tenant context; the header is still ignored', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'POST',
      url: '/internal/v1/ping',
      headers: { ...bearer(svcToken()), 'x-tenant-id': T_B },
      payload: { tenant_id: T_A },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tenant).toMatchObject({ tenantId: T_A });
  });

  // Mutation: fall back to a default or to the header when the internal route has no tenant_id.
  it('an internal route with no tenant_id (and not declared tenant-less) is 400 VALIDATION_FAILED', async () => {
    const b = await boot();
    const none = await b.inject({
      method: 'POST',
      url: '/internal/v1/ping',
      headers: { ...bearer(svcToken()), 'x-tenant-id': T_A },
      payload: {},
    });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const bad = await b.inject({
      method: 'POST',
      url: '/internal/v1/ping',
      headers: bearer(svcToken()),
      payload: { tenant_id: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('a route declared @InternalTenantless() runs with no tenant context, for a service token only', async () => {
    const b = await boot();
    const ok = await b.inject({
      method: 'POST',
      url: '/internal/v1/webhooks/verify',
      headers: bearer(svcToken()),
      payload: {},
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().tenant).toBeNull();
    const user = await b.inject({
      method: 'POST',
      url: '/internal/v1/webhooks/verify',
      headers: bearer(userToken()),
      payload: {},
    });
    expect(user.statusCode).toBe(401);
  });

  // Mutation: drop the aud comparison for service tokens.
  it('a service token for another audience is 401; so is a forged one', async () => {
    const b = await boot('engagement');
    const url = `/internal/v1/tenants/${T_A}/ping`;
    expect(
      (await b.inject({ method: 'GET', url, headers: bearer(svcToken({ aud: 'payments' })) }))
        .statusCode,
    ).toBe(401);
    const forged = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'k1',
      claims: serviceClaims({ now: NOW, service: 'payments', aud: 'engagement' }),
    });
    expect((await b.inject({ method: 'GET', url, headers: bearer(forged) })).statusCode).toBe(401);
  });

  // Mutation: a service token that carries a tenant claim is trusted for it.
  it('a service token carrying tid is rejected, so a tenant cannot ride inside it', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T_A}/ping`,
      headers: bearer(svcToken({}, { tid: T_B })),
    });
    expect(res.statusCode).toBe(401);
  });

  // Mutation: check the tenant status for internal calls (identity could not read it for a suspended tenant).
  it('internal calls do not consult the tenant status cache', async () => {
    const b = await boot();
    b.status.value = 'suspended';
    const res = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T_A}/ping`,
      headers: bearer(svcToken()),
    });
    expect(res.statusCode).toBe(200);
    expect(b.statusCalls).toEqual([]);
  });
});
