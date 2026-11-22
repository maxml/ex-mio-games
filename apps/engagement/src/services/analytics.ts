import { afterCommit, emitProductEventAs, type ProductAuth, type TxLike } from '@ex-mio/logger';
import type { ProductEventInput } from '@ex-mio/contracts';
import { tryCurrentAuth } from '@ex-mio/service-kit';

type Event = Pick<ProductEventInput, 'event' | 'props'>;

/**
 * The actor of an engagement event is the player. On a request that is the verified AuthContext;
 * from the sweeper or an inbound webhook there is none, so the player's internal id stands in
 * (never the casino-side player id).
 */
function playerActor(tenantId: string, playerId: string): ProductAuth {
  const auth = tryCurrentAuth();
  if (auth && auth.mode === 'user' && auth.principalId === playerId) return auth;
  return { mode: 'user', tenantId, principalId: playerId, roles: ['player'] };
}

/** Emit now: the caller's write is already committed (a store call that returned). */
export function emitPlayerEvent(tenantId: string, playerId: string, event: Event): void {
  emitProductEventAs(playerActor(tenantId, playerId), { ...event, tenant_id: tenantId });
}

/** Emit once the transaction `tx` has committed; a rollback leaves no line. */
export function emitPlayerEventAfterCommit(
  tx: TxLike,
  tenantId: string,
  playerId: string,
  event: Event,
): void {
  const actor = playerActor(tenantId, playerId);
  afterCommit(tx, () => emitProductEventAs(actor, { ...event, tenant_id: tenantId }));
}
