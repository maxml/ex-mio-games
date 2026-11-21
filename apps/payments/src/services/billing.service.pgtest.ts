import { createHmac } from 'node:crypto';
import { uuidv7 } from '@ex-mio/contracts';
import { IdempotencyMismatchError } from '@ex-mio/idempotency';
import { key, newTenant, openHarness, snapshotBody, type Harness } from '../testing/harness';

// Choke point: `BillingService` with the `fake` provider. The provider drives the subscription state
// ONLY through verified webhooks (MIO-093); `subscribe` creates a `pending` subscription at most.
// Spec: docs/specs/payments.md, section 9.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const OK = 'tok_4242';
const DECLINED = 'tok_0002';

async function plan(code: string) {
  const found = (await h.billing.listPlans()).find((p) => p.code === code);
  if (!found) throw new Error(`seed plan ${code} missing`);
  return found;
}

const subscribe = (t: string, planId: string, method = OK, k = key('sub')) =>
  h.as(t, () => h.billing.subscribe({ plan_id: planId, payment_method: method }, k));

/** Deliver a signed webhook the way the provider's HTTP call would reach the service: no tenant context. */
const webhook = (raw: string, signature = h.sign(raw)) => h.billing.handleWebhook(raw, signature);
/**
 * Deliver with EXACTLY this signature, no default. `webhook(raw, undefined)` cannot express "no
 * signature": a default parameter replaces `undefined` with a valid one (reviewer fix, Stage B).
 */
const webhookAs = (raw: string, signature: string | undefined) =>
  h.billing.handleWebhook(raw, signature);

