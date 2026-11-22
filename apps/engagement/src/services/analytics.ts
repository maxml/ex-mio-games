import { afterCommit, emitProductEventAs, type ProductAuth, type TxLike } from '@ex-mio/logger';
import type { ProductEventInput } from '@ex-mio/contracts';
import { tryCurrentAuth } from '@ex-mio/service-kit';

type Event = Pick<ProductEventInput, 'event' | 'props'>;

/**
 * The actor of an engagement event is the player. On a request that is the verified AuthContext;
 * from the sweeper or an inbound webhook there is none, so the player's internal id stands in
 * (never the casino-side player id).
 */
function playerActor(tenantId: string, playerId: string, sandbox: boolean): ProductAuth {
  const auth = tryCurrentAuth();
  if (auth && auth.mode === 'user' && auth.principalId === playerId) return auth;
  return { mode: 'user', tenantId, principalId: playerId, roles: ['player'], sandbox };
}

/**
 * Emit now: the caller's write is already committed (a store call that returned). `sandbox` is the
 * environment of the row the event describes, a required argument (INV-ENV-INPUT).
 */
export function emitPlayerEvent(
  tenantId: string,
  playerId: string,
  sandbox: boolean,
  event: Event,
): void {
  emitProductEventAs(playerActor(tenantId, playerId, sandbox), { ...event, tenant_id: tenantId });
}

/** Emit once the transaction `tx` has committed; a rollback leaves no line. */
export function emitPlayerEventAfterCommit(
  tx: TxLike,
  tenantId: string,
  playerId: string,
  sandbox: boolean,
  event: Event,
): void {
  const actor = playerActor(tenantId, playerId, sandbox);
  afterCommit(tx, () => emitProductEventAs(actor, { ...event, tenant_id: tenantId }));
}
