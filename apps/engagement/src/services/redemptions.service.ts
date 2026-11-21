import { Inject, Injectable } from '@nestjs/common';
import type { RedemptionState } from '@ex-mio/contracts';
import type {
  Operator,
  OwnRedemptionLister,
  RedemptionRecord,
  RedemptionStore,
  Scope,
} from '../redemptions/ports';
import { SagaError } from '../redemptions/saga-error';
import { REDEMPTION_SAGA, REDEMPTION_STORE } from '../redemptions/tokens';
import { RedemptionSagaService } from './redemption-saga.service';

/** What the controllers call: the saga for writes, the store for reads. */
@Injectable()
export class RedemptionsService {
  constructor(
    @Inject(REDEMPTION_SAGA) private readonly saga: RedemptionSagaService,
    @Inject(REDEMPTION_STORE) private readonly store: RedemptionStore & OwnRedemptionLister,
  ) {}

  /**
   * Order and reserve. A repeat of the same key returns the stored order; while its first call is
   * still inside the inline reserve (REQUESTED, grace not over) the repeat is a retryable 409
   * `idempotency_in_progress` (D-3), not a second answer from a half-finished order.
   */
  async redeem(
    scope: Scope,
    operationKey: string,
    itemId: string,
  ): Promise<{ redemption: RedemptionRecord; created: boolean }> {
    const result = await this.saga.redeem(scope, operationKey, itemId);
    const r = result.redemption;
    if (
      !result.created &&
      r.state === 'REQUESTED' &&
      r.nextAttemptAt !== null &&
      r.nextAttemptAt.getTime() > this.saga.now().getTime()
    )
      throw new SagaError('idempotency_in_progress');
    return result;
  }

  getOwn(scope: Scope, id: string): Promise<RedemptionRecord | null> {
    return this.store.getOwn(scope, id);
  }

  /** W-5: the caller's own redemptions (tenant, player and sandbox flag from the token). */
  listOwn(scope: Scope): Promise<RedemptionRecord[]> {
    return this.store.listOwn(scope);
  }

  getForOperator(tenantId: string, id: string): Promise<RedemptionRecord | null> {
    return this.store.getForOperator(tenantId, id);
  }

  listForOperator(tenantId: string, state?: RedemptionState): Promise<RedemptionRecord[]> {
    return this.store.listForOperator(tenantId, state);
  }

  resolveReview(
    tenantId: string,
    id: string,
    input: { outcome: 'issued' | 'not_issued'; reason: string },
    operator: Operator,
  ): Promise<RedemptionRecord> {
    return this.saga.resolveReview(tenantId, id, { ...input, operator });
  }
}