const count = async (table: string, t: string, where = '') =>
  (
    await h.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 ${where}`, [
      t,
    ])
  ).rows[0].n as number;

describe('INV-P1 plans are one catalog with integer minor-unit prices', () => {
  // Mutation: store a price as a float/numeric(…,2), or seed a plan without a code.
  it('free, pro and scale are seeded with the pinned integer prices', async () => {
    const plans = await h.billing.listPlans();
    expect(plans.map((p) => [p.code, p.price_minor]).sort()).toEqual([
      ['free', 0],
      ['pro', 4900],
      ['scale', 19900],
    ]);
  });
});

describe('INV-P2 a test token decides the outcome; the subscription activates only from a webhook', () => {
  // Mutation: treat every token as accepted (ignore the 0002 decline), or activate in `subscribe`
  // from the synchronous result (MIO-093, MIO-150-14: the effect happens only in the callback).
  it('tok_4242: subscribe leaves it pending with no invoice; the verified webhook activates it and pays one invoice', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const out = await subscribe(t, pro.id);
    expect(out.body.status).toBe('pending');
    expect(await h.as(t, () => h.billing.listInvoices())).toEqual([]);
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'pending',
    });

    const raw = snapshotBody(t, out.body.provider_subscription_id, 'active', 1);
    expect(await webhook(raw)).toEqual({ outcome: 'applied' });
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'active',
      provider_version: 1,
    });
    const invoices = await h.as(t, () => h.billing.listInvoices());
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: 'paid', amount_minor: pro.price_minor });
  });

  it('tok_0002 is declined: no current subscription, a failed invoice, nothing paid', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const out = await subscribe(t, pro.id, DECLINED);
    expect(out.body.status).toBe('declined');
    expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull();
    expect((await h.as(t, () => h.billing.listInvoices())).map((i) => i.status)).toEqual([
      'failed',
    ]);
  });
});

describe('INV-P3 subscribing is idempotent', () => {
  // Mutation: skip runIdempotent in subscribe.
  it('the same key twice: one subscription, one provider checkout; a changed body is refused', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const scale = await plan('scale');
    const k = key('sub');
    const a = await subscribe(t, pro.id, OK, k);
    const b = await subscribe(t, pro.id, OK, k);
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(await count('subscriptions', t)).toBe(1);
    expect(h.provider.checkouts().filter((c) => c.tenantId === t)).toHaveLength(1);
    await expect(subscribe(t, scale.id, OK, k)).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it('an unknown plan is validation_failed and creates nothing', async () => {
    const t = newTenant();
    await expect(subscribe(t, uuidv7())).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await h.as(t, () => h.billing.listInvoices())).toEqual([]);
    expect(await count('subscriptions', t)).toBe(0);
  });
});

describe('INV-P4 billing data is tenant-isolated', () => {
  // Mutation: list invoices without the tenant transaction.
  it("tenant B sees none of tenant A's invoices or subscription", async () => {
    const a = newTenant();
    const b = newTenant();
    const out = await subscribe(a, (await plan('pro')).id);
    const raw = snapshotBody(a, out.body.provider_subscription_id, 'active', 1);
    await webhook(raw);
    expect(await h.as(b, () => h.billing.listInvoices())).toEqual([]);
    expect(await h.as(b, () => h.billing.currentSubscription())).toBeNull();
  });
});

describe('INV-P5 there is one tariff map: what is checked out is what is fulfilled (MIO-091, MIO-150-09)', () => {
  // Mutation: price the checkout from a second table or a constant, or fulfil the invoice from the
  // provider's claimed amount instead of the subscription's plan row.
  it.each(['free', 'pro', 'scale'])(
    'plan %s: the provider received the plan row; the invoice carries it',
    async (code) => {
      const t = newTenant();
      const row = await plan(code);
      const out = await subscribe(t, row.id);
      const checkout = h.provider.checkouts().filter((c) => c.tenantId === t);
      expect(checkout).toHaveLength(1);
      expect(checkout[0]!.plan).toEqual({
        code: row.code,
        priceMinor: row.price_minor,
        currency: row.currency,
      });
      // The webhook lies about the amount; the plan row is the only price we fulfil.
      const raw = snapshotBody(t, out.body.provider_subscription_id, 'active', 1, {
        amountMinor: 1,
      });
      await webhook(raw);
      expect(await h.as(t, () => h.billing.listInvoices())).toMatchObject([
        { amount_minor: row.price_minor, status: 'paid' },
      ]);
    },
  );
});

const VISA = '4242424242424242';
const MASTERCARD = '5555555555554444';
const DECLINED_CARD = '4000000000000002';

const createAttempt = (t: string, planId: string, card = VISA, k = key('att')) =>
  h.as(t, () => h.billing.createAttempt({ plan_id: planId, card_number: card }, k));
const cancelAttempt = (t: string, id: string, k = key('cancel')) =>
  h.as(t, () => h.billing.cancelAttempt(id, k));
const getAttempt = (t: string, id: string) => h.as(t, () => h.billing.getAttempt(id));
const providerSub = async (t: string) =>
  (
    await h.admin.query(
      `SELECT provider_subscription_id AS s FROM subscriptions WHERE tenant_id = $1`,
      [t],
    )
  ).rows[0].s as string;

describe('INV-A2 payment attempt lifecycle: processing | succeeded | declined | cancelled', () => {
  // Mutation: start an attempt in any state but processing, or decide the brand/last4 from anything but the card.
  it.each([
    [VISA, 'visa', '4242'],
    [MASTERCARD, 'mastercard', '4444'],
  ])(
    'card %s: a processing attempt that records only the brand and last4',
    async (card, brand, last4) => {
      const t = newTenant();
      const out = await createAttempt(t, (await plan('pro')).id, card);
      expect(out.body).toMatchObject({ state: 'processing', card_brand: brand, card_last4: last4 });
      expect(await getAttempt(t, out.body.id)).toMatchObject({
        id: out.body.id,
        state: 'processing',
      });
    },
  );

  // Mutation: accept any card number, or answer a decline as processing.
  it('the declining test card is declined at once; any other number is card_not_accepted and leaves nothing', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    expect((await createAttempt(t, pro.id, DECLINED_CARD)).body.state).toBe('declined');
    const before = await count('payment_attempts', t);
    await expect(createAttempt(t, pro.id, '4111111111111111')).rejects.toMatchObject({
      code: 'card_not_accepted',
    });
    expect(await count('payment_attempts', t)).toBe(before);
  });

  // Mutation: store, log into a body, hash or echo the number anywhere (attempt row, idempotency
  // record, subscription, invoice, outbox, webhook event).
  it('no table holds the full card number; the attempt keeps last4 and brand', async () => {
    const t = newTenant();
    const out = await createAttempt(t, (await plan('pro')).id, VISA);
    await webhook(snapshotBody(t, await providerSub(t), 'active', 1));
    const tables = (
      await h.admin.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')`,
      )
    ).rows.map((r) => r.relname as string);
    expect(tables).toContain('payment_attempts');
    for (const table of tables) {
      const { rows } = await h.admin.query(
        `SELECT x::text AS row FROM ${table} x WHERE x.tenant_id = $1`,
        [t],
      );
      for (const r of rows) expect(r.row).not.toContain(VISA);
    }
    expect(out.body.card_last4).toBe('4242');
  });

  // Mutation: skip runIdempotent, or hash the request WITH the card number into idempotency_keys.
  it('the same key twice is one attempt; the stored request hash does not depend on the number', async () => {
    const t = newTenant();
    const pro = await plan('pro');
    const k = key('att');
    const a = await createAttempt(t, pro.id, VISA, k);
    const b = await createAttempt(t, pro.id, VISA, k);
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(await count('payment_attempts', t)).toBe(1);
    // Same last4+brand, other number: the request is "the same" because the number is not hashed.
    await expect(createAttempt(t, pro.id, '4242424242424242', k)).resolves.toBeDefined();
  });

  it('a verified activation webhook makes the attempt succeeded and activates the subscription', async () => {
    const t = newTenant();
    const out = await createAttempt(t, (await plan('pro')).id);
    expect(await webhook(snapshotBody(t, await providerSub(t), 'active', 1))).toEqual({
      outcome: 'applied',
    });
    expect(await getAttempt(t, out.body.id)).toMatchObject({ state: 'succeeded' });
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'active',
    });
  });

  // Mutation: read the attempt without the tenant filter.
  it("another tenant's attempt is attempt_not_found", async () => {
    const out = await createAttempt(newTenant(), (await plan('pro')).id);
    await expect(getAttempt(newTenant(), out.body.id)).rejects.toMatchObject({
      code: 'attempt_not_found',
    });
    await expect(cancelAttempt(newTenant(), out.body.id)).rejects.toMatchObject({
      code: 'attempt_not_found',
    });
  });

  // Mutation: let cancel skip the provider, or move a terminal attempt.
  it('cancel: processing -> cancelled, the subscription is cancelled at the provider, repeat is the same answer', async () => {
    const t = newTenant();
    const out = await createAttempt(t, (await plan('pro')).id);
    const first = await cancelAttempt(t, out.body.id);
    expect(first.body.state).toBe('cancelled');
    expect((await h.provider.getSubscription(await providerSub(t))).status).toBe('canceled');
    expect((await cancelAttempt(t, out.body.id)).body.state).toBe('cancelled');
    expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull();
  });

  it('cancel of a succeeded or declined attempt is attempt_not_cancellable and changes nothing', async () => {
    const t = newTenant();
    const ok = await createAttempt(t, (await plan('pro')).id);
    await webhook(snapshotBody(t, await providerSub(t), 'active', 1));
    await expect(cancelAttempt(t, ok.body.id)).rejects.toMatchObject({
      code: 'attempt_not_cancellable',
    });
    expect(await getAttempt(t, ok.body.id)).toMatchObject({ state: 'succeeded' });
    const t2 = newTenant();
    const d = await createAttempt(t2, (await plan('pro')).id, DECLINED_CARD);
    await expect(cancelAttempt(t2, d.body.id)).rejects.toMatchObject({
      code: 'attempt_not_cancellable',
    });
    expect(await getAttempt(t2, d.body.id)).toMatchObject({ state: 'declined' });
  });

  // Mutation: apply a provider callback without looking at the attempt (a cancelled attempt captures).
  it('a late provider callback for a cancelled attempt is ignored: no activation, no invoice, still cancelled', async () => {
    const t = newTenant();
    const out = await createAttempt(t, (await plan('pro')).id);
    const sub = await providerSub(t);
    await cancelAttempt(t, out.body.id);
    expect(await webhook(snapshotBody(t, sub, 'active', 1))).toEqual({ outcome: 'ignored' });
    expect(await getAttempt(t, out.body.id)).toMatchObject({ state: 'cancelled' });
    expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull();
    expect(await count('invoices', t, `AND status = 'paid'`)).toBe(0);
    expect(await count('billing_webhook_events', t)).toBe(1); // recorded, so a redelivery is a duplicate
  });

  // Mutation: read the attempt state, then write it (check-then-act) instead of one conditional UPDATE.
  it('cancel racing the success webhook: one wins, and the books agree (6 rounds)', async () => {
    for (let i = 0; i < 6; i++) {
      const t = newTenant();
      const out = await createAttempt(t, (await plan('pro')).id);
      const raw = snapshotBody(t, await providerSub(t), 'active', 1);
      const settled = await Promise.allSettled(
        i % 2 === 0
          ? [cancelAttempt(t, out.body.id), webhook(raw)]
          : [webhook(raw), cancelAttempt(t, out.body.id)],
      );
      const state = (await getAttempt(t, out.body.id)).state;
      const paid = await count('invoices', t, `AND status = 'paid'`);
      const cancelled = settled.find((r) => r.status === 'rejected');
      if (state === 'succeeded') {
        expect(cancelled).toMatchObject({ reason: { code: 'attempt_not_cancellable' } });
        expect(paid).toBe(1);
        expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
          status: 'active',
        });
      } else {
        expect(state).toBe('cancelled');
        expect(cancelled).toBeUndefined();
        expect(paid).toBe(0);
        expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull();
      }
    }
  });
});

