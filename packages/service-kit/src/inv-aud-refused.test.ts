import 'reflect-metadata';
import {
  type ArgumentsHost,
  Catch,
  type CanActivate,
  ConflictException,
  Controller,
  type ExceptionFilter,
  ForbiddenException,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Param,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ActingRequestAuditedV1,
  type EventEnvelope,
  PLATFORM_TENANT_ID,
  ServiceCallAuditedV1,
  type ServiceCallPolicy,
} from '@ex-mio/contracts';
import { ServiceAuthModule } from './service-auth';
import { accessClaims, generateRsaKey, serviceClaims, signJwt } from './testing/jwt-fixtures';

/*
 * INV-AUD (coordinator decision D-26; test owner, written before the fix). Unit choke point.
 *
 * The rule: the audit `decision` is `refused` for EVERY authorization refusal, whether a guard or a
 * policy check inside a service makes it, and `allowed` with the real status for every other outcome.
 * D-24 tied `refused` to "a guard refused", so a refusal decided inside a handler (identity's
 * AccessService, engagement's requireRole) is written as `allowed`/403 (rc review R1, measured).
 *
 * The contract (the coder implements it; nothing here is implementation):
 *
 *   packages/service-kit/src/authorization-refused.ts, exported from `@ex-mio/service-kit`:
 *
 *     export class AuthorizationRefused extends HttpException {
 *       constructor(input: { code: string; message?: string; status?: 403 | 404 });
 *       readonly code: string;           // non-empty, else the constructor throws
 *     }                                  // status defaults to 403; any other status throws
 *                                        // response body: { code, message }
 *
 *   Every policy check that refuses on authorization grounds throws it (or a subclass): identity's
 *   AccessService.authorize and assertMayStartActing, engagement's requireRole, payments' RolesGuard,
 *   the entry point's own refusals. The ONE place that maps it to `refused` is the entry point:
 *   ServiceAuthInterceptor marks the request when the handler's stream errors with an
 *   AuthorizationRefused (it sees the error before any exception filter rewrites the response), and
 *   `auditDecision` reads that mark; a guard's refusal keeps today's path (the handler never started).
 *   A plain HttpException(403) thrown by a handler stays `allowed`/403 (the frozen D-24 leg in
 *   service-auth.test.ts); INV-AUD-MATRIX (tests/compose) makes sure no real route answers an
 *   authorization refusal that way.
 *   A guard answer that is NOT an authorization refusal (400 VALIDATION_FAILED for a malformed
 *   internal tenant) is `allowed`/400, not `refused`.
 *
 * The class is loaded by a computed path, so this file typechecks before it exists; the tests that
 * need it fail with "AuthorizationRefused is missing" (RED for the right reason).
 *
 * Mutations (re-applied by the reviewer after the fix):
 *  - AUD-R1/R2/R3: the interceptor does not mark the request (or marks only HttpException 403) -> red.
 *  - AUD-R4: the mark is set by an exception filter instead of the interceptor -> red (a service filter
 *    that rewrites the response runs instead of the shared one).
 *  - AUD-A1: `auditDecision` from the HTTP status (every 4xx refused) -> red.
 *  - AUD-S2: the 400 of the entry point's tenant check is written `refused` -> red (today's code).
 */

type RefusedCtor = new (input: { code: string; message?: string; status?: number }) => HttpException;

const CLASS_REL = 'packages/service-kit/src/authorization-refused.ts';

function AuthorizationRefused(): RefusedCtor {
  let mod: { AuthorizationRefused?: RefusedCtor };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(['.', 'authorization-refused'].join('/')) as typeof mod;
  } catch {
    throw new Error(`INV-AUD: AuthorizationRefused is missing (${CLASS_REL} does not exist yet)`);
  }
  if (typeof mod.AuthorizationRefused !== 'function') {
    throw new Error(`INV-AUD: ${CLASS_REL} must export the class AuthorizationRefused`);
  }
  return mod.AuthorizationRefused;
}
/** Builds the error lazily, so a missing class fails the request (and the test) with the reason. */
const refuse = (input: { code: string; status?: number }): HttpException => {
  const Ctor = AuthorizationRefused();
  return new Ctor(input);
};

const NOW = 1_800_000_000;
const T_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const USER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const key1 = generateRsaKey('k1');
const ran = { n: 0 };

const POLICY: ServiceCallPolicy = {
  identity: {},
  engagement: {},
  payments: {
    engagement: [
      'GET /internal/v1/tenants/:tenantId/probe',
      'GET /internal/v1/tenants/:tenantId/probe-refused',
    ],
  },
};

/** A service-local policy service: the refusal is thrown deep inside an awaited call. */
async function policyCheck(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  throw refuse({ code: 'FORBIDDEN' });
}

class RefusingGuard implements CanActivate {
  canActivate(): boolean {
    throw refuse({ code: 'ROLE_REQUIRED' });
  }
}

/** Like identity's / engagement's error filters: it rewrites every error into the service's own body. */
@Catch()
class ServiceErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const status = e instanceof HttpException ? e.getStatus() : 500;
    host.switchToHttp().getResponse().status(status).send({ code: 'service_shaped', status });
  }
}

