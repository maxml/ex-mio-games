import { Injectable } from '@nestjs/common';
import type {
  BillingPlan,
  Invoice,
  PaymentAttempt,
  PaymentAttemptState,
  Subscription,
} from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v as Date).toISOString();

function toPlan(r: Row): BillingPlan {
  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    interval: 'month',
    price_minor: Number(r.price_minor),
    currency: r.currency as string,
  };
}

function toSubscription(r: Row): Subscription {
  return {
    id: r.id as string,
    plan_id: r.plan_id as string,
    status: r.status as Subscription['status'],
    provider: r.provider as string,
    provider_subscription_id: r.provider_subscription_id as string,
    provider_version: Number(r.provider_version),
    current_period_start: iso(r.current_period_start),
    current_period_end: iso(r.current_period_end),
  };
}

function toInvoice(r: Row): Invoice {
  return {
    id: r.id as string,
    subscription_id: r.subscription_id as string,
    amount_minor: Number(r.amount_minor),
    currency: r.currency as string,
    status: r.status as Invoice['status'],
    period_start: iso(r.period_start),
    period_end: iso(r.period_end),
  };
}

function toAttempt(r: Row): PaymentAttempt {
  return {
    id: r.id as string,
    plan_id: r.plan_id as string,
    subscription_id: (r.subscription_id as string | null) ?? null,
    state: r.state as PaymentAttemptState,
    card_last4: r.card_last4 as string,
    card_brand: r.card_brand as PaymentAttempt['card_brand'],
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** Data access of billing: plans (global), subscriptions, invoices, attempts, webhook dedupe. */
@Injectable()
export class BillingRepository {
  async plans(tx: Tx): Promise<BillingPlan[]> {
    const rows = (await tx.query(
      `SELECT id, code, name, price_minor, currency FROM billing_plans ORDER BY price_minor, code`,
    )) as Row[];
    return rows.map(toPlan);
  }

  async planById(tx: Tx, planId: string): Promise<BillingPlan | null> {
    const rows = (await tx.query(
      `SELECT id, code, name, price_minor, currency FROM billing_plans WHERE id = $1`,
      [planId],
    )) as Row[];
    return rows[0] ? toPlan(rows[0]) : null;
  }

  // ---- subscriptions --------------------------------------------------------------------------

  async insertSubscription(
    tx: Tx,
    row: {
      tenantId: string;
      id: string;
      planId: string;
      status: 'pending' | 'declined';
      provider: string;
      providerSubscriptionId: string;
      providerCustomerId: string;
      periodStart: Date;
      periodEnd: Date;
    },
  ): Promise<Subscription> {
    const rows = (await tx.query(
      `INSERT INTO subscriptions (tenant_id, id, plan_id, status, provider, provider_subscription_id,
         provider_customer_id, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, plan_id, status, provider, provider_subscription_id, provider_version, current_period_start, current_period_end`,
      [
        row.tenantId,
        row.id,
        row.planId,
        row.status,
        row.provider,
        row.providerSubscriptionId,
        row.providerCustomerId,
        row.periodStart,
        row.periodEnd,
      ],
    )) as Row[];
    return toSubscription(rows[0]!);
  }

  /** A subscription of the tenant, with the plan it was bought for. */
  async subscriptionByProviderId(
    tx: Tx,
    tenantId: string,
    provider: string,
    providerSubscriptionId: string,
  ): Promise<(Subscription & { plan_id: string }) | null> {
    const rows = (await tx.query(
      `SELECT id, plan_id, status, provider, provider_subscription_id, provider_version, current_period_start, current_period_end FROM subscriptions
        WHERE tenant_id = $1 AND provider = $2 AND provider_subscription_id = $3`,
      [tenantId, provider, providerSubscriptionId],
    )) as Row[];
    return rows[0] ? toSubscription(rows[0]) : null;
  }

  async subscriptionById(tx: Tx, tenantId: string, id: string): Promise<Subscription | null> {
    const rows = (await tx.query(
      `SELECT id, plan_id, status, provider, provider_subscription_id, provider_version, current_period_start, current_period_end FROM subscriptions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )) as Row[];
    return rows[0] ? toSubscription(rows[0]) : null;
  }

  async currentSubscription(
    tx: Tx,
    tenantId: string,
    statuses: readonly string[],
  ): Promise<Subscription | null> {
    const rows = (await tx.query(
      `SELECT id, plan_id, status, provider, provider_subscription_id, provider_version, current_period_start, current_period_end FROM subscriptions
        WHERE tenant_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantId, statuses],
    )) as Row[];
    return rows[0] ? toSubscription(rows[0]) : null;
  }

  /**
   * Apply a provider snapshot with ONE conditional UPDATE: an older (or equal) provider version never
   * overwrites a newer one. Returns false when the snapshot was superseded.
   */
  async applySnapshot(
    tx: Tx,
    tenantId: string,
    subscriptionId: string,
    snapshot: { status: string; version: number; periodStart: Date; periodEnd: Date },
  ): Promise<boolean> {
    const raw = (await tx.query(
      `UPDATE subscriptions SET status = $1, provider_version = $2, current_period_start = $3,
              current_period_end = $4, updated_at = now()
        WHERE tenant_id = $5 AND id = $6 AND provider_version < $2 RETURNING id`,
      [
        snapshot.status,
        snapshot.version,
        snapshot.periodStart,
        snapshot.periodEnd,
        tenantId,
        subscriptionId,
      ],
    )) as unknown[];
    const rows = (Array.isArray(raw[0]) ? raw[0] : raw) as Row[];
    return rows.length > 0;
  }

  async markCanceled(tx: Tx, tenantId: string, subscriptionId: string): Promise<void> {
    await tx.query(
      `UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, subscriptionId],
    );
  }

  // ---- invoices -------------------------------------------------------------------------------

  async insertInvoice(
    tx: Tx,
    row: {
      tenantId: string;
      id: string;
      subscriptionId: string;
      amountMinor: number;
      currency: string;
      status: 'paid' | 'failed';
      periodStart: Date;
      periodEnd: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO invoices (tenant_id, id, subscription_id, amount_minor, currency, status, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [
        row.tenantId,
        row.id,
        row.subscriptionId,
        row.amountMinor,
        row.currency,
        row.status,
        row.periodStart,
        row.periodEnd,
      ],
    );
  }

  async invoices(tx: Tx, tenantId: string): Promise<Invoice[]> {
    const rows = (await tx.query(
      `SELECT id, subscription_id, amount_minor, currency, status, period_start, period_end
         FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [tenantId],
    )) as Row[];
    return rows.map(toInvoice);
  }

  // ---- webhook dedupe -------------------------------------------------------------------------

  /** False when this provider event was already recorded (a redelivery). */
  async recordWebhookEvent(
    tx: Tx,
    tenantId: string,
    provider: string,
    eventId: string,
  ): Promise<boolean> {
    const rows = (await tx.query(
      `INSERT INTO billing_webhook_events (tenant_id, provider, event_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [tenantId, provider, eventId],
    )) as Row[];
    return rows.length > 0;
  }

  // ---- payment attempts -----------------------------------------------------------------------

  async insertAttempt(
    tx: Tx,
    row: {
      tenantId: string;
      id: string;
      planId: string;
      subscriptionId: string;
      state: PaymentAttemptState;
      last4: string;
      brand: string;
    },
  ): Promise<PaymentAttempt> {
    const rows = (await tx.query(
      `INSERT INTO payment_attempts (tenant_id, id, plan_id, subscription_id, state, card_last4, card_brand)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, plan_id, subscription_id, state, card_last4, card_brand, created_at, updated_at`,
      [row.tenantId, row.id, row.planId, row.subscriptionId, row.state, row.last4, row.brand],
    )) as Row[];
    return toAttempt(rows[0]!);
  }

  async attemptById(tx: Tx, tenantId: string, id: string): Promise<PaymentAttempt | null> {
    const rows = (await tx.query(
      `SELECT id, plan_id, subscription_id, state, card_last4, card_brand, created_at, updated_at FROM payment_attempts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )) as Row[];
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  async attemptBySubscription(
    tx: Tx,
    tenantId: string,
    subscriptionId: string,
  ): Promise<PaymentAttempt | null> {
    const rows = (await tx.query(
      `SELECT id, plan_id, subscription_id, state, card_last4, card_brand, created_at, updated_at FROM payment_attempts WHERE tenant_id = $1 AND subscription_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, subscriptionId],
    )) as Row[];
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  /**
   * Move an attempt with ONE conditional UPDATE (`WHERE state = <from>`): cancel and the success
   * webhook racing are decided here, by the database. Returns the attempt only for the winner.
   */
  async transitionAttempt(
    tx: Tx,
    tenantId: string,
    id: string,
    from: PaymentAttemptState,
    to: PaymentAttemptState,
  ): Promise<PaymentAttempt | null> {
    const raw = (await tx.query(
      `UPDATE payment_attempts SET state = $1, updated_at = now()
        WHERE tenant_id = $2 AND id = $3 AND state = $4 RETURNING id, plan_id, subscription_id, state, card_last4, card_brand, created_at, updated_at`,
      [to, tenantId, id, from],
    )) as unknown[];
    const rows = (Array.isArray(raw[0]) ? raw[0] : raw) as Row[];
    return rows[0] ? toAttempt(rows[0]) : null;
  }
}
