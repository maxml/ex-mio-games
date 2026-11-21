import { uuidv7 } from '@ex-mio/contracts';
import { IdempotencyMismatchError } from '@ex-mio/idempotency';
import { key, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `BillingService` with the default `fake` provider. Spec: docs/specs/payments.md, section 9.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const OK_CARD = '4242424242424242';
const DECLINED_CARD = '4000000000000002';

async function plan(code: string) {
  const plans = await h.billing.listPlans();
  const found = plans.find((p) => p.code === code);
  if (!found) throw new Error(`seed plan ${code} missing`);
  return found;
}

describe('INV-P1 plans are one catalog with integer minor-unit prices', () => {
  // Mutation: store a price as a float/numeric(…,2), or seed a plan without a code.
  it('free, pro and scale are seeded; prices are integers', async () => {
    const plans = await h.billing.listPlans();
    expect(plans.map((p) => p.code).sort()).toEqual(['free', 'pro', 'scale']);
    for (const p of plans) expect(Number.isInteger(p.price_minor)).toBe(true);
    expect((await plan('free')).price_minor).toBe(0);
  });
});

describe('INV-P2 a test card decides the outcome in the fake provider', () => {
  // Mutation: treat every card as accepted (ignore the 0002 decline).
  it('4242 activates the subscription and creates one paid invoice for the plan price', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const out = await h.as(t, () =>
      h.billing.subscribe({ plan_id: pro.id, card_number: OK_CARD }, key('sub')),
    );
    expect(out.body.status).toBe('active');
    const invoices = await h.as(t, () => h.billing.listInvoices());
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: 'paid', amount_minor: pro.price_minor });
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'active',
    });
  });

  it('a card ending 0002 is declined: no active subscription, a failed invoice, nothing paid', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const out = await h.as(t, () =>
      h.billing.subscribe({ plan_id: pro.id, card_number: DECLINED_CARD }, key('sub')),
    );
    expect(out.body.status).toBe('declined');
    expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull();
    const invoices = await h.as(t, () => h.billing.listInvoices());
    expect(invoices.map((i) => i.status)).toEqual(['failed']);
  });
});

describe('INV-P3 subscribing is idempotent', () => {
  // Mutation: skip runIdempotent in subscribe.
  it('the same key twice: one subscription, one invoice; a changed body is refused', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const scale = await plan('scale');
    const k = key('sub');
    const a = await h.as(t, () =>
      h.billing.subscribe({ plan_id: pro.id, card_number: OK_CARD }, k),
    );
    const b = await h.as(t, () =>
      h.billing.subscribe({ plan_id: pro.id, card_number: OK_CARD }, k),
    );
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(await h.as(t, () => h.billing.listInvoices())).toHaveLength(1);
    await expect(
      h.as(t, () => h.billing.subscribe({ plan_id: scale.id, card_number: OK_CARD }, k)),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it('an unknown plan is validation_failed and creates nothing', async () => {
    const t = newTenant();
    await expect(
      h.as(t, () => h.billing.subscribe({ plan_id: uuidv7(), card_number: OK_CARD }, key('sub'))),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.as(t, () => h.billing.listInvoices())).toEqual([]);
  });
});

describe('INV-P4 billing data is tenant-isolated', () => {
  // Mutation: list invoices without the tenant transaction (platformTx).
  it("tenant B sees none of tenant A's invoices or subscription", async () => {
    const a = newTenant();
    const b = newTenant();
    const pro = await plan('pro');
    await h.as(a, () => h.billing.subscribe({ plan_id: pro.id, card_number: OK_CARD }, key('sub')));
    expect(await h.as(b, () => h.billing.listInvoices())).toEqual([]);
    expect(await h.as(b, () => h.billing.currentSubscription())).toBeNull();
  });
});
