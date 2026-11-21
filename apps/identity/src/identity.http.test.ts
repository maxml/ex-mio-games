import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { IS_PUBLIC } from '@ex-mio/tenancy';
import { IdentityErrorBody, JwksResponse } from '@ex-mio/contracts';
import { accessClaims, generateRsaKey, signJwt } from '@ex-mio/service-kit/testing';
import { identityControllers } from './controllers'; // RED: module does not exist yet
import { PERMISSION_KEY, PermissionGuard } from './controllers/permissions'; // RED
import { createTestApp } from './testing/app'; // RED

/*
 * Choke point: the HTTP edge: TenantGuard + jwtTenantResolver (tenant from the
 * verified claim), PermissionGuard (default deny), controllers (zod first).
 * Routes are fixed in docs/specs/identity.md. Backlog: MIO-031, MIO-045, MIO-034.
 */

const PW = 'correct horse battery';
type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function world() {
  const ctx = await createTestApp();
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
        slug: 'c',
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

  // Mutation: acting token keeps working after expiry.
  it('INV-EDGE-11 an expired acting session is 401 TOKEN_EXPIRED and nothing is audited', async () => {
    const w = await world();
    const token = await actingToken(w, w.a.tenant.id);
    w.k.advance(901);
    const res = await w.get(w, `/v1/tenants/${w.a.tenant.id}`, {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect((await w.k.audit.list(w.a.tenant.id)).map((e) => e.action)).toEqual(['acting.start']);
  });
});

describe('INV-PERM: every route declares its permission; undeclared is denied', () => {
  const ROUTE_PATH = 'path';
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
        if (!declared && !isPublic) undeclared.push(`${ctrl.name}.${name}`);
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
