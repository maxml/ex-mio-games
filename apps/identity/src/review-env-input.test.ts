import 'reflect-metadata';
import { AuthorizationRefused } from '@ex-mio/service-kit';
import { decodePayload } from '@ex-mio/service-kit/testing';
import type { Subject } from './services/access.service';
import { createTestApp } from './testing/app';

/*
 * D-29 INV-ENV-INPUT (docs/specs/env-input.md section 4) and D-30, identity's choke points.
 *
 * INV-ENV-INPUT-4 (RED, spec #4 / F8, D-30 N1): a realtime ticket keeps the launch token's
 *   environment. A sandbox session's ticket carries `sbx: true`, its `launch_jti` row says
 *   `sandbox = true`, and the redeemed principal names the environment; production is false and
 *   DEFINED. Mutation: drop `sbx` in `issueRealtimeTicket` (or write the jti row with a constant) -> red.
 * INV-ENV-INPUT-9 (spec 4, reader): a durable record read back through its API shows the environment
 *   it was written with: a credential (list) and the reward API (the integration engagement reads).
 *   Mutation (re-applied in the review): `putRewardApi` stores `environment: 'production'` whatever the
 *   input -> 9b red. (The ticket record is 4; the redemption record is SBX-5 in engagement.)
 * D30-SUSP-1..3 (RED, D-30 F6): `TENANT_SUSPENDED` is an authorization refusal, thrown as
 *   AuthorizationRefused (so the entry point audits it `refused`; the mapping is pinned by INV-AUD-R*).
 *   Covers the realtime redeem (an audited service call), the launch exchange and the login.
 *   Mutation: throw `IdentityError('TENANT_SUSPENDED')` again at any of the three -> that one red.
 * D30-HTTPS-1 (RED, D-30 F1): a production reward API is https, unless its host is listed in
 *   REWARD_API_ALLOW_HOSTS (compose: casino-sim). Mutation: drop the scheme rule, or ignore the
 *   allow-list -> red.
 */

const PW = 'correct horse battery';

async function world(slug = 'ee') {
  const ctx = await createTestApp();
  const k = ctx.kernel;
  const a = await k.staff.signUpOperator({
    tenant_name: 'Env',
    slug,
    email: `boss@${slug}.test`,
    password: PW,
  });
  const operator: Subject = { userId: a.user.id, tenantId: a.tenant.id, roles: ['operator_admin'] };
  const launch = async (environment: 'production' | 'sandbox', player = 'ext-1') => {
    const key = await k.credentials.issue(a.tenant.id, 'sim-casino', { environment });
    return k.sessions.launchWithKey(key, { externalPlayerId: player });
  };
  const ticket = async (bearer: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/realtime-ticket',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {},
    });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { ticket: string }).ticket;
  };
  return { ...ctx, k, a, operator, launch, ticket };
}

const envOf = (o: unknown): 'sandbox' | 'production' | 'ABSENT' => {
  const r = o as { sandbox?: unknown; environment?: unknown; sbx?: unknown };
  if (r.sandbox === true || r.environment === 'sandbox' || r.sbx === true) return 'sandbox';
  if (r.sandbox === false || r.environment === 'production' || r.sbx === false) return 'production';
  return 'ABSENT';
};

describe('INV-ENV-INPUT-4 a realtime ticket keeps the environment of the launch (spec #4, D-30)', () => {
  it('INV-ENV-INPUT-4a a sandbox launch gives a sandbox ticket, a sandbox jti row and a sandbox principal', async () => {
    const w = await world();
    const session = await w.launch('sandbox');
    expect(decodePayload(session.access_token).sbx).toBe(true); // precondition: the session is sandbox
    const t = await w.ticket(session.access_token);
    const claims = decodePayload(t) as { sbx?: unknown; jti: string };
    expect(claims.sbx).toBe(true);
    const redeemed = await w.k.sessions.redeemRealtimeTicket(t);
    const row = w.k.store.jti.find((j) => j.jti === `rt:${claims.jti}`);
    expect(row?.sandbox).toBe(true);
    expect(envOf(redeemed)).toBe('sandbox');
  });

  it('INV-ENV-INPUT-4b a production launch gives a production ticket, row and a DEFINED production principal', async () => {
    const w = await world();
    const session = await w.launch('production');
    const t = await w.ticket(session.access_token);
    const claims = decodePayload(t) as { sbx?: unknown; jti: string };
    expect(claims.sbx === true).toBe(false);
    const redeemed = await w.k.sessions.redeemRealtimeTicket(t);
    expect(w.k.store.jti.find((j) => j.jti === `rt:${claims.jti}`)?.sandbox).toBe(false);
    expect(envOf(redeemed)).toBe('production');
  });
});

