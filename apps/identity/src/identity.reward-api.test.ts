import 'reflect-metadata';
import { AuditEntry, RewardApiSummary, TenantIntegration } from '@ex-mio/contracts';
import { createTestApp } from './testing/app';

/*
 * D-27: `PUT /v1/operator/integrations/:casino/reward-api` and `reward_api` in TenantIntegration.
 * Choke points: the role guard (`credentials.rotate`, operator_admin only), the tenant of the
 * subject (never an input), the service that seals and serves the secret.
 */

const PW = 'correct horse battery';
const SERVICE_SECRETS = {
  engagement: 'engagement-test-secret-0001',
  payments: 'payments-test-secret-00001',
};
const BODY = { base_url: 'http://casino-sim:4004', api_key: 'sim-signing-secret-a' };

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
  const login = async (tenantId: string, email: string) =>
    (await k.sessions.login(tenantId, { email, password: PW, audience: 'identity' })).access_token;
  const adminA = await login(a.tenant.id, 'boss@a.test');
  const adminB = await login(b.tenant.id, 'boss@b.test');
  const invited = await ctx.app.inject({
    method: 'POST',
    url: '/v1/staff',
    headers: { authorization: `Bearer ${adminA}` },
    payload: { email: 'staff@a.test', password: PW, role: 'operator_staff' },
  });
  expect(invited.statusCode).toBe(201);
  const staffA = await login(a.tenant.id, 'staff@a.test');
  // A credential per tenant: the integration exists only for a tenant with a live credential.
  await k.credentials.issue(a.tenant.id, 'casino-a');
  await k.credentials.issue(b.tenant.id, 'casino-a');
  const put = (token: string, casino: string, payload: unknown) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/v1/operator/integrations/${casino}/reward-api`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
  return { ...ctx, k, a, b, adminA, adminB, staffA, put };
}

describe('D-27 reward API of an operator integration', () => {
  // Mutation: drop `@RequirePermission` / the `credentials.rotate` check in putRewardApi.
  it('only operator_admin may set it: staff is 403, no token is 401, and nothing is stored', async () => {
    const w = await world();
    const staff = await w.put(w.staffA, 'casino-a', BODY);
    expect(staff.statusCode).toBe(403);
    expect(staff.json()).toMatchObject({ code: 'FORBIDDEN' });
    const anon = await w.app.inject({
      method: 'PUT',
      url: '/v1/operator/integrations/casino-a/reward-api',
      payload: BODY,
    });
    expect(anon.statusCode).toBe(401);
    expect(w.k.store.rewardApis).toHaveLength(0);
    expect((await w.put(w.adminA, 'casino-a', BODY)).statusCode).toBe(200);
  });

  // Mutation: remove the schema checks in the controller / contract.
  it.each([
    ['a non-URL base_url', { ...BODY, base_url: 'not a url' }],
    ['a non-http scheme', { ...BODY, base_url: 'ftp://casino.example' }],
    ['an empty api_key', { ...BODY, api_key: '' }],
    ['an unknown field (a tenant id)', { ...BODY, tenant_id: 'anything' }],
    ['an unknown environment', { ...BODY, environment: 'staging' }],
    ['an issue deadline under the minimum', { ...BODY, issue_deadline_ms: 10 }],
  ])('rejects %s with 400 VALIDATION_FAILED and stores nothing', async (_n, payload) => {
    const w = await world();
    const res = await w.put(w.adminA, 'casino-a', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(w.k.store.rewardApis).toHaveLength(0);
  });

  it('rejects a casino name that is not a slug', async () => {
    const w = await world();
    const res = await w.put(w.adminA, 'Casino%20A!', BODY);
    expect(res.statusCode).toBe(400);
    expect(w.k.store.rewardApis).toHaveLength(0);
  });

  it('the answer never carries the secret, and the secret is sealed at rest', async () => {
    const w = await world();
    const res = await w.put(w.adminA, 'casino-a', BODY);
    expect(res.statusCode).toBe(200);
    expect(RewardApiSummary.parse(res.json())).toEqual({
      platform: 'casino-a',
      environment: 'production',
      base_url: BODY.base_url,
      has_api_key: true,
      issue_deadline_ms: null,
    });
    expect(res.body).not.toContain(BODY.api_key);
    const stored = JSON.stringify(w.k.store.rewardApis);
    expect(stored).not.toContain(BODY.api_key);
  });

  // Mutation: serve `reward_api` from rows of every tenant (drop the tenant filter in rewardApiOf).
  it('tenant isolation: an operator sets and is served its own reward API only; the path and body name no tenant', async () => {
    const w = await world();
    expect((await w.put(w.adminA, 'casino-a', BODY)).statusCode).toBe(200);
    const bOwn = { base_url: 'https://b.example', api_key: 'b-secret' };
    expect((await w.put(w.adminB, 'casino-a', bOwn)).statusCode).toBe(200);
    // A repository that returned every tenant's rows (a missing WHERE, a missing RLS) must not leak.
    const real = w.k.store.repos().rewardApis;
    const all = w.k.store.rewardApis;
    const leaky = { ...real, list: async () => all.map((r) => ({ ...r })) };
    const repos = (w.k.credentials as unknown as { repos: { rewardApis: unknown } }).repos;
    const keep = repos.rewardApis;
    repos.rewardApis = leaky;
    try {
      const ia = await w.k.credentials.integration(w.a.tenant.id);
      const ib = await w.k.credentials.integration(w.b.tenant.id);
      expect(ia.reward_api).toMatchObject({ base_url: BODY.base_url, api_key: BODY.api_key });
      expect(ib.reward_api).toMatchObject({ base_url: bOwn.base_url, api_key: bOwn.api_key });
    } finally {
      repos.rewardApis = keep;
    }
    // Each tenant's row is stored under its own tenant id.
    expect(w.k.store.rewardApis.map((r) => r.tenant_id).sort()).toEqual(
      [w.a.tenant.id, w.b.tenant.id].sort(),
    );
  });

  it('is served in TenantIntegration as reward_api for the credential platform, secret opened', async () => {
    const w = await world();
    expect((await w.k.credentials.integration(w.a.tenant.id)).reward_api).toBeUndefined();
    expect(
      (await w.put(w.adminA, 'casino-a', { ...BODY, issue_deadline_ms: 120_000 })).statusCode,
    ).toBe(200);
    expect(
      (
        await w.put(w.adminA, 'casino-a', {
          environment: 'sandbox',
          base_url: 'http://sandbox.example',
          api_key: 'sbx-secret',
        })
      ).statusCode,
    ).toBe(200);
    const parsed = TenantIntegration.parse(await w.k.credentials.integration(w.a.tenant.id));
    expect(parsed.reward_api).toEqual({
      base_url: BODY.base_url,
      api_key: BODY.api_key,
      sandbox_base_url: 'http://sandbox.example',
      sandbox_api_key: 'sbx-secret',
      issue_deadline_ms: 120_000,
    });
    // A reward API of another casino is not served for this platform.
    expect((await w.put(w.adminA, 'casino-b', BODY)).statusCode).toBe(200);
    expect((await w.k.credentials.integration(w.a.tenant.id)).reward_api?.base_url).toBe(
      BODY.base_url,
    );
  });

  it('a sandbox endpoint needs the production one first, and a later PUT replaces the row', async () => {
    const w = await world();
    const sandbox = { environment: 'sandbox', base_url: 'http://sandbox.example' };
    expect((await w.put(w.adminA, 'casino-a', sandbox)).statusCode).toBe(400);
    expect((await w.put(w.adminA, 'casino-a', BODY)).statusCode).toBe(200);
    expect((await w.put(w.adminA, 'casino-a', sandbox)).statusCode).toBe(200);
    const next = { base_url: 'http://casino-sim:5000' };
    expect((await w.put(w.adminA, 'casino-a', next)).statusCode).toBe(200);
    const integration = await w.k.credentials.integration(w.a.tenant.id);
    expect(integration.reward_api?.base_url).toBe('http://casino-sim:5000');
    expect(integration.reward_api?.api_key).toBeUndefined();
    expect(w.k.store.rewardApis).toHaveLength(2);
  });

  // Mutation: drop `audit.recordChangeIn` from putRewardApi.
  it('is audited: one audit row per change naming the actor, with no secret in it', async () => {
    const w = await world();
    expect((await w.put(w.adminA, 'casino-a', BODY)).statusCode).toBe(200);
    expect((await w.put(w.staffA, 'casino-a', BODY)).statusCode).toBe(403);
    const res = await w.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${w.adminA}` },
    });
    const rows = (res.json() as unknown[]).map((r) => AuditEntry.parse(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'credentials.rotate',
      actor_user_id: w.a.user.id,
      actor_tenant_id: w.a.tenant.id,
      reason: 'reward-api casino-a production set',
    });
    expect(res.body).not.toContain(BODY.api_key);
    // Tenant B's audit log has nothing of A's change.
    const other = await w.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${w.adminB}` },
    });
    expect(other.json()).toEqual([]);
  });
});
