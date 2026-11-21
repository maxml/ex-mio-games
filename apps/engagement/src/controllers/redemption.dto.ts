import { PUBLIC_STATUS_OF, type Redemption } from '@ex-mio/contracts';
import type { RedemptionRecord } from '../redemptions/ports';

export type Audience = 'player' | 'operator';

/**
 * The one mapper from a stored redemption to its API shape.
 *  - Players see the four public words in `status`, and `state` as is; for NEEDS_REVIEW they get
 *    no reason (it is an operator matter), for the failure states they do get it (a player
 *    without coins reads `insufficient_funds`). They get no history: its causes carry operator
 *    reasons and internal detail.
 *  - Operators see the reason and the full history.
 */
export function toRedemption(r: RedemptionRecord, audience: Audience): Redemption {
  const hideReason = audience === 'player' && r.state === 'NEEDS_REVIEW';
  return {
    id: r.id,
    item_id: r.itemId,
    price: r.price,
    status: PUBLIC_STATUS_OF[r.state],
    state: r.state,
    attempts: r.attempts,
    casino_reference: r.casinoReference,
    failure_reason: hideReason ? null : r.failureReason,
    history:
      audience === 'operator'
        ? r.history.map((h) => ({
            from: h.from,
            to: h.to,
            cause: h.cause,
            at: h.at.toISOString(),
          }))
        : [],
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