@Controller()
class Probe {
  @Get('v1/refused-in-handler')
  inHandler() {
    ran.n++;
    throw refuse({ code: 'ACTING_FORBIDDEN' });
  }

  @Get('v1/refused-404/:id')
  boundary(@Param('id') _id: string) {
    ran.n++;
    throw refuse({ code: 'NOT_FOUND', status: 404 });
  }

  @Get('v1/refused-in-service')
  async inService() {
    ran.n++;
    await policyCheck();
    return { LEAK: true };
  }

  @UseFilters(ServiceErrorFilter)
  @Get('v1/refused-behind-filter')
  async behindFilter() {
    ran.n++;
    await policyCheck();
    return { LEAK: true };
  }

  @UseGuards(RefusingGuard)
  @Get('v1/refused-by-guard')
  byGuard() {
    ran.n++;
    return { LEAK: true };
  }

  @Get('v1/ok')
  ok() {
    ran.n++;
    return { ok: true };
  }

  @Get('v1/missing')
  missing() {
    ran.n++;
    throw new NotFoundException();
  }

  @Get('v1/conflict')
  conflict() {
    ran.n++;
    throw new ConflictException({ code: 'illegal_transition' });
  }

  @Get('v1/business-403')
  business403() {
    ran.n++;
    throw new ForbiddenException({ code: 'business_rule' });
  }

  @Get('internal/v1/tenants/:tenantId/probe')
  internalProbe() {
    ran.n++;
    return { ok: true };
  }

  /** Not in the callee's allow-list: the entry point refuses it (a guard refusal, D-14). */
  @Get('internal/v1/tenants/:tenantId/off-list')
  internalOffList() {
    ran.n++;
    return { LEAK: true };
  }

  @Get('internal/v1/tenants/:tenantId/probe-refused')
  async internalRefused() {
    ran.n++;
    await policyCheck();
    return { LEAK: true };
  }
}

interface Booted {
  inject: (o: { method: 'GET'; url: string; headers?: Record<string, string> }) => Promise<{
    statusCode: number;
    json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }>;
  events: EventEnvelope[];
}

const open: NestFastifyApplication[] = [];
afterAll(async () => {
  await Promise.all(open.map((a) => a.close()));
});

