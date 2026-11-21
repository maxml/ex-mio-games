import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { IS_PUBLIC } from '@ex-mio/tenancy';
import {
  ActingRequestAuditedV1,
  AuditEntry,
  CredentialIssued,
  CredentialSummary,
  IdentityErrorBody,
  INTERNAL_ROUTES,
  InternalResolvePlayerResponse,
  JwksResponse,
  LaunchResponse,
  PlayerLinkResponse,
  PlayerLookup,
  SERVICE_CALL_POLICY,
  ServiceCallAuditedV1,
  ServiceTokenClaims,
  SignupResponse,
  StaffMember,
  TenantIntegration,
  TenantStatusResponse,
  TenantView,
  TokenResponse,
  uuidv7,
} from '@ex-mio/contracts';
import {
  accessClaims,
  decodePayload,
  generateRsaKey,
  signJwt,
  signLaunchToken,
} from '@ex-mio/service-kit/testing';
import { identityControllers } from './controllers'; // RED: module does not exist yet
import { PERMISSION_KEY, PermissionGuard } from './controllers/permissions'; // RED
import { createTestApp } from './testing/app'; // RED

/*
 * Choke point: the HTTP edge: the service-kit entry point ServiceAuthModule (tenant from the
 * verified claim; service tokens on /internal/v1 only), PermissionGuard (default deny),
 * controllers (zod first). Routes are fixed in docs/specs/identity.md.
 * Backlog: MIO-031, MIO-045, MIO-034, MIO-046.
 */

const PW = 'correct horse battery';
const SERVICE_SECRETS = {
  engagement: 'engagement-test-secret-0001',
  payments: 'payments-test-secret-00001',
};
type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function world() {
  const ctx = await createTestApp({ serviceClients: SERVICE_SECRETS });
  const { kernel: k } = ctx;
  const a = await k.staff.signUpOperator({
    tenant_name: 'A',
    slug: 'a',
    email: 'boss@a.test',
    password: PW,
  });
  const b = await k.staff.signUpOperator({
    tenant_name: 'B',
    slug: 'b',
    email: 'boss@b.test',
    password: PW,
  });
  const platform = await k.tenants.platformTenant();
  await k.staff.createPlatformAdmin({ email: 'root@mio.test', password: PW });
  const tokenFor = async (tenantId: string, email: string) =>
    (await k.sessions.login(tenantId, { email, password: PW, audience: 'identity' })).access_token;
  const get = (c: Ctx, url: string, headers: Record<string, string> = {}) =>
    c.app.inject({ method: 'GET', url, headers });
  return { ...ctx, k, a, b, platform, tokenFor, get };
}

