import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  scopedKey,
  SpinCompletedV1,
  type EventEnvelope,
  type UsageReport,
} from '@ex-mio/contracts';
import { Db, type Tx } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { BillingRepository } from '../model/billing.repository';
import { LEDGER_FAULTS, type LedgerFaults } from '../model/ledger.faults';
import { UsageRepository } from '../model/usage.repository';
import { LedgerError } from './ledger.errors';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider';

/** Injection token of the salt of the monthly-active-player key. */
export const USAGE_KEY_SALT = Symbol('USAGE_KEY_SALT');

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Usage metering from `engagement.spin.completed` (MIO-095): spins and distinct monthly active players
 * per tenant and calendar month, counted exactly once per SPIN (`spin_id`), never for an event the PRODUCER
 * marked `sandbox`. The flag is read from the envelope and nowhere else.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly db: Db,
    private readonly usage: UsageRepository,
    private readonly billing: BillingRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(USAGE_KEY_SALT) private readonly salt: string | undefined,
    @Inject(LEDGER_FAULTS) private readonly faults: LedgerFaults,
  ) {}

  /** Meter one event inside the caller's transaction (the spin delivery's, or a test's). */
  async handle(tx: Tx, event: EventEnvelope): Promise<void> {
    if (event.sandbox) return;
    const spin = SpinCompletedV1.parse(event.payload);
    // The business key is the spin, not the event: engagement may re-publish a spin under a new
    // event id, and the tenant must not be billed twice for it (INV-M6).
    const counted = await this.usage.markCounted(
      tx,
      event.tenant_id,
      spin.spin_id,
      event.event_id,
      event.occurred_at,
    );
    if (!counted) return;
    // The scheduled jobs list tenants from this registry: a tenant with spins is reported even if it
    // never had a coin wallet.
    await this.usage.registerTenant(tx, event.tenant_id);
    const period = new Date(event.occurred_at).toISOString().slice(0, 7);
    await this.usage.addSpin(tx, event.tenant_id, period);
    await this.usage.addActivePlayer(
      tx,
      event.tenant_id,
      period,
      this.playerKey(event.tenant_id, spin.player_id),
    );
  }

  async report(period: string): Promise<UsageReport> {
    this.assertPeriod(period);
    const { tenantId } = currentTenant();
    const totals = await this.db.tenantTx((tx) => this.usage.totals(tx, tenantId, period));
    return { period, spins: totals.spins, monthly_active_players: totals.players };
  }

  /**
   * Send the period's quantity to the provider once, under the stable key `usage:<tenant>:<period>`,
   * and only then record it. A crash between the two is repaired by the retry: the provider holds the
   * key already, so it bills nothing twice. Needs an active subscription.
   */
  async reportToProvider(period: string): Promise<{ period: string; quantity: number }> {
    this.assertPeriod(period);
    const { tenantId } = currentTenant();
    const state = await this.db.tenantTx(async (tx) => ({
      reported: await this.usage.reportOf(tx, tenantId, period),
      subscription: await this.billing.currentSubscription(tx, tenantId, ['active']),
      totals: await this.usage.totals(tx, tenantId, period),
    }));
    if (state.reported) return { period, quantity: state.reported.quantity };
    if (!state.subscription) throw new Error('no active subscription: nothing to report usage to');

    // Usage is metered for production only (D-13), so the environment is fixed.
    const idempotencyKey = scopedKey({ kind: 'usage', tenantId, sandbox: false, parts: [period] });
    await this.provider.reportUsage({
      subscriptionId: state.subscription.provider_subscription_id,
      period,
      quantity: state.totals.spins,
      idempotencyKey,
    });
    await this.faults.hit('after_usage_report_sent');
    await this.db.tenantTx((tx) =>
      this.usage.insertReport(tx, tenantId, {
        period,
        quantity: state.totals.spins,
        idempotencyKey,
      }),
    );
    return { period, quantity: state.totals.spins };
  }

  /**
   * The scheduled usage report: reports the period only for a tenant that has an active subscription
   * (a tenant on no plan has nothing to bill), and is a no-op for one that is already reported.
   * Returns null when the tenant has no active subscription.
   */
  async reportDue(period: string): Promise<{ period: string; quantity: number } | null> {
    this.assertPeriod(period);
    const { tenantId } = currentTenant();
    const active = await this.db.tenantTx((tx) =>
      this.billing.currentSubscription(tx, tenantId, ['active']),
    );
    if (!active) return null;
    return this.reportToProvider(period);
  }

  private assertPeriod(period: string): void {
    if (!PERIOD.test(period)) throw new LedgerError('validation_failed', 'period must be YYYY-MM');
  }

  /** A salted hash of the player id: the usage tables hold no id that identifies a person. */
  private playerKey(tenantId: string, playerId: string): string {
    if (!this.salt) throw new Error('USAGE_KEY_SALT is not set');
    return createHmac('sha256', this.salt).update(`${tenantId}:${playerId}`).digest('hex');
  }
}