async function boot(): Promise<Booted> {
  const events: EventEnvelope[] = [];
  @Module({
    imports: [
      ServiceAuthModule.forService({
        audience: 'engagement',
        serviceCalls: POLICY,
        auditPort: async (e: EventEnvelope) => {
          events.push(e);
        },
        jwks: async () => ({ keys: [key1.publicJwk] }),
        tenantStatus: async () => 'active' as const,
        nowSeconds: () => NOW,
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
  ran.n = 0;
  return {
    events,
    inject: (o) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject(o as never) as never,
  };
}

const actingToken = () =>
  signJwt({
    alg: 'RS256',
    key: key1.privateKey,
    kid: 'k1',
    claims: accessClaims({
      now: NOW,
      sub: USER,
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      act: { tenant_id: T_B, reason: 'ticket 42' },
      ttl: 900,
    }),
  });
const svcToken = () =>
  signJwt({
    alg: 'RS256',
    key: key1.privateKey,
    kid: 'k1',
    claims: serviceClaims({ now: NOW, service: 'payments', aud: 'engagement' }),
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** The FINAL acting event of `route` (finalize runs when the response is finished). */
async function finalActing(b: Booted, route: string) {
  for (let i = 0; i < 100; i++) {
    const hit = b.events
      .filter((e) => e.type === 'audit.acting_request')
      .map((e) => ActingRequestAuditedV1.parse(e.payload))
      .filter((p) => p.route === route);
    if (hit.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
      return hit.map((p) => ({ decision: p.decision, status: p.status }));
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no audit event for ${route}`);
}
const serviceCall = (b: Booted, route: string) =>
  b.events
    .filter((e) => e.type === 'audit.service_call')
    .map((e) => ServiceCallAuditedV1.parse(e.payload))
    .filter((p) => p.route === route)
    .map((p) => ({ decision: p.decision, status: p.status }));

describe('INV-AUD AuthorizationRefused: the typed refusal and where it lives (D-26)', () => {
  it('INV-AUD-C1 the class exists, is exported from @ex-mio/service-kit and is an HttpException', () => {
    const Ctor = AuthorizationRefused();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const index = require(['.', 'index'].join('/')) as { AuthorizationRefused?: unknown };
    expect(index.AuthorizationRefused).toBe(Ctor);
    const e = new Ctor({ code: 'FORBIDDEN' });
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toMatchObject({ code: 'FORBIDDEN' });
    expect(new Ctor({ code: 'NOT_FOUND', status: 404 }).getStatus()).toBe(404);
  });

  it('INV-AUD-C2 only 403 and the tenant-boundary 404 are refusals; a code is required', () => {
    const Ctor = AuthorizationRefused();
    for (const status of [400, 401, 409, 500, 200]) {
      expect(() => new Ctor({ code: 'X', status })).toThrow();
    }
    expect(() => new Ctor({ code: '' })).toThrow();
  });
});

describe('INV-AUD the entry point maps every authorization refusal to `refused` (D-26)', () => {
  // Mutation: the interceptor does not mark the request -> red (`allowed`/403, today's behaviour).
  it('INV-AUD-R1 a refusal thrown by the handler is audited refused/403', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: '/v1/refused-in-handler',
      headers: bearer(actingToken()),
    });
    expect(res.statusCode).toBe(403);
    expect(await finalActing(b, 'GET /v1/refused-in-handler')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
  });

  // Mutation: only a 403 is marked -> red.
  it('INV-AUD-R2 a tenant-boundary refusal (404) is audited refused/404', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: `/v1/refused-404/${T_B}`,
      headers: bearer(actingToken()),
    });
    expect(res.statusCode).toBe(404);
    expect(await finalActing(b, 'GET /v1/refused-404/:id')).toEqual([
      { decision: 'refused', status: 404 },
    ]);
  });

  // Mutation: mark only synchronous throws -> red.
  it('INV-AUD-R3 a refusal thrown deep in an awaited policy check is audited refused', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: '/v1/refused-in-service',
      headers: bearer(actingToken()),
    });
    expect(res.statusCode).toBe(403);
    expect(await finalActing(b, 'GET /v1/refused-in-service')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
  });

  // Mutation: set the mark in a shared exception filter (a service filter replaces it) -> red.
  it('INV-AUD-R4 a service exception filter that rewrites the response does not hide the refusal', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: '/v1/refused-behind-filter',
      headers: bearer(actingToken()),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'service_shaped' });
    expect(await finalActing(b, 'GET /v1/refused-behind-filter')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
  });

  it('INV-AUD-R5 a guard throwing AuthorizationRefused is refused and the handler never runs', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const res = await b.inject({
      method: 'GET',
      url: '/v1/refused-by-guard',
      headers: bearer(actingToken()),
    });
    expect(res.statusCode).toBe(403);
    expect(ran.n).toBe(0);
    expect(await finalActing(b, 'GET /v1/refused-by-guard')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
  });

  // Mutation: `auditDecision` from the HTTP status -> red. Green today: proves the R tests are
  // not satisfied by "every error is refused".
  it('INV-AUD-A1 every other outcome is allowed with its real status (200, 404, 409, plain 403)', async () => {
    const b = await boot();
    const cases: Array<[string, string, number]> = [
      ['/v1/ok', 'GET /v1/ok', 200],
      ['/v1/missing', 'GET /v1/missing', 404],
      ['/v1/conflict', 'GET /v1/conflict', 409],
      ['/v1/business-403', 'GET /v1/business-403', 403],
    ];
    for (const [url, route, status] of cases) {
      const res = await b.inject({ method: 'GET', url, headers: bearer(actingToken()) });
      expect([url, res.statusCode]).toEqual([url, status]);
      expect([route, await finalActing(b, route)]).toEqual([
        route,
        [{ decision: 'allowed', status }],
      ]);
    }
  });
});

describe('INV-AUD service calls: refusals refused, everything else allowed (D-26, D-14)', () => {
  // Mutation: the interceptor marks only user-mode requests -> red.
  it('INV-AUD-S1 a refusal thrown by an internal handler is audited refused; an allowed call allowed/200', async () => {
    AuthorizationRefused(); // fail with the reason, not with the 500 a missing class causes
    const b = await boot();
    const T = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a';
    const ok = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T}/probe`,
      headers: bearer(svcToken()),
    });
    expect(ok.statusCode).toBe(200);
    const refused = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T}/probe-refused`,
      headers: bearer(svcToken()),
    });
    expect(refused.statusCode).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(serviceCall(b, 'GET /internal/v1/tenants/:tenantId/probe')).toEqual([
      { decision: 'allowed', status: 200 },
    ]);
    expect(serviceCall(b, 'GET /internal/v1/tenants/:tenantId/probe-refused')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
  });

  // RED today: the entry point writes its own 400 (tenant check) as `refused`. A malformed tenant is
  // a validation answer, not an authorization refusal: D-26 says `allowed` with the real status.
  // Non-vacuous twin: SERVICE_CALL_FORBIDDEN (not allow-listed) stays refused/403.
  it('INV-AUD-S2 the entry point 400 for a malformed internal tenant is allowed/400; a route off the allow-list is refused/403', async () => {
    const b = await boot();
    const bad = await b.inject({
      method: 'GET',
      url: '/internal/v1/tenants/not-a-uuid/probe',
      headers: bearer(svcToken()),
    });
    expect(bad.statusCode).toBe(400);
    const forbidden = await b.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${T_B}/off-list`,
      headers: bearer(svcToken()),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(ran.n).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(serviceCall(b, 'GET /internal/v1/tenants/:tenantId/off-list')).toEqual([
      { decision: 'refused', status: 403 },
    ]);
    expect(serviceCall(b, 'GET /internal/v1/tenants/:tenantId/probe')).toEqual([
      { decision: 'allowed', status: 400 },
    ]);
  });
});