describe('INV-ENV-INPUT-9 a durable record is read back with the environment it was written with', () => {
  it('INV-ENV-INPUT-9a a credential issued for sandbox is listed as sandbox, one for production as production', async () => {
    const w = await world();
    const sbx = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'sandbox',
    });
    const prd = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'production',
    });
    const listed = await w.k.credentials.list(w.operator);
    expect(listed.find((c) => c.key_id === sbx.key_id)?.environment).toBe('sandbox');
    expect(listed.find((c) => c.key_id === prd.key_id)?.environment).toBe('production');
  });

  it('INV-ENV-INPUT-9b the reward API is served to engagement under the environment it was PUT for', async () => {
    const w = await world();
    const prd = 'https://rewards.casino.example/v1';
    const sbx = 'https://sandbox.rewards.casino.example/v1';
    await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', { environment: 'production' });
    await w.k.credentials.putRewardApi(w.operator, 'sim-casino', {
      environment: 'production',
      base_url: prd,
    });
    await w.k.credentials.putRewardApi(w.operator, 'sim-casino', {
      environment: 'sandbox',
      base_url: sbx,
    });
    const api = (await w.k.credentials.integration(w.a.tenant.id)).reward_api as Record<
      string,
      unknown
    >;
    expect(api.base_url).toBe(prd);
    expect(api.sandbox_base_url).toBe(sbx);
  });
});

describe('D30-SUSP TENANT_SUSPENDED is an AuthorizationRefused (D-30, F6)', () => {
  const suspend = (w: Awaited<ReturnType<typeof world>>) => {
    const t = w.k.store.tenants.get(w.a.tenant.id);
    if (!t) throw new Error('tenant row missing');
    t.status = 'suspended';
  };
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: unknown) =>
        e instanceof AuthorizationRefused
          ? `AuthorizationRefused:${e.code}`
          : `${(e as Error).constructor.name}:${(e as { code?: string }).code}`,
    );

  it('D30-SUSP-1 the realtime redeem (an audited service call) refuses a suspended tenant with the typed error', async () => {
    const w = await world();
    const t = await w.ticket((await w.launch('production')).access_token);
    suspend(w);
    expect(await refusal(w.k.sessions.redeemRealtimeTicket(t))).toBe(
      'AuthorizationRefused:TENANT_SUSPENDED',
    );
  });

  it('D30-SUSP-2 the launch exchange refuses a suspended tenant with the typed error', async () => {
    const w = await world();
    const key = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', {
      environment: 'production',
    });
    suspend(w);
    expect(await refusal(w.k.sessions.launchWithKey(key, { externalPlayerId: 'ext-9' }))).toBe(
      'AuthorizationRefused:TENANT_SUSPENDED',
    );
  });

  it('D30-SUSP-3 the login refuses a suspended tenant with the typed error', async () => {
    const w = await world();
    suspend(w);
    expect(
      await refusal(
        w.k.sessions.login(w.a.tenant.id, {
          email: `boss@ee.test`,
          password: PW,
          audience: 'identity',
        }),
      ),
    ).toBe('AuthorizationRefused:TENANT_SUSPENDED');
  });
});

// Fix round 2 (test owner): D-31 R4 defines "production" in D-30 as the DEPLOYMENT
// (NODE_ENV=production), so this test now runs in a production deployment. Under jest NODE_ENV is
// `test`, where http is allowed by the same rule, and the third assertion went red after 124a8c5.
// The property is unchanged: production http is refused, https passes, the allow-list is honoured.
// Mutation: `rewardApiRequiresHttps` returns false -> red.
describe('D30-HTTPS a production reward API is https unless the host is allow-listed (D-30, F1)', () => {
  const saved = process.env.REWARD_API_ALLOW_HOSTS;
  const savedNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.REWARD_API_ALLOW_HOSTS;
    else process.env.REWARD_API_ALLOW_HOSTS = saved;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });
  const put = async (base_url: string) => {
    const w = await world();
    return w.k.credentials
      .putRewardApi(w.operator, 'sim-casino', { environment: 'production', base_url })
      .then(
        () => 'accepted',
        () => 'refused',
      );
  };

  it('D30-HTTPS-1 production http is refused; https is accepted; http to an allow-listed host is accepted', async () => {
    process.env.REWARD_API_ALLOW_HOSTS = 'casino-sim';
    expect(await put('https://rewards.casino.example/v1')).toBe('accepted');
    expect(await put('http://casino-sim:4100/v1')).toBe('accepted');
    expect(await put('http://rewards.casino.example/v1')).toBe('refused');
    delete process.env.REWARD_API_ALLOW_HOSTS;
    expect(await put('http://casino-sim:4100/v1')).toBe('refused');
  });
});
