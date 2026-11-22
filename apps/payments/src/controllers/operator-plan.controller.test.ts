import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OperatorPlan } from '@ex-mio/contracts';
import { runWithTenant } from '@ex-mio/tenancy';
import { BillingService } from '../services/billing.service';
import { buildApp } from '../testing/app';
import { bearer, T, T_OTHER, tokens } from '../testing/auth';

// D-27: `GET /v1/operator/plan` through the REAL application module (entry point, role guard, acting
// guard, exception filter) with the billing service mocked. The query itself (the tenant scoping
// of the subscription read) is pinned by the second block over a recording repository.

const PLAN = {
  subscription_id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a40',
  status: 'pending',
  plan: { id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a41', code: 'pro', name: 'Pro' },
  provider: 'fake',
  provider_subscription_id: 'sub_fake_123',
  current_period_end: '2026-12-01T00:00:00.000Z',
} as const;

describe('GET /v1/operator/plan', () => {
  const billing = { operatorPlan: jest.fn() };
  let app: NestFastifyApplication;
  let audit: Array<{ type: string }>;
  beforeAll(async () => {
    const built = await buildApp({ billing });
    app = built.app;
    audit = built.auth.audit;
  });
  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  const get = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/operator/plan', headers });

  // Mutation: drop @RequireRoles('operator_admin') (or widen it to staff / players).
  it('is for operator_admin only: staff and players are 403, no token is 401, the service is not reached', async () => {
    for (const token of [tokens.staff(), tokens.player()]) {
      expect((await get(bearer(token))).statusCode).toBe(403);
    }
    expect((await get({})).statusCode).toBe(401);
    expect(billing.operatorPlan).not.toHaveBeenCalled();
  });

  it('returns the plan with the provider subscription id, in the contract shape', async () => {
    billing.operatorPlan.mockResolvedValueOnce(PLAN);
    const res = await get(bearer(tokens.operator()));
    expect(res.statusCode).toBe(200);
    expect(OperatorPlan.parse(res.json())).toEqual(PLAN);
  });

  it('is 404 no_subscription for a tenant with no current plan', async () => {
    billing.operatorPlan.mockResolvedValueOnce(null);
    const res = await get(bearer(tokens.operator()));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'no_subscription' });
  });

  // Mutation: let the request name a tenant (the service is called with arguments).
  it('the tenant is the verified token`s: a query or header naming another tenant changes nothing', async () => {
    billing.operatorPlan.mockResolvedValue(PLAN);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/operator/plan?tenant_id=${T_OTHER}`,
      headers: { ...bearer(tokens.operator(T)), 'x-tenant-id': T_OTHER },
    });
    expect(res.statusCode).toBe(200);
    expect(billing.operatorPlan).toHaveBeenCalledWith();
  });

  it('an acting platform admin is refused (not an operator_admin) and the attempt is audited', async () => {
    const before = audit.filter((e) => e.type === 'audit.acting_request').length;
    expect((await get(bearer(tokens.acting()))).statusCode).toBe(403);
    expect(audit.filter((e) => e.type === 'audit.acting_request').length).toBe(before + 1);
    expect(billing.operatorPlan).not.toHaveBeenCalled();
  });
});

describe('BillingService.operatorPlan', () => {
  const sub = {
    id: PLAN.subscription_id,
    plan_id: PLAN.plan.id,
    status: 'pending' as const,
    provider: 'fake',
    provider_subscription_id: 'sub_fake_123',
    provider_version: 0,
    current_period_start: '2026-11-01T00:00:00.000Z',
    current_period_end: PLAN.current_period_end,
  };
  const make = () => {
    const repo = {
      currentSubscription: jest.fn(async () => sub),
      planById: jest.fn(async () => ({
        ...PLAN.plan,
        interval: 'month',
        price_minor: 4900,
        currency: 'USD',
      })),
    };
    const db = { tenantTx: <R>(fn: (tx: unknown) => Promise<R>) => fn({}) };
    const service = new BillingService(db as never, repo as never, {} as never, {} as never);
    return { repo, service };
  };

  // Mutation: read the subscription of a tenant other than the ambient one.
  it('reads the subscription of the AMBIENT tenant only and maps it to the contract', async () => {
    const { repo, service } = make();
    const out = await runWithTenant({ tenantId: T, principalId: 'p' }, () =>
      service.operatorPlan(),
    );
    expect(repo.currentSubscription).toHaveBeenCalledWith(expect.anything(), T, [
      'pending',
      'active',
      'past_due',
    ]);
    expect(OperatorPlan.parse(out)).toEqual(PLAN);
    await runWithTenant({ tenantId: T_OTHER, principalId: 'p' }, () => service.operatorPlan());
    expect(repo.currentSubscription).toHaveBeenLastCalledWith(expect.anything(), T_OTHER, [
      'pending',
      'active',
      'past_due',
    ]);
  });

  it('is null when the tenant has no current subscription', async () => {
    const { repo, service } = make();
    repo.currentSubscription.mockResolvedValueOnce(null as never);
    expect(
      await runWithTenant({ tenantId: T, principalId: 'p' }, () => service.operatorPlan()),
    ).toBeNull();
  });
});
