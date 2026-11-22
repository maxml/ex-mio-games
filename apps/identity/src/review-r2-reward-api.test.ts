import 'reflect-metadata';
import type { Subject } from './services/access.service';
import { createTestApp } from './testing/app';

/*
 * D-31 R4 and the acting default, identity side of `PUT /v1/operator/integrations/:casino/reward-api`.
 *
 * R4-1: the https rule is keyed on the DEPLOYMENT (NODE_ENV=production), for every reward API, the
 *   sandbox endpoint included, and exempts REWARD_API_ALLOW_HOSTS. Outside production http is accepted.
 *   Mutation: key the rule on `input.environment === 'production'` again -> the sandbox case goes red.
 * ACT-1: an acting session is refused with AuthorizationRefused ACTING_FORBIDDEN and no row is written.
 *   Mutation: drop the `subject.acting` check in putRewardApi -> red.
 */

const PW = 'correct horse battery';

async function world() {
  const ctx = await createTestApp();
  const k = ctx.kernel;
  const a = await k.staff.signUpOperator({
    tenant_name: 'R2',
    slug: 'r2',
    email: 'boss@r2.test',
    password: PW,
  });
  const operator: Subject = { userId: a.user.id, tenantId: a.tenant.id, roles: ['operator_admin'] };
  await k.credentials.issue(a.tenant.id, 'sim-casino', { environment: 'production' });
  return { k, a, operator };
}

describe('D-31 R4 the https rule is the deployment, for every reward API', () => {
  const saved = { env: process.env.NODE_ENV, allow: process.env.REWARD_API_ALLOW_HOSTS };
  const restore = (k: 'NODE_ENV' | 'REWARD_API_ALLOW_HOSTS', v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    restore('NODE_ENV', saved.env);
    restore('REWARD_API_ALLOW_HOSTS', saved.allow);
  });
  const put = async (environment: 'production' | 'sandbox', base_url: string) => {
    const w = await world();
    // the sandbox endpoint is served beside a production one, so register that first (https)
    await w.k.credentials.putRewardApi(w.operator, 'sim-casino', {
      environment: 'production',
      base_url: 'https://rewards.casino.example/v1',
    });
    return w.k.credentials.putRewardApi(w.operator, 'sim-casino', { environment, base_url }).then(
      () => 'accepted',
      () => 'refused',
    );
  };

  it('R4-1 in a production deployment http is refused for sandbox and production alike; allow-listed hosts pass', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REWARD_API_ALLOW_HOSTS;
    expect(await put('production', 'http://rewards.casino.example/v1')).toBe('refused');
    expect(await put('sandbox', 'http://sandbox.rewards.casino.example/v1')).toBe('refused');
    expect(await put('sandbox', 'https://sandbox.rewards.casino.example/v1')).toBe('accepted');
    process.env.REWARD_API_ALLOW_HOSTS = 'casino-sim';
    expect(await put('production', 'http://casino-sim:4100/v1')).toBe('accepted');
    expect(await put('sandbox', 'http://casino-sim:4100/v1')).toBe('accepted');
  });

  it('R4-2 outside a production deployment http is accepted (the staging case)', async () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.REWARD_API_ALLOW_HOSTS;
    expect(await put('production', 'http://rewards.casino.example/v1')).toBe('accepted');
  });
});

describe('D-31 acting staff cannot register a reward API', () => {
  it('ACT-1 an acting platform admin is refused and nothing is written', async () => {
    const w = await world();
    const acting: Subject = {
      userId: w.operator.userId,
      tenantId: w.operator.tenantId,
      roles: ['operator_admin'],
      acting: { tenantId: w.a.tenant.id, reason: 'support ticket' },
    };
    await expect(
      w.k.credentials.putRewardApi(acting, 'sim-casino', {
        environment: 'production',
        base_url: 'https://rewards.casino.example/v1',
      }),
    ).rejects.toMatchObject({ code: 'ACTING_FORBIDDEN' });
    expect((await w.k.credentials.integration(w.a.tenant.id)).reward_api).toBeUndefined();
  });
});
