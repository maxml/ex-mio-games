import 'reflect-metadata';
import { uuidv7 } from '@ex-mio/contracts';
import {
  captureProductEvents,
  inFakeTransaction,
  type ProductEventCapture,
} from '@ex-mio/logger/testing';
import type { Db } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import { BillingService } from './services/billing.service';
import { LedgerService } from './services/ledger.service';
import { FakePaymentProvider } from './services/providers/fake.provider';
import { NO_FAULTS, type LedgerFaults } from './model/ledger.faults';
import type { BillingRepository } from './model/billing.repository';
import type { LedgerRepository } from './model/ledger.repository';

/*
 * Product analytics at the payments choke points (D-19): BillingService.start (plan_selected,
 * payment_failed on a refused card), BillingService.applyWebhook (payment_succeeded,
 * payment_failed), LedgerService.creditSpin (coins_credited). Every test runs the REAL service
 * method; only the repository and the database transaction are in-memory. The transaction is
 * driven like TypeORM drives a real one (commit and rollback reach the connection's subscribers),
 * so an event written before the commit, or one that survives a rollback, is seen here.
 *
 * Mutations that must turn these red: emit before the commit (call emitProductEvent directly
 * instead of through afterCommit) -> the rollback tests fail; add an email to a prop -> the
 * no-PII test fails and the capture helper rejects the line.
 */

const TENANT = uuidv7();
const PLAYER = uuidv7();
const OPERATOR = uuidv7();
const PLAN = {
  id: uuidv7(),
  code: 'starter',
  name: 'Starter',
  price_minor: 4900,
  currency: 'EUR',
};

let cap: ProductEventCapture;
beforeEach(() => {
  cap = captureProductEvents();
});
afterEach(() => cap.stop());

const fakeDb = {
  tenantTx: (fn: (tx: never) => Promise<unknown>) => inFakeTransaction(fn),
  idempotent: async (call: {
    effect: (tx: never) => Promise<{ status: number; body: unknown }>;
  }) => ({
    ...(await inFakeTransaction(call.effect)),
    replayed: false,
  }),
  publish: async () => undefined,
} as unknown as Db;

function billing(overrides: Partial<Record<keyof BillingRepository, unknown>> = {}) {
  const sub = {
    id: uuidv7(),
    plan_id: PLAN.id,
    status: 'pending',
    provider: 'fake',
    provider_subscription_id: 'sub_x',
    provider_version: 0,
    current_period_start: new Date().toISOString(),
    current_period_end: new Date().toISOString(),
  };
  const repo = {
    planById: async () => PLAN,
    insertSubscription: async (
      _tx: unknown,
      row: { status: string; providerSubscriptionId: string },
    ) => ({
      ...sub,
      status: row.status,
      provider_subscription_id: row.providerSubscriptionId,
    }),
    insertInvoice: async () => undefined,
    insertAttempt: async (_tx: unknown, row: Record<string, unknown>) => ({ id: row.id, ...row }),
    recordWebhookEvent: async () => true,
    subscriptionByProviderId: async () => sub,
    attemptBySubscription: async () => null,
    applySnapshot: async () => true,
    ...overrides,
  } as unknown as BillingRepository;
  const provider = new FakePaymentProvider({ webhookSecret: 'whsec_test' });
  const faults: LedgerFaults = NO_FAULTS;
  return { service: new BillingService(fakeDb, repo, provider, faults), provider };
}

const asOperator = <T>(fn: () => T): T =>
  runWithTenant({ tenantId: TENANT, principalId: OPERATOR }, fn);

const snapshot = (status: 'active' | 'past_due' | 'canceled') => ({
  eventId: `evt_${uuidv7()}`,
  tenantId: TENANT,
  subscriptionId: 'sub_x',
  status,
  version: 1,
  amountMinor: 1,
  currency: 'EUR',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
});

