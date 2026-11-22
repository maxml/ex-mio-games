import {
  JwksResponse,
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ACCESS_TTL_MAX_SECONDS,
} from '@ex-mio/contracts';
import { decodeHeader, decodePayload } from '@ex-mio/service-kit/testing';
import { buildKernel } from './testing/kernel'; // RED: module does not exist yet

/*
 * Choke point: SessionsService (issue, JWKS, rotation, acting sessions) and the
 * shared verifier (service-kit/auth). Backlog: MIO-042, MIO-034.
 */

const PW = 'correct horse battery';
type K = Awaited<ReturnType<typeof buildKernel>>;

async function world(k: K) {
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
  const root = await k.staff.createPlatformAdmin({ email: 'root@mio.test', password: PW });
  const login = (
    tenantId: string,
    email: string,
    audience: 'web' | 'engagement' | 'payments' | 'identity' = 'identity',
  ) => k.sessions.login(tenantId, { email, password: PW, audience });
  return { a, b, platform, root, login };
}

describe('INV-JWT: our own RS256 token, verified by every service through JWKS', () => {
  // Mutation: serve the private key (or its members) in the JWKS.
  it('INV-JWT-1 JWKS is valid, RS256, public-only, and its kid matches the token header', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const jwks = k.sessions.jwks();
    expect(JwksResponse.safeParse(jwks).success).toBe(true);
    for (const key of jwks.keys) {
      for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi'])
        expect(key).not.toHaveProperty(secret);
    }
    const { access_token } = await w.login(w.a.tenant.id, 'boss@a.test');
    expect(decodeHeader(access_token)).toMatchObject({ alg: 'RS256', kid: jwks.keys[0]?.kid });
  });

  // Mutation: add a long-lived default TTL (e.g. 24 h).
  it('INV-JWT-2 claims carry sub, tid, roles, one audience and a TTL of at most 900 s', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const res = await w.login(w.a.tenant.id, 'boss@a.test', 'engagement');
    const p = decodePayload(res.access_token) as Record<string, number | string | string[]>;
    expect(p).toMatchObject({
      iss: 'ex-mio-identity',
      sub: w.a.user.id,
      tid: w.a.tenant.id,
      aud: 'engagement',
      roles: ['operator_admin'],
    });
    expect((p.exp as number) - (p.iat as number)).toBeLessThanOrEqual(ACCESS_TTL_MAX_SECONDS);
    expect(res.expires_in).toBe((p.exp as number) - (p.iat as number));
    await expect(k.verify(res.access_token, 'engagement')).resolves.toMatchObject({
      tid: w.a.tenant.id,
    });
    await expect(k.verify(res.access_token, 'payments')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  // Mutation: rotateKey drops the previous key from the JWKS immediately.
  it('INV-JWT-3 after rotation old tokens still verify until the old key is retired; new tokens use the new key', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const before = await w.login(w.a.tenant.id, 'boss@a.test');
    const oldKid = decodeHeader(before.access_token).kid;
    await k.sessions.rotateKey();
    const after = await w.login(w.a.tenant.id, 'boss@a.test');
    expect(decodeHeader(after.access_token).kid).not.toBe(oldKid);
    expect(k.sessions.jwks().keys.map((x) => x.kid)).toContain(oldKid);
    await expect(k.verify(before.access_token, 'identity')).resolves.toBeDefined();
    await expect(k.verify(after.access_token, 'identity')).resolves.toBeDefined();
    await k.sessions.retireKey(String(oldKid));
    await expect(k.verify(before.access_token, 'identity')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    await expect(k.verify(after.access_token, 'identity')).resolves.toBeDefined();
  });

  // N1 / D-14: the TTL is 900 s and the verifier allows 30 s of skew (INV-TOK-9), so the window ends
  // at exp + 30. The kernel's `verify` is the same verifier every service uses (spec section 7).
  // Probed one second inside (+929) and one second outside (+931), so a 901 s expiry (no leeway) and
  // a 300 s leeway both turn it red.
  // Mutation: skip the expiry check; drop the leeway; widen the leeway.
  it('INV-JWT-4 a 900 s token is still valid at +929 s and TOKEN_EXPIRED at +931 s', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const { access_token } = await w.login(w.a.tenant.id, 'boss@a.test');
    expect(ACCESS_TTL_MAX_SECONDS + ACCESS_TOKEN_CLOCK_SKEW_SECONDS).toBe(930);
    k.advance(929);
    await expect(k.verify(access_token, 'identity')).resolves.toBeDefined();
    k.advance(2);
    await expect(k.verify(access_token, 'identity')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  // Mutation: make `tid` optional in AccessTokenClaims (verifier accepts a token without it).
  it('INV-JWT-5 even a token signed with our real key is rejected when its claims are not a valid set', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const now = k.now();
    const base = {
      iss: 'ex-mio-identity',
      sub: w.a.user.id,
      aud: 'identity',
      iat: now,
      exp: now + 60,
      jti: 'jti-0000000001',
      roles: ['operator_admin'],
    };
    await expect(k.verify(k.sign(base), 'identity')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    }); // no tid
    await expect(
      k.verify(k.sign({ ...base, tid: w.a.tenant.id }), 'identity'),
    ).resolves.toBeDefined();
  });
});

describe('INV-ACT: platform admin acts on an operator tenant only through an explicit session', () => {
  // Mutation: issue the acting token without the act claim (or without platform_admin check).
  it('INV-ACT-1 a platform_admin gets a short-lived acting token naming the tenant and the reason', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const rootClaims = await k.verify(
      (await w.login(w.platform.id, 'root@mio.test')).access_token,
      'identity',
    );
    const res = await k.sessions.startActing(k.subjectOf(rootClaims), {
      tenant_id: w.a.tenant.id,
      reason: 'ticket 42',
    });
    const p = decodePayload(res.access_token) as {
      act: unknown;
      tid: string;
      roles: string[];
      exp: number;
      iat: number;
      sub: string;
    };
    expect(p.act).toEqual({ tenant_id: w.a.tenant.id, reason: 'ticket 42' });
    expect(p.tid).toBe(w.platform.id);
    expect(p.roles).toEqual(['platform_admin']);
    expect(p.sub).toBe(w.root.id);
    expect(p.exp - p.iat).toBeLessThanOrEqual(900);
    await expect(k.verify(res.access_token, 'identity')).resolves.toMatchObject({
      act: { tenant_id: w.a.tenant.id },
    });
  });

  // Mutation: allow operator_admin (or any non-platform role) to call startActing.
  it('INV-ACT-2 an operator admin cannot obtain acting for any tenant, its own included', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const admin = k.subjectOf(
      await k.verify((await w.login(w.a.tenant.id, 'boss@a.test')).access_token, 'identity'),
    );
    for (const target of [w.a.tenant.id, w.b.tenant.id, w.platform.id]) {
      await expect(
        k.sessions.startActing(admin, { tenant_id: target, reason: 'please' }),
      ).rejects.toMatchObject({ code: 'ACTING_FORBIDDEN' });
    }
  });

  // Mutation: accept a blank reason.
  it('INV-ACT-3 a request without a reason is ACTING_REASON_REQUIRED and starts nothing', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const root = k.subjectOf(
      await k.verify((await w.login(w.platform.id, 'root@mio.test')).access_token, 'identity'),
    );
    for (const reason of ['', '   ']) {
      await expect(
        k.sessions.startActing(root, { tenant_id: w.a.tenant.id, reason }),
      ).rejects.toMatchObject({ code: 'ACTING_REASON_REQUIRED' });
    }
    expect(await k.audit.list(w.a.tenant.id)).toEqual([]);
  });

  // Mutation: let an acting subject call startActing.
  it('INV-ACT-4 an acting session cannot create another acting session', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const root = k.subjectOf(
      await k.verify((await w.login(w.platform.id, 'root@mio.test')).access_token, 'identity'),
    );
    const acting = k.subjectOf(
      await k.verify(
        (await k.sessions.startActing(root, { tenant_id: w.a.tenant.id, reason: 'ticket 42' }))
          .access_token,
        'identity',
      ),
    );
    await expect(
      k.sessions.startActing(acting, { tenant_id: w.b.tenant.id, reason: 'hop' }),
    ).rejects.toMatchObject({ code: 'ACTING_FORBIDDEN' });
  });

  // N1 / D-14: same window as INV-JWT-4. Mutation: no TTL on the acting token, a longer TTL, or no leeway.
  it('INV-ACT-5 an acting session is valid at +929 s and TOKEN_EXPIRED at +931 s', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const root = k.subjectOf(
      await k.verify((await w.login(w.platform.id, 'root@mio.test')).access_token, 'identity'),
    );
    const { access_token } = await k.sessions.startActing(root, {
      tenant_id: w.a.tenant.id,
      reason: 'ticket 42',
    });
    k.advance(929);
    await expect(k.verify(access_token, 'identity')).resolves.toBeDefined();
    k.advance(2);
    await expect(k.verify(access_token, 'identity')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  // Mutation: acting on an unknown tenant creates a session anyway.
  it('INV-ACT-6 acting on an unknown tenant is NOT_FOUND', async () => {
    const k = await buildKernel();
    const w = await world(k);
    const root = k.subjectOf(
      await k.verify((await w.login(w.platform.id, 'root@mio.test')).access_token, 'identity'),
    );
    await expect(
      k.sessions.startActing(root, {
        tenant_id: '0190a1b2-c3d4-7e5f-8a6b-000000000000',
        reason: 'ticket',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