describe('INV-EDGE: tenant from the verified token only; deny by default', () => {
  // Mutation: restore the x-tenant-id header fallback in the resolver.
  it('INV-EDGE-1 a request with only x-tenant-id is 401 with an IdentityErrorBody', async () => {
    const w = await world();
    const res = await w.get(w, '/v1/staff', { 'x-tenant-id': w.a.tenant.id });
    expect(res.statusCode).toBe(401);
    expect(IdentityErrorBody.safeParse(res.json()).success).toBe(true);
  });

  // Mutation: prefer the header over the claim.
  it("INV-EDGE-2 a token for A with x-tenant-id naming B lists A's staff only", async () => {
    const w = await world();
    const res = await w.get(w, '/v1/staff', {
      authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
      'x-tenant-id': w.b.tenant.id,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ email: string }>).map((u) => u.email)).toEqual(['boss@a.test']);
  });

  // Mutation: let the verifier accept a token signed by a key not in JWKS.
  it('INV-EDGE-3 a forged token (unknown key) and a forged acting claim are 401 TOKEN_INVALID', async () => {
    const w = await world();
    const stranger = generateRsaKey('forged');
    const base = accessClaims({
      now: w.k.now(),
      sub: w.a.user.id,
      tid: w.a.tenant.id,
      aud: 'identity',
    });
    const forged = signJwt({ alg: 'RS256', key: stranger.privateKey, kid: 'forged', claims: base });
    const forgedActing = signJwt({
      alg: 'RS256',
      key: stranger.privateKey,
      kid: 'forged',
      claims: {
        ...base,
        roles: ['platform_admin'],
        act: { tenant_id: w.b.tenant.id, reason: 'x' },
      },
    });
    for (const token of [forged, forgedActing]) {
      const res = await w.get(w, '/v1/staff', { authorization: `Bearer ${token}` });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'TOKEN_INVALID' });
    }
  });

  // Mutation: serve the JWKS behind the guard, or include private members.
  it('INV-EDGE-4 /.well-known/jwks.json and /healthz/live are public', async () => {
    const w = await world();
    const jwks = await w.get(w, '/.well-known/jwks.json');
    expect(jwks.statusCode).toBe(200);
    expect(JwksResponse.safeParse(jwks.json()).success).toBe(true);
    expect((await w.get(w, '/healthz/live')).statusCode).toBe(200);
  });

  // Mutation: read tenant_id from the login body, or fall back to a default tenant for an unknown host.
  it('INV-EDGE-5 login takes the tenant from Host: unknown host 400 TENANT_UNRESOLVED; a body tenant_id is 400 VALIDATION_FAILED', async () => {
    const w = await world();
    const login = (host: string, extra: object = {}) =>
      w.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { host },
        payload: { email: 'boss@a.test', password: PW, ...extra },
      });
    expect((await login('a.mio.test')).statusCode).toBe(200);
    const unknown = await login('nobody.mio.test');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'TENANT_UNRESOLVED' });
    const smuggled = await login('a.mio.test', { tenant_id: w.b.tenant.id });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    // the same credentials on B's host fail: B has no such account
    expect((await login('b.mio.test')).statusCode).toBe(401);
  });

  // Mutation: validate after the service call / skip .strict().
  it('INV-EDGE-6 signup rejects unknown fields (roles, type) before any service call', async () => {
    const w = await world();
    const res = await w.app.inject({
      method: 'POST',
      url: '/v1/operators/signup',
      payload: {
        tenant_name: 'C',
        slug: 'cc',
        email: 'c@c.test',
        password: PW,
        roles: ['platform_admin'],
        type: 'platform',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await w.k.tenants.listOperatorSlugs()).toEqual(['a', 'b']);
  });

  // Mutation: authorize players.read on role only (no tenant comparison).
  it("INV-EDGE-7 cross-tenant read is 404: A's admin asks for B's player", async () => {
    const w = await world();
    const { user_id } = await w.k.players.resolveOrCreate(w.b.tenant.id, 'sim-casino', 'ext-1');
    const res = await w.get(w, `/v1/players/${user_id}`, {
      authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    const own = await w.get(
      w,
      `/v1/players/${(await w.k.players.resolveOrCreate(w.a.tenant.id, 'sim-casino', 'ext-1')).user_id}`,
      { authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}` },
    );
    expect(own.statusCode).toBe(200);
  });
});

describe('INV-EDGE acting through HTTP (MIO-034 negative cases)', () => {
  const actingToken = async (w: Awaited<ReturnType<typeof world>>, tenantId: string) => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/acting',
      headers: { authorization: `Bearer ${await w.tokenFor(w.platform.id, 'root@mio.test')}` },
      payload: { tenant_id: tenantId, reason: 'ticket 42' },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { access_token: string }).access_token;
  };

  // Mutation: drop the acting requirement for platform_admin.
  it('INV-EDGE-8 platform admin without acting gets 403 ACTING_REQUIRED on an operator tenant; with acting it is 200 and audited', async () => {
    const w = await world();
    const plain = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${await w.tokenFor(w.platform.id, 'root@mio.test')}`,
    });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ code: 'ACTING_REQUIRED' });
    const ok = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${await actingToken(w, w.a.tenant.id)}`,
    });
    expect(ok.statusCode).toBe(200);
    const audit = await w.get(w, '/v1/audit', {
      authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
    });
    expect(audit.statusCode).toBe(200);
    expect(
      (audit.json() as Array<{ action: string; acting_tenant_id: string }>).map((e) => [
        e.action,
        e.acting_tenant_id,
      ]),
    ).toEqual([
      ['acting.start', w.a.tenant.id],
      ['tenant.read', w.a.tenant.id],
    ]);
  });

  // Mutation: let the URL tenant override the acting tenant (named in MIO-034).
  it('INV-EDGE-9 an acting session for A used on a URL naming B is 403 ACTING_TENANT_MISMATCH', async () => {
    const w = await world();
    const res = await w.get(w, `/v1/tenants/${w.b.tenant.id}`, {
      authorization: `Bearer ${await actingToken(w, w.a.tenant.id)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACTING_TENANT_MISMATCH' });
  });

  // F10 (MIO-034 negative case "URL, body or header naming B"). Mutation: let a body tenant or a
  // header override the acting tenant (or smuggle a tenant past the strict body).
  it('INV-EDGE-9 an acting session for A with a body or a header naming B never reaches B', async () => {
    const w = await world();
    const token = await actingToken(w, w.a.tenant.id);
    const body = await w.app.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { platform: 'sim-casino', tenant_id: w.b.tenant.id },
    });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await w.k.credentials.list(
        await w.k.subjectOf(
          await w.k.verify(await w.tokenFor(w.b.tenant.id, 'boss@b.test'), 'identity'),
        ),
      ),
    ).toEqual([]);
    const header = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${token}`,
      'x-tenant-id': w.b.tenant.id,
    });
    expect(header.statusCode).toBe(200);
    expect(header.json()).toMatchObject({ id: w.a.tenant.id });
  });

  // Mutation: skip the role check on POST /v1/auth/acting.
  it('INV-EDGE-10 an operator admin posting to /v1/auth/acting is 403 ACTING_FORBIDDEN; no reason is 400', async () => {
    const w = await world();
    const forbidden = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/acting',
      headers: { authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}` },
      payload: { tenant_id: w.b.tenant.id, reason: 'curious' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
    const noReason = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/acting',
      headers: { authorization: `Bearer ${await w.tokenFor(w.platform.id, 'root@mio.test')}` },
      payload: { tenant_id: w.b.tenant.id, reason: '' },
    });
    expect(noReason.statusCode).toBe(400);
  });

  // N1 / D-14: TTL 900 s + 30 s skew. Valid at +929 s over HTTP (and then audited), TOKEN_EXPIRED at
  // +931 s with nothing more audited. Mutation: acting token keeps working after expiry; no leeway
  // (expires at +901); a leeway of 300 (still valid at +931).
  it('INV-EDGE-11 an acting session is served at +929 s; at +931 s it is 401 TOKEN_EXPIRED and nothing more is audited', async () => {
    const w = await world();
    const token = await actingToken(w, w.a.tenant.id);
    w.k.advance(929);
    const inside = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${token}`,
    });
    expect(inside.statusCode).toBe(200);
    expect((await w.k.audit.list(w.a.tenant.id)).map((e) => e.action)).toEqual([
      'acting.start',
      'tenant.read',
    ]);
    w.k.advance(2);
    const res = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect((await w.k.audit.list(w.a.tenant.id)).map((e) => e.action)).toEqual([
      'acting.start',
      'tenant.read',
    ]);
  });

  // D-11 item 8, producer side. Identity's own entry point audits the acting requests identity
  // serves, through the same port as every service (spec 1.7). Mutation: identity wired with a no-op port.
  it('INV-EDGE-12 an acting request served by identity writes one audit.acting_request event through its outbox', async () => {
    const w = await world();
    const token = await actingToken(w, w.a.tenant.id);
    const before = w.k.outbox.events().filter((e) => e.type === 'audit.acting_request').length;
    const ok = await w.get(w, `/v1/tenants/${w.a.tenant.id}?q=secret`, {
      authorization: `Bearer ${token}`,
    });
    expect(ok.statusCode).toBe(200);
    const events = w.k.outbox.events().filter((e) => e.type === 'audit.acting_request');
    expect(events).toHaveLength(before + 1);
    const last = events[events.length - 1];
    expect(last?.tenant_id).toBe(w.a.tenant.id);
    expect(ActingRequestAuditedV1.parse(last?.payload)).toMatchObject({
      service: 'identity',
      route: 'GET /v1/tenants/:id',
      decision: 'allowed',
      status: 200,
      acting_tenant_id: w.a.tenant.id,
    });
    expect(JSON.stringify(last)).not.toContain('secret');
  });

  // D-11 item 8, reader side (a durable record is consumed and described correctly), and N9: the
  // entry-point event is the REQUEST-level audit, `authorize` rows are the PERMISSION-level audit;
  // both are kept, with different `action`s, so INV-EDGE-8 (which delivers no events) is unchanged.
  // Mutation: no consumer; a second row on redelivery; the row drops service/route/decision.
  it('INV-EDGE-13 the identity consumer turns audit.acting_request into one audit row, idempotent on redelivery, readable by the operator', async () => {
    const w = await world();
    const event = {
      event_id: uuidv7(),
      type: 'audit.acting_request',
      version: 1,
      tenant_id: w.a.tenant.id,
      occurred_at: new Date(w.k.now() * 1000).toISOString(),
      correlation_id: uuidv7(),
      causation_id: null,
      payload: {
        actor_user_id: uuidv7(),
        actor_tenant_id: w.platform.id,
        acting_tenant_id: w.a.tenant.id,
        reason: 'ticket 42',
        service: 'payments',
        method: 'POST',
        route: 'POST /v1/credits',
        decision: 'refused',
        status: 403,
        request_id: 'req-12345678',
        occurred_at: new Date(w.k.now() * 1000).toISOString(),
      },
    };
    await w.k.auditConsumer.handle(event);
    await w.k.auditConsumer.handle(event); // redelivery
    const audit = await w.get(w, '/v1/audit', {
      authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
    });
    expect(audit.statusCode).toBe(200);
    const rows = AuditEntry.array().parse(audit.json());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'acting.request',
      acting_tenant_id: w.a.tenant.id,
      service: 'payments',
      route: 'POST /v1/credits',
      decision: 'refused',
      reason: 'ticket 42',
    });
    // another tenant's operator never sees it
    const other = await w.get(w, '/v1/audit', {
      authorization: `Bearer ${await w.tokenFor(w.b.tenant.id, 'boss@b.test')}`,
    });
    expect(other.json()).toEqual([]);
  });

  // D-14 "every such call is audited": the same consumer turns audit.service_call into a row with no user actor.
  it('INV-EDGE-13 the consumer also stores audit.service_call (no user actor, no acting tenant), once per event id', async () => {
    const w = await world();
    const event = {
      event_id: uuidv7(),
      type: 'audit.service_call',
      version: 1,
      tenant_id: w.a.tenant.id,
      occurred_at: new Date(w.k.now() * 1000).toISOString(),
      correlation_id: uuidv7(),
      causation_id: null,
      payload: {
        caller_service: 'engagement',
        service: 'payments',
        method: 'POST',
        route: 'POST /internal/v1/tenants/:tenantId/reserves',
        decision: 'allowed',
        status: 201,
        request_id: 'req-12345678',
        occurred_at: new Date(w.k.now() * 1000).toISOString(),
      },
    };
    await w.k.auditConsumer.handle(event);
    await w.k.auditConsumer.handle(event);
    const rows = AuditEntry.array().parse(
      (
        await w.get(w, '/v1/audit', {
          authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
        })
      ).json(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'service.call',
      actor_user_id: null,
      acting_tenant_id: null,
      caller_service: 'engagement',
      service: 'payments',
      decision: 'allowed',
    });
  });
});

// F14 / N7: the response schemas in contracts are READ by a test, so a response that drifts from
// what L5 and L3 build against fails here. Mutation: rename or drop a field of a response, add a
// secret to the credential list, return the tenant without its status.
describe('INV-EDGE-14 every response is the contract shape (F14)', () => {
  const as = async (w: Awaited<ReturnType<typeof world>>, tenantId: string, email: string) => ({
    authorization: `Bearer ${await w.tokenFor(tenantId, email)}`,
  });

  it('signup, login, staff, tenant view, credentials, audit, player lookup and launch parse with their schemas', async () => {
    const w = await world();
    const signup = await w.app.inject({
      method: 'POST',
      url: '/v1/operators/signup',
      payload: { tenant_name: 'C', slug: 'cc', email: 'boss@c.test', password: PW },
    });
    expect(signup.statusCode).toBe(201);
    const created = SignupResponse.parse(signup.json());
    expect(created.tenant.slug).toBe('cc');
    expect(created.user.email).toBe('boss@c.test');
    expect(JSON.stringify(signup.json())).not.toMatch(/password/i);

    const login = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { host: 'a.mio.test' },
      payload: { email: 'boss@a.test', password: PW },
    });
    expect(TokenResponse.parse(login.json()).token_type).toBe('Bearer');

    const admin = await as(w, w.a.tenant.id, 'boss@a.test');
    const staff = await w.get(w, '/v1/staff', admin);
    expect(
      StaffMember.array()
        .parse(staff.json())
        .map((s) => s.email),
    ).toEqual(['boss@a.test']);
    const tenant = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, admin);
    expect(TenantView.parse(tenant.json())).toMatchObject({ id: w.a.tenant.id, status: 'active' });

    const issued = await w.app.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: admin,
      payload: { platform: 'sim-casino' },
    });
    expect(issued.statusCode).toBe(201);
    const key = CredentialIssued.parse(issued.json());
    const listed = await w.get(w, '/v1/credentials', admin);
    const summaries = CredentialSummary.array().parse(listed.json()); // strict: no key, no secret
    expect(summaries.map((s) => s.key_id)).toEqual([key.key_id]);
    expect(listed.body).not.toContain(key.api_key);
    expect(listed.body).not.toContain(key.hmac_secret);

    const audit = await w.get(w, '/v1/audit', admin);
    expect(audit.statusCode).toBe(200);
    AuditEntry.array().parse(audit.json());

    const { user_id } = await w.k.players.resolveOrCreate(w.a.tenant.id, 'sim-casino', 'ext-7');
    const lookup = await w.get(w, `/v1/players/${user_id}`, admin);
    expect(PlayerLookup.parse(lookup.json())).toMatchObject({
      user_id,
      platform: 'sim-casino',
      external_player_id: 'ext-7',
    });

    const launch = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/launch',
      payload: {
        token: signLaunchToken({
          keyId: key.key_id,
          secret: key.hmac_secret,
          now: w.k.now(),
          externalPlayerId: 'ext-8',
        }),
      },
    });
    expect(launch.statusCode).toBe(200);
    expect(LaunchResponse.parse(launch.json())).toMatchObject({ tenant_id: w.a.tenant.id });
  });
});

const ROUTE_PATH = 'path';
const routePath = (ctrl: unknown, handler: object): string =>
  `/${[Reflect.getMetadata(ROUTE_PATH, ctrl as object), Reflect.getMetadata(ROUTE_PATH, handler)]
    .filter((p) => typeof p === 'string' && p !== '/')
    .join('/')}`.replace(/\/+/g, '/');

describe('INV-PERM: every route declares its permission; undeclared is denied', () => {
  const methodsOf = (ctrl: new (...a: never[]) => unknown) =>
    Object.getOwnPropertyNames(ctrl.prototype)
      .filter((n) => n !== 'constructor')
      .map((n) => ({
        name: n,
        handler: ctrl.prototype[n as keyof typeof ctrl.prototype] as unknown as object,
      }))
      .filter(
        ({ handler }) => typeof handler === 'function' && Reflect.hasMetadata(ROUTE_PATH, handler),
      );

  // Mutation: add a route without @RequirePermission or @Public.
  it('INV-PERM-1 every handler of every identity controller has a permission or is @Public', () => {
    const undeclared: string[] = [];
    let seen = 0;
    for (const ctrl of identityControllers) {
      for (const { name, handler } of methodsOf(ctrl)) {
        seen++;
        const declared = Reflect.getMetadata(PERMISSION_KEY, handler) !== undefined;
        const isPublic =
          Reflect.getMetadata(IS_PUBLIC, handler) === true ||
          Reflect.getMetadata(IS_PUBLIC, ctrl) === true;
        // /internal/v1 routes are service-token routes: no user permission applies (D-4);
        // INV-S2S-6 pins that exactly the contracted internal routes exist.
        const isInternal = routePath(ctrl, handler).startsWith('/internal/v1/');
        if (!declared && !isPublic && !isInternal) undeclared.push(`${ctrl.name}.${name}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(undeclared).toEqual([]);
  });

  // Mutation: PermissionGuard allows a handler with no metadata.
  it('INV-PERM-2 PermissionGuard denies a route with no declared permission (403)', async () => {
    @Controller('probe')
    class Probe {
      @Get()
      undeclared() {
        return 'leak';
      }
    }
    const w = await createTestApp({ extraControllers: [Probe] });
    const token = (
      await w.kernel.sessions.login(
        (
          await w.kernel.staff.signUpOperator({
            tenant_name: 'A',
            slug: 'a',
            email: 'boss@a.test',
            password: PW,
          })
        ).tenant.id,
        { email: 'boss@a.test', password: PW, audience: 'identity' },
      )
    ).access_token;
    const res = await w.app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(PermissionGuard).toBeDefined();
  });
});

