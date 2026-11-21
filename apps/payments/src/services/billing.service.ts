import { Inject, Injectable } from '@nestjs/common';
import {
  uuidv7,
  type BillingPlan,
  type CreateAttemptRequest,
  type Invoice,
  type PaymentAttempt,
  type ProviderSnapshot,
  type Subscription,
  type SubscribeRequest,
  type WebhookResult,
} from '@ex-mio/contracts';
import type { IdempotentOutcome } from '@ex-mio/idempotency';
import { Db, type Tx } from '@ex-mio/service-kit';
import { currentTenant, runWithTenant } from '@ex-mio/tenancy';
import { BillingRepository } from '../model/billing.repository';
import { LEDGER_FAULTS, type LedgerFaults } from '../model/ledger.faults';
import { LedgerError } from './ledger.errors';
import {
  CardNotAcceptedError,
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './providers/payment-provider';

/** What `subscribe` leaves behind: the subscription, and whether the provider refused the token. */
interface Started {
  subscription: Subscription;
  declined: boolean;
}

/**
 * Operator billing through the `PaymentProvider` port (MIO-090, 091, 093, 098).
 *
 * `subscribe` and `createAttempt` only ever leave a `pending` (or `declined`) subscription: it becomes
 * `active` ONLY from a verified provider webhook, which is deduplicated by provider event id, ordered
 * by the provider's version (an older snapshot never overwrites a newer one) and priced from OUR plan
 * row, never from the amount the callback claims.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly repo: BillingRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(LEDGER_FAULTS) private readonly faults: LedgerFaults,
  ) {}

  listPlans(): Promise<BillingPlan[]> {
    return this.db.platformTx((tx) => this.repo.plans(tx));
  }

  currentSubscription(): Promise<Subscription | null> {
    const { tenantId } = currentTenant();
    return this.db.tenantTx((tx) =>
      this.repo.currentSubscription(tx, tenantId, ['pending', 'active', 'past_due']),
    );
  }

  listInvoices(): Promise<Invoice[]> {
    const { tenantId } = currentTenant();
    return this.db.tenantTx((tx) => this.repo.invoices(tx, tenantId));
  }

  /** Internal service call (not a route): subscribe with a provider token. */
  subscribe(request: SubscribeRequest, key: string): Promise<IdempotentOutcome<Subscription>> {
    const { tenantId, principalId } = this.actor();
    return this.db.idempotent<Subscription>({
      principalId,
      operation: 'payments.billing.subscribe',
      key,
      request,
      effect: async (tx) => {
        const started = await this.start(tx, tenantId, request.plan_id, request.payment_method);
        return { status: 201, body: started.subscription };
      },
    });
  }

  // ---- payment attempts -----------------------------------------------------------------------

  /**
   * Operator checkout. The card number goes to the adapter's `tokenize` and no further: the
   * idempotency hash covers `plan_id` and the token only, and the attempt keeps `last4` and `brand`.
   */
  async createAttempt(
    request: CreateAttemptRequest,
    key: string,
  ): Promise<IdempotentOutcome<PaymentAttempt>> {
    const { tenantId, principalId } = this.actor();
    let card;
    try {
      card = this.provider.tokenize(request.card_number);
    } catch (err) {
      if (err instanceof CardNotAcceptedError) throw new LedgerError('card_not_accepted');
      throw err;
    }
    return this.db.idempotent<PaymentAttempt>({
      principalId,
      operation: 'payments.billing.attempts.create',
      key,
      request: { plan_id: request.plan_id, token: card.token },
      effect: async (tx) => {
        const started = await this.start(tx, tenantId, request.plan_id, card.token);
        const attempt = await this.repo.insertAttempt(tx, {
          tenantId,
          id: uuidv7(),
          planId: request.plan_id,
          subscriptionId: started.subscription.id,
          state: started.declined ? 'declined' : 'processing',
          last4: card.last4,
          brand: card.brand,
        });
        return { status: 201, body: attempt };
      },
    });
  }

  async getAttempt(id: string): Promise<PaymentAttempt> {
    const { tenantId } = currentTenant();
    const attempt = await this.db.tenantTx((tx) => this.repo.attemptById(tx, tenantId, id));
    if (!attempt) throw new LedgerError('attempt_not_found');
    return attempt;
  }

  /**
   * Cancel a `processing` attempt: one conditional UPDATE decides against a racing success webhook.
   * A repeat answers `cancelled`; a `succeeded` or `declined` attempt is `attempt_not_cancellable`.
   */
  cancelAttempt(id: string, key: string): Promise<IdempotentOutcome<PaymentAttempt>> {
    const { tenantId, principalId } = this.actor();
    return this.db.idempotent<PaymentAttempt>({
      principalId,
      operation: 'payments.billing.attempts.cancel',
      key,
      request: { id },
      effect: async (tx) => {
        const won = await this.repo.transitionAttempt(tx, tenantId, id, 'processing', 'cancelled');
        if (won) {
          if (won.subscription_id) {
            const sub = await this.repo.subscriptionById(tx, tenantId, won.subscription_id);
            if (sub) await this.provider.cancelSubscription(sub.provider_subscription_id);
            await this.repo.markCanceled(tx, tenantId, won.subscription_id);
          }
          return { status: 200, body: won };
        }
        const current = await this.repo.attemptById(tx, tenantId, id);
        if (!current) throw new LedgerError('attempt_not_found');
        if (current.state === 'cancelled') return { status: 200, body: current };
        throw new LedgerError('attempt_not_cancellable');
      },
    });
  }

  // ---- provider webhooks ----------------------------------------------------------------------

  /**
   * The provider's callback. Verification is the adapter's job and comes first, before the body is
   * used for anything (a bad signature throws `WebhookSignatureError`). The tenant is the one we put
   * into the subscribe metadata and the provider echoed, inside a body whose signature checked out.
   * Everything after verification is ONE tenant transaction; a failure there is thrown, never
   * answered as success, so the provider retries.
   */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<WebhookResult> {
    const snapshot = this.provider.verifyWebhook(rawBody, signature);
    return runWithTenant({ tenantId: snapshot.tenantId }, () =>
      this.db.tenantTx((tx) => this.applyWebhook(tx, snapshot)),
    );
  }

  private async applyWebhook(tx: Tx, snapshot: ProviderSnapshot): Promise<WebhookResult> {
    const { tenantId } = snapshot;
    const provider = this.provider.kind;
    if (!(await this.repo.recordWebhookEvent(tx, tenantId, provider, snapshot.eventId))) {
      return { outcome: 'duplicate' };
    }
    const sub = await this.repo.subscriptionByProviderId(
      tx,
      tenantId,
      provider,
      snapshot.subscriptionId,
    );
    if (!sub) throw new Error(`webhook ${snapshot.eventId} names an unknown subscription`);

    // The attempt first, then the subscription: the same order as `cancelAttempt`, so the two
    // cannot deadlock. A cancelled attempt never captures, whatever the provider says later.
    const attempt = await this.repo.attemptBySubscription(tx, tenantId, sub.id);
    if (attempt) {
      if (attempt.state === 'cancelled') return { outcome: 'ignored' };
      if (attempt.state === 'processing' && snapshot.status === 'active') {
        const won = await this.repo.transitionAttempt(
          tx,
          tenantId,
          attempt.id,
          'processing',
          'succeeded',
        );
        if (!won) return { outcome: 'ignored' }; // cancel won the race
      }
    }

    const applied = await this.repo.applySnapshot(tx, tenantId, sub.id, {
      status: snapshot.status,
      version: snapshot.version,
      periodStart: new Date(snapshot.periodStart),
      periodEnd: new Date(snapshot.periodEnd),
    });
    if (applied && snapshot.status === 'active') {
      // Priced from the plan row of the subscription, never from `snapshot.amountMinor`.
      const plan = await this.repo.planById(tx, sub.plan_id);
      if (!plan) throw new Error(`subscription ${sub.id} has no plan row`);
      await this.repo.insertInvoice(tx, {
        tenantId,
        id: uuidv7(),
        subscriptionId: sub.id,
        amountMinor: plan.price_minor,
        currency: plan.currency,
        status: 'paid',
        periodStart: new Date(snapshot.periodStart),
        periodEnd: new Date(snapshot.periodEnd),
      });
    }
    await this.faults.hit('webhook_apply', tx);
    return { outcome: applied ? 'applied' : 'superseded' };
  }

  // ---- shared ---------------------------------------------------------------------------------

  private actor(): { tenantId: string; principalId: string } {
    const { tenantId, principalId } = currentTenant();
    if (!principalId) throw new LedgerError('forbidden', 'a principal is required');
    return { tenantId, principalId };
  }

  /** Ask the provider to subscribe the tenant to a plan, priced from the plan row. */
  private async start(tx: Tx, tenantId: string, planId: string, token: string): Promise<Started> {
    const plan = await this.repo.planById(tx, planId);
    if (!plan) throw new LedgerError('validation_failed', 'unknown plan');
    const { customerId } = await this.provider.createCustomer({
      tenantId,
      email: `billing+${tenantId}@tenants.invalid`,
    });
    const result = await this.provider.subscribe({
      customerId,
      tenantId,
      plan: { code: plan.code, priceMinor: plan.price_minor, currency: plan.currency },
      paymentMethod: token,
    });
    const now = new Date();
    const declined = result.outcome === 'declined';
    const subscription = await this.repo.insertSubscription(tx, {
      tenantId,
      id: uuidv7(),
      planId: plan.id,
      status: declined ? 'declined' : 'pending',
      provider: this.provider.kind,
      providerSubscriptionId:
        result.outcome === 'pending' ? result.subscriptionId : `declined_${uuidv7()}`,
      providerCustomerId: customerId,
      periodStart: now,
      periodEnd: now,
    });
    if (declined) {
      // The audit trail of a refused checkout: a failed invoice, nothing paid.
      await this.repo.insertInvoice(tx, {
        tenantId,
        id: uuidv7(),
        subscriptionId: subscription.id,
        amountMinor: plan.price_minor,
        currency: plan.currency,
        status: 'failed',
        periodStart: now,
        periodEnd: now,
      });
    }
    return { subscription, declined };
  }
}