describe('INV-W1 webhooks: verified, deduplicated, ordered, and never swallowed', () => {
  // Mutation: apply before verifying, skip verification when a flag is set, or trust the body for the tenant.
  it('a bad or missing signature, or a tampered body, is refused and changes nothing (MIO-150-01)', async () => {
    const t = newTenant();
    const out = await subscribe(t, (await plan('pro')).id);
    const raw = snapshotBody(t, out.body.provider_subscription_id, 'active', 1);
    const sig = h.sign(raw);
    const otherSecret = createHmac('sha256', 'whsec_some_other_secret').update(raw).digest('hex');
    for (const attempt of [
      () => webhookAs(raw, 'nope'),
      () => webhookAs(raw, undefined),
      () => webhookAs(raw, ''),
      () => webhookAs(raw, sig.slice(0, 32)), // a prefix of the right signature
      () => webhookAs(raw, otherSecret), // well-formed, signed with another secret
      () => webhookAs(raw.replace('"version":1', '"version":2'), sig),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'invalid_signature' });
    }
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'pending',
    });
    expect(await count('billing_webhook_events', t)).toBe(0);
    expect(await count('invoices', t)).toBe(0);
  });

  // Mutation: dedupe in process memory (MIO-150-11), or apply the effect before the dedupe insert.
  it('the same provider event redelivered, also in parallel, has one effect (MIO-150-04)', async () => {
    const t = newTenant();
    const out = await subscribe(t, (await plan('pro')).id);
    const raw = snapshotBody(t, out.body.provider_subscription_id, 'active', 1, {
      eventId: 'evt_dup',
    });
    const results = await Promise.all([webhook(raw), webhook(raw), webhook(raw)]);
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(2);
    expect(await webhook(raw)).toEqual({ outcome: 'duplicate' });
    expect(await count('billing_webhook_events', t)).toBe(1);
    expect(await count('invoices', t)).toBe(1);
  });

  // Mutation: catch the error in the webhook path and answer success, or record the dedupe row in a
  // separate transaction (MIO-150-06/07).
  it('a failure while applying is thrown, rolls the dedupe row and the effect back, and the retry applies', async () => {
    const t = newTenant();
    const out = await subscribe(t, (await plan('pro')).id);
    const raw = snapshotBody(t, out.body.provider_subscription_id, 'active', 1);
    const fired = h.faultsFired();
    h.failAt('webhook_apply');
    await expect(webhook(raw)).rejects.toThrow(/injected fault/);
    expect(h.faultsFired()).toBe(fired + 1);
    expect(await count('billing_webhook_events', t)).toBe(0);
    expect(await count('invoices', t)).toBe(0);
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'pending',
    });
    expect(await webhook(raw)).toEqual({ outcome: 'applied' });
    expect(await count('invoices', t)).toBe(1);
  });

  // Mutation: write the new status unconditionally (no `WHERE provider_version < $new`).
  it('an older snapshot arriving late is recorded as superseded and changes nothing', async () => {
    const t = newTenant();
    const out = await subscribe(t, (await plan('pro')).id);
    const sub = out.body.provider_subscription_id;
    expect(await webhook(snapshotBody(t, sub, 'active', 2))).toEqual({ outcome: 'applied' });
    expect(await webhook(snapshotBody(t, sub, 'past_due', 1))).toEqual({ outcome: 'superseded' });
    expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
      status: 'active',
      provider_version: 2,
    });
    expect(await count('billing_webhook_events', t)).toBe(2); // both recorded, the old one inert
    // A newer one still lands.
    expect(await webhook(snapshotBody(t, sub, 'canceled', 3))).toEqual({ outcome: 'applied' });
    expect(await webhook(snapshotBody(t, sub, 'active', 2))).toEqual({ outcome: 'superseded' });
    expect(await h.as(t, () => h.billing.currentSubscription())).toBeNull(); // canceled: none current
  });

  // Mutation: read-then-write the status in JS instead of one conditional UPDATE.
  it('active v2 and past_due v1 applied at the same moment, either way round: active wins', async () => {
    for (let i = 0; i < 6; i++) {
      const t = newTenant();
      const out = await subscribe(t, (await plan('pro')).id);
      const sub = out.body.provider_subscription_id;
      const a = snapshotBody(t, sub, 'active', 2);
      const b = snapshotBody(t, sub, 'past_due', 1);
      await Promise.all(i % 2 === 0 ? [webhook(a), webhook(b)] : [webhook(b), webhook(a)]);
      expect(await h.as(t, () => h.billing.currentSubscription())).toMatchObject({
        status: 'active',
        provider_version: 2,
      });
    }
  });
});