describe('payments product events: billing', () => {
  it('subscribe emits exactly one payments.plan_selected, with the price from the plan row', async () => {
    const { service } = billing();
    await asOperator(() =>
      service.subscribe({ plan_id: PLAN.id, payment_method: 'tok_4242' }, 'k1'),
    );
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'payments.plan_selected',
      tenant_id: TENANT,
      actor_type: 'operator',
      actor_id: OPERATOR,
      props: { plan_code: 'starter', amount_minor: 4900, currency: 'EUR' },
    });
  });

  it('a declined card emits plan_selected and payment_failed, never the card token', async () => {
    const { service } = billing();
    await asOperator(() =>
      service.subscribe({ plan_id: PLAN.id, payment_method: 'tok_0002' }, 'k2'),
    );
    expect(cap.events().map((e) => e.event)).toEqual([
      'payments.plan_selected',
      'payments.payment_failed',
    ]);
    expect(cap.events()[1]?.props).toEqual({
      plan_code: 'starter',
      amount_minor: 4900,
      currency: 'EUR',
      reason: 'declined',
    });
    const text = JSON.stringify(cap.events());
    expect(text).not.toContain('tok_0002');
    expect(text).not.toMatch(/@/);
  });

  it('a checkout that rolls back emits nothing', async () => {
    const { service } = billing({
      insertSubscription: async () => {
        throw new Error('db down');
      },
    });
    await expect(
      asOperator(() => service.subscribe({ plan_id: PLAN.id, payment_method: 'tok_4242' }, 'k3')),
    ).rejects.toThrow('db down');
    expect(cap.events()).toEqual([]);
  });

  it('a failure after the plan was picked (card declined, invoice insert fails) emits nothing', async () => {
    const { service } = billing({
      insertInvoice: async () => {
        throw new Error('invoice insert failed');
      },
    });
    await expect(
      asOperator(() => service.subscribe({ plan_id: PLAN.id, payment_method: 'tok_0002' }, 'k4')),
    ).rejects.toThrow('invoice insert failed');
    expect(cap.events()).toEqual([]);
  });

  it('an applied active webhook emits exactly one payments.payment_succeeded for the service actor', async () => {
    const { service, provider } = billing();
    const raw = JSON.stringify(snapshot('active'));
    const result = await service.handleWebhook(raw, provider.sign(raw));
    expect(result).toEqual({ outcome: 'applied' });
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'payments.payment_succeeded',
      tenant_id: TENANT,
      actor_type: 'service',
      actor_id: 'payments',
      // priced from OUR plan row (4900), not from the callback's amountMinor (1)
      props: { plan_code: 'starter', amount_minor: 4900, currency: 'EUR' },
    });
  });

  it('a past_due webhook emits payments.payment_failed; a duplicate or superseded one emits nothing', async () => {
    const { service, provider } = billing();
    const raw = JSON.stringify(snapshot('past_due'));
    await service.handleWebhook(raw, provider.sign(raw));
    expect(cap.events()).toHaveLength(1);
    expect(cap.events()[0]).toMatchObject({
      event: 'payments.payment_failed',
      props: { reason: 'past_due', amount_minor: 4900 },
    });

    cap.clear();
    const dup = billing({ recordWebhookEvent: async () => false });
    const raw2 = JSON.stringify(snapshot('active'));
    expect(await dup.service.handleWebhook(raw2, dup.provider.sign(raw2))).toEqual({
      outcome: 'duplicate',
    });
    const old = billing({ applySnapshot: async () => false });
    expect(await old.service.handleWebhook(raw2, old.provider.sign(raw2))).toEqual({
      outcome: 'superseded',
    });
    expect(cap.events()).toEqual([]);
  });

  it('a webhook transaction that rolls back emits nothing', async () => {
    const { provider } = billing();
    const failing = new BillingService(
      fakeDb,
      {
        planById: async () => PLAN,
        insertInvoice: async () => undefined,
        recordWebhookEvent: async () => true,
        subscriptionByProviderId: async () => ({ id: uuidv7(), plan_id: PLAN.id }),
        attemptBySubscription: async () => null,
        applySnapshot: async () => true,
      } as unknown as BillingRepository,
      provider,
      {
        hit: async (point: string) => {
          if (point === 'webhook_apply') throw new Error('fault at webhook_apply');
        },
      } as LedgerFaults,
    );
    const raw = JSON.stringify(snapshot('active'));
    await expect(failing.handleWebhook(raw, provider.sign(raw))).rejects.toThrow('fault at');
    expect(cap.events()).toEqual([]);
  });
});

describe('payments product events: ledger', () => {
  function ledger(overrides: Partial<Record<keyof LedgerRepository, unknown>> = {}) {
    const repo = {
      journalByOperation: async () => null,
      ensureSystemAccounts: async () => ({ issuance: uuidv7() }),
      ensureWallet: async () => ({ available: uuidv7() }),
      insertJournal: async () => true,
      insertLegs: async () => undefined,
      applyDelta: async () => 1,
      ...overrides,
    } as unknown as LedgerRepository;
    return new LedgerService(fakeDb, repo, NO_FAULTS);
  }
  const credit = (sandbox: boolean) => ({
    tenantId: TENANT,
    spinId: uuidv7(),
    playerId: PLAYER,
    amount: 25,
    sandbox,
  });

  it('creditSpin emits exactly one payments.coins_credited after the commit, with the environment', async () => {
    const service = ledger();
    await inFakeTransaction((tx) => service.creditSpin(tx, credit(true)));
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'payments.coins_credited',
      tenant_id: TENANT,
      actor_type: 'player',
      actor_id: PLAYER,
      props: { source: 'spin', coins: 25, sandbox: true },
    });
  });

  it('is silent until the commit', async () => {
    const service = ledger();
    const { fakeTransaction } = await import('@ex-mio/logger/testing');
    const t = fakeTransaction();
    await service.creditSpin(t.tx as never, credit(false));
    expect(cap.events()).toEqual([]);
    await t.commit();
    expect(cap.events()).toHaveLength(1);
  });

  it('a rolled-back credit, or a replay of the same spin, emits nothing', async () => {
    const failing = ledger({
      applyDelta: async () => {
        throw new Error('balance update failed');
      },
    });
    await expect(inFakeTransaction((tx) => failing.creditSpin(tx, credit(false)))).rejects.toThrow(
      'balance update failed',
    );
    expect(cap.events()).toEqual([]);

    const replayed = ledger({
      journalByOperation: async () => ({ id: uuidv7() }),
      awardOf: async () => ({ amount: 25, sandbox: false, playerId: PLAYER }),
    });
    const spin = credit(false);
    const res = await inFakeTransaction((tx) => replayed.creditSpin(tx, spin));
    expect(res.created).toBe(false);
    expect(cap.events()).toEqual([]);
  });
});
