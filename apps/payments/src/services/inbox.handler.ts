import { Inject, Injectable } from '@nestjs/common';
import { SpinCompletedV1, type EventEnvelope } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { LEDGER_FAULTS, type LedgerFaults } from '../model/ledger.faults';
import { BalanceService } from './balance.service';
import { LedgerService } from './ledger.service';
import { UsageService } from './usage.service';

/** The event types payments consumes (the bus binding of `createAppModule`). */
export const SPIN_COMPLETED = 'engagement.spin.completed';
export const COIN_EVENTS = [
  'payments.coins.credited',
  'payments.coins.reserved',
  'payments.coins.captured',
  'payments.coins.released',
  'payments.coins.refunded',
] as const;
export const PAYMENTS_BINDINGS: readonly string[] = [SPIN_COMPLETED, ...COIN_EVENTS];

/** An event this service does not handle: permanent, goes to the dead-letter queue, never retried. */
export class UnhandledEventError extends Error {
  constructor(type: string) {
    super(`payments does not handle ${type}`);
    this.name = 'UnhandledEventError';
  }
}

/**
 * The `EventHandler` given to the foundation `InboxConsumer` (consumer name `payments`). It runs in the
 * consumer's transaction, right after the inbox row was inserted, so the inbox row, the coin credit,
 * the usage meter and the `credited` event commit or roll back together (decision D-1).
 */
@Injectable()
export class PaymentsInboxHandler {
  constructor(
    private readonly ledger: LedgerService,
    private readonly usage: UsageService,
    private readonly balances: BalanceService,
    @Inject(LEDGER_FAULTS) private readonly faults: LedgerFaults,
  ) {}

  async handle(tx: Tx, event: EventEnvelope): Promise<void> {
    if (event.type === SPIN_COMPLETED) return this.spinCompleted(tx, event);
    if ((COIN_EVENTS as readonly string[]).includes(event.type)) {
      // The Redis projection: drop the wallet's cached balance. No database write, no money.
      return this.balances.onCoinEvent(event);
    }
    throw new UnhandledEventError(event.type);
  }

  private async spinCompleted(tx: Tx, event: EventEnvelope): Promise<void> {
    await this.faults.hit('after_inbox', tx);
    // Only the contract is trusted; anything outside it (an `amount` field, say) is ignored.
    const spin = SpinCompletedV1.parse(event.payload);
    if (spin.reward_coins > 0) {
      await this.ledger.creditSpin(tx, {
        tenantId: event.tenant_id,
        spinId: spin.spin_id,
        playerId: spin.player_id,
        amount: spin.reward_coins,
        // The producer's flag from the envelope only (X-3): a sandbox spin credits the sandbox wallet.
        sandbox: event.sandbox,
      });
    }
    await this.usage.handle(tx, event);
  }
}