describe('INV-S2S: service-to-service tokens and internal endpoints (D-4, MIO-046)', () => {
  const serviceToken = async (
    w: Awaited<ReturnType<typeof world>>,
    who: keyof typeof SERVICE_SECRETS = 'engagement',
    audience: string = 'identity',
    secret: string = SERVICE_SECRETS[who],
  ) =>
    w.app.inject({
      method: 'POST',
      url: '/v1/auth/service-token',
      payload: { client_id: who, client_secret: secret, audience },
    });
  const asService = async (
    w: Awaited<ReturnType<typeof world>>,
    who: keyof typeof SERVICE_SECRETS = 'engagement',
  ) => ({
    authorization: `Bearer ${(await serviceToken(w, who)).json().access_token}`,
  });

  // Mutation: put tid/roles on the service token, widen the TTL, or drop scope.
  it('INV-S2S-1 client credentials yield a token: sub svc:<name>, aud the target, scope internal, no tenant, TTL at most 300 s', async () => {
    const w = await world();
    const res = await serviceToken(w, 'engagement', 'identity');
    expect(res.statusCode).toBe(200);
    const body = TokenResponse.parse(res.json());
    expect(body.expires_in).toBeLessThanOrEqual(300);
    const claims = decodePayload(body.access_token);
    expect(ServiceTokenClaims.parse(claims)).toMatchObject({
      sub: 'svc:engagement',
      aud: 'identity',
      scope: 'internal',
    });
    expect(claims).not.toHaveProperty('tid');
    expect(claims).not.toHaveProperty('roles');
    expect(claims).not.toHaveProperty('act');
  });

  // Mutation: accept a wrong secret, another service's secret, or an unknown client; skip .strict().
  it('INV-S2S-2 a wrong secret, another service secret, or unknown client is 401 INVALID_SERVICE_CREDENTIALS; an extra field is 400', async () => {
    const w = await world();
    for (const res of [
      await serviceToken(w, 'engagement', 'identity', 'x'.repeat(30)),
      await serviceToken(w, 'engagement', 'identity', SERVICE_SECRETS.payments),
      await w.app.inject({
        method: 'POST',
        url: '/v1/auth/service-token',
        payload: {
          client_id: 'identity',
          client_secret: SERVICE_SECRETS.engagement,
          audience: 'payments',
        },
      }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'INVALID_SERVICE_CREDENTIALS' });
    }
    const extra = await w.app.inject({
      method: 'POST',
      url: '/v1/auth/service-token',
      payload: {
        client_id: 'engagement',
        client_secret: SERVICE_SECRETS.engagement,
        audience: 'identity',
        tenant_id: w.a.tenant.id,
      },
    });
    expect(extra.statusCode).toBe(400);
  });

  // Mutation: serve /internal/v1 to user tokens or to no token; return a wrong status.
  it('INV-S2S-3 tenant status: a service token reads it; a user token and no token are 401; suspension shows', async () => {
    const w = await world();
    const url = `/internal/v1/tenants/${w.a.tenant.id}/status`;
    const ok = await w.get(w, url, await asService(w));
    expect(ok.statusCode).toBe(200);
    expect(TenantStatusResponse.parse(ok.json())).toEqual({
      tenant_id: w.a.tenant.id,
      status: 'active',
    });
    expect(
      (
        await w.get(w, url, {
          authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}`,
        })
      ).statusCode,
    ).toBe(401);
    expect((await w.get(w, url)).statusCode).toBe(401);
    await w.k.tenants.setStatus(w.a.tenant.id, 'suspended');
    expect((await w.get(w, url, await asService(w))).json()).toMatchObject({ status: 'suspended' });
  });

  // N2 / D-14: an operator token must not reach an internal route through an encoded or dressed-up
  // path. Whatever identity's PermissionGuard recognises as "internal" is decided on the normalised
  // path, so `/%69nternal/` is the same route as `/internal/`.
  // Mutation: decide internal-or-not from the raw URL string in the entry point or in PermissionGuard.
  it('INV-S2S-3 an operator token on an encoded internal URL (/%69nternal/..., status, resolve, webhooks) is never served', async () => {
    const w = await world();
    const operator = { authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}` };
    for (const [method, url, payload] of [
      ['GET', `/%69nternal/v1/tenants/${w.b.tenant.id}/status`, undefined],
      ['GET', `/internal/v1/tenants/${w.b.tenant.id}/status?x=/v1/staff`, undefined],
      [
        'POST',
        `/%69nternal/v1/tenants/${w.b.tenant.id}/players/resolve`,
        { platform: 'sim-casino', external_player_id: 'ext-1' },
      ],
      ['GET', `/%69nternal/v1/tenants/${w.b.tenant.id}/integration`, undefined],
      ['GET', '/%69nternal/v1/integrations/by-slug/b', undefined],
    ] as const) {
      const res = await w.app.inject({ method, url, headers: operator, payload });
      expect([url, [401, 404].includes(res.statusCode)]).toEqual([url, true]);
    }
    expect(await w.k.players.links(w.b.tenant.id)).toEqual([]);
    // the same encoded URL with a real service token is the plain route (service mode)
    const ok = await w.get(w, `/%69nternal/v1/tenants/${w.b.tenant.id}/status`, await asService(w));
    expect(ok.statusCode).toBe(200);
  });

  // D-14, issue side: the client registry holds the audiences a client may ask for.
  // Mutation: issue a token for any audience to any authenticated client.
  it('INV-S2S-7 a client may only request the audiences of its allow-list: payments cannot get a token for engagement', async () => {
    const w = await world();
    const bad = await serviceToken(w, 'payments', 'engagement'); // not in SERVICE_CALL_POLICY.payments
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: 'INVALID_SERVICE_CREDENTIALS' });
    expect((await serviceToken(w, 'engagement', 'engagement')).statusCode).toBe(401);
    expect((await serviceToken(w, 'engagement', 'payments')).statusCode).toBe(200);
    expect((await serviceToken(w, 'payments', 'identity')).statusCode).toBe(200);
  });

  // D-14, callee side at identity: payments may read the tenant status and nothing else here.
  // Mutation: skip the per-client route allow-list in the entry point.
  it('INV-S2S-8 payments (status only) is 403 SERVICE_CALL_FORBIDDEN on resolve and integration; engagement may call all of them', async () => {
    const w = await world();
    const asPayments = await asService(w, 'payments');
    const resolve = await w.app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${w.a.tenant.id}/players/resolve`,
      headers: asPayments,
      payload: { platform: 'sim-casino', external_player_id: 'ext-1' },
    });
    expect(resolve.statusCode).toBe(403);
    expect(resolve.json()).toMatchObject({ code: 'SERVICE_CALL_FORBIDDEN' });
    expect(await w.k.players.links(w.a.tenant.id)).toEqual([]);
    const integration = await w.app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${w.a.tenant.id}/integration`,
      headers: asPayments,
    });
    expect(integration.statusCode).toBe(403);
    expect(integration.json()).toMatchObject({ code: 'SERVICE_CALL_FORBIDDEN' });
    expect(integration.body).not.toContain('webhook_secrets');
    expect(
      (await w.get(w, `/internal/v1/tenants/${w.a.tenant.id}/status`, asPayments)).statusCode,
    ).toBe(200);
  });

  // D-14 "every such call is audited" at the callee. Mutation: no audit.service_call event, or none when refused.
  it('INV-S2S-9 every internal call to identity writes one audit.service_call event, refused ones included', async () => {
    const w = await world();
    const asPayments = await asService(w, 'payments');
    const before = w.k.outbox.events().filter((e) => e.type === 'audit.service_call').length;
    await w.get(w, `/internal/v1/tenants/${w.a.tenant.id}/status`, asPayments);
    await w.app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${w.a.tenant.id}/players/resolve`,
      headers: asPayments,
      payload: { platform: 'sim-casino', external_player_id: 'ext-1' },
    });
    const events = w.k.outbox
      .events()
      .filter((e) => e.type === 'audit.service_call')
      .slice(before);
    expect(events).toHaveLength(2);
    expect(events.map((e) => ServiceCallAuditedV1.parse(e.payload))).toMatchObject([
      {
        caller_service: 'payments',
        service: 'identity',
        route: 'GET /internal/v1/tenants/:tenantId/status',
        decision: 'allowed',
        status: 200,
      },
      {
        caller_service: 'payments',
        route: 'POST /internal/v1/tenants/:tenantId/players/resolve',
        decision: 'refused',
        status: 403,
      },
    ]);
    expect(events.map((e) => e.tenant_id)).toEqual([w.a.tenant.id, w.a.tenant.id]);
  });

  // Mutation: take the tenant for resolve from the header or the body; skip resolveOrCreate.
  it('INV-S2S-4 resolve player: tenant from the path only; idempotent; the header is ignored; a body tenant_id is 400', async () => {
    const w = await world();
    const resolve = async (
      tenantId: string,
      extra: Record<string, string> = {},
      payload: object = {},
    ) =>
      w.app.inject({
        method: 'POST',
        url: `/internal/v1/tenants/${tenantId}/players/resolve`,
        headers: { ...(await asService(w)), ...extra },
        payload: { platform: 'sim-casino', external_player_id: 'ext-1', ...payload },
      });
    const first = await resolve(w.a.tenant.id, { 'x-tenant-id': w.b.tenant.id });
    expect(first.statusCode).toBe(200);
    const one = InternalResolvePlayerResponse.parse(first.json());
    expect(one.created).toBe(true);
    expect(InternalResolvePlayerResponse.parse((await resolve(w.a.tenant.id)).json())).toEqual({
      user_id: one.user_id,
      created: false,
    });
    expect(await w.k.players.links(w.a.tenant.id)).toHaveLength(1);
    expect(await w.k.players.links(w.b.tenant.id)).toEqual([]);
    const smuggled = await resolve(w.a.tenant.id, {}, { tenant_id: w.b.tenant.id });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  // X-7, D-15 Q-1. Mutation: serve the integration to a user token or another service, take the
  // tenant from the header, or return another tenant's secrets.
  it('INV-S2S-5 integration read: the tenant is the path tenant; the header is ignored; secrets go to svc:engagement only', async () => {
    const w = await world();
    const keyA = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'sandbox',
    });
    const eng = await asService(w);
    const get = (url: string, headers: Record<string, string>) =>
      w.app.inject({ method: 'GET', url, headers });
    const ok = await get(`/internal/v1/tenants/${w.a.tenant.id}/integration`, {
      ...eng,
      'x-tenant-id': w.b.tenant.id,
    });
    expect(ok.statusCode).toBe(200);
    expect(TenantIntegration.parse(ok.json())).toMatchObject({
      tenant_id: w.a.tenant.id,
      platform: 'sim-casino',
      environment: 'sandbox',
      webhook_secrets: [keyA.hmac_secret],
    });
    const bySlug = await get('/internal/v1/integrations/by-slug/a', eng);
    expect(TenantIntegration.parse(bySlug.json()).tenant_id).toBe(w.a.tenant.id);
    expect((await get('/internal/v1/integrations/by-slug/nope', eng)).statusCode).toBe(404);
    expect((await get(`/internal/v1/tenants/${w.a.tenant.id}/integration`, {})).statusCode).toBe(
      401,
    );
    const operator = { authorization: `Bearer ${await w.tokenFor(w.a.tenant.id, 'boss@a.test')}` };
    expect(
      (await get(`/internal/v1/tenants/${w.a.tenant.id}/integration`, operator)).statusCode,
    ).toBe(401);
  });

  // X-8. Reader test: the link written by resolve is the link this route returns. Mutation: read
  // another tenant's link, or keep returning it after the erasure deleted the mapping.
  it('INV-S2S-5b player link: returns what resolve stored, per tenant; 404 for another tenant or after erasure', async () => {
    const w = await world();
    const eng = await asService(w);
    const resolved = InternalResolvePlayerResponse.parse(
      (
        await w.app.inject({
          method: 'POST',
          url: `/internal/v1/tenants/${w.a.tenant.id}/players/resolve`,
          headers: eng,
          payload: { platform: 'sim-casino', external_player_id: 'ext-77' },
        })
      ).json(),
    );
    const link = (tenantId: string) =>
      w.app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/players/${resolved.user_id}/link`,
        headers: eng,
      });
    const own = await link(w.a.tenant.id);
    expect(own.statusCode).toBe(200);
    expect(PlayerLinkResponse.parse(own.json())).toEqual({
      platform: 'sim-casino',
      external_player_id: 'ext-77',
    });
    expect((await link(w.b.tenant.id)).statusCode).toBe(404);
    await w.k.players.erase(w.a.tenant.id, resolved.user_id);
    expect((await link(w.a.tenant.id)).statusCode).toBe(404);
  });

  // int/all review: identity epic review F5 is still open after the merge. `integration()` reports
  // ONE environment (the newest live credential's) and only that environment's secrets. A tenant
  // that holds a production credential and then issues a sandbox one (the X-3 flow) loses its
  // production webhook secret: production deposits fail the signature check, and whatever verifies
  // is taken as sandbox (unmetered, D-13). The integration must let engagement learn, for EVERY
  // live credential, its secret and that credential's environment, so `sandbox` is derived from the
  // key that verified (D-15 X-3). The shape is the coder's (per-environment lists, or entries with
  // an environment); this test finds the environment next to each secret, whichever shape is used.
  // Mutation: serve only the newest credential's environment (today's code).
  it('F5-1 with a production and a newer sandbox credential, the integration serves BOTH secrets, each with its own environment', async () => {
    const w = await world();
    const prod = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'production',
    });
    w.k.advance(5);
    const sbx = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'sandbox',
    });
    const res = await w.app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${w.a.tenant.id}/integration`,
      headers: await asService(w),
    });
    expect(res.statusCode).toBe(200);
    // the environment that sits next to a secret: {secret, environment} entries, or {<env>: [...]}
    const envOf = (node: unknown, secret: string, env?: string): string | undefined => {
      if (typeof node === 'string') return node === secret ? env : undefined;
      if (Array.isArray(node)) {
        for (const x of node) {
          const hit = envOf(x, secret, env);
          if (hit) return hit;
        }
        return undefined;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        const own = typeof obj.environment === 'string' ? obj.environment : env;
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'environment') continue;
          const scoped = k === 'production' || k === 'sandbox' ? k : own;
          const hit = envOf(v, secret, scoped);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    const body = res.json() as unknown;
    expect(envOf(body, prod.hmac_secret)).toBe('production');
    expect(envOf(body, sbx.hmac_secret)).toBe('sandbox');
  });

  // Mutation: add an internal route that is not in the contract, or drop one.
  // int/all review, D-23: the realtime gateway redeems tickets over a sixth internal route. The
  // list is pinned as a LITERAL too, so the contract constant and the controllers cannot drift
  // together (comparing the controllers only to INTERNAL_ROUTES passes when both lose a route).
  it('INV-S2S-6 the internal routes of identity are exactly the six in the contract (D-23 adds the ticket redeem)', () => {
    const found: string[] = [];
    for (const ctrl of identityControllers) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || !Reflect.hasMetadata(ROUTE_PATH, handler)) continue;
        const path = routePath(ctrl, handler);
        if (path.startsWith('/internal/v1/')) found.push(path);
      }
    }
    expect(found.sort()).toEqual(
      [
        '/internal/v1/integrations/by-slug/:slug',
        '/internal/v1/realtime-tickets/redeem',
        '/internal/v1/tenants/:tenantId/integration',
        '/internal/v1/tenants/:tenantId/players/:userId/link',
        '/internal/v1/tenants/:tenantId/players/resolve',
        '/internal/v1/tenants/:tenantId/status',
      ].sort(),
    );
    expect(found.sort()).toEqual(Object.values(INTERNAL_ROUTES).sort());
    // D-14: every internal route is in the allow-list of at least one client, and the allow-list
    // names no identity route that does not exist. Mutation: add an internal route nobody may call
    // (dead, or reachable only because the list is skipped), or list a route that is gone.
    const listed = new Set(
      Object.values(SERVICE_CALL_POLICY).flatMap((byAudience) =>
        (byAudience.identity ?? []).map((entry) => entry.split(' ')[1]),
      ),
    );
    expect([...listed].sort()).toEqual(Object.values(INTERNAL_ROUTES).sort());
  });
});
