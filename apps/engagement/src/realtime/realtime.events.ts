import {
  MIO_REALTIME_TYPES,
  type EventEnvelope,
  type MioRealtimeType,
  type NotificationEnvelope,
} from '@ex-mio/contracts';

/** One push: which player's room, and the `notification` frame for it. */
export interface Push {
  tenantId: string;
  /** The envelope's environment: realtime is per environment (D-30). */
  sandbox: boolean;
  playerId: string;
  frame: NotificationEnvelope;
}

/** The bus event types the gateway listens to (added to engagement's bindings). */
export const REALTIME_BINDINGS = [
  'engagement.spin.completed',
  'engagement.redemption.status_changed',
  'payments.coins.credited',
  'payments.coins.reserved',
  'payments.coins.captured',
  'payments.coins.released',
  'payments.coins.refunded',
] as const;

const BALANCE_TYPES = new Set<string>([
  'payments.coins.credited',
  'payments.coins.reserved',
  'payments.coins.captured',
  'payments.coins.released',
  'payments.coins.refunded',
]);

/**
 * Maps a validated bus event to the push for its player, or `undefined` for an event the player
 * is not told about. The tenant is the envelope's `tenant_id`; the player is the payload's
 * `player_id`. Payloads are copied field by field: nothing else (wallet ids, reserve ids) is sent.
 */
export function toPush(event: EventEnvelope): Push | undefined {
  const p = event.payload as Record<string, unknown>;
  const playerId = p['player_id'];
  if (typeof playerId !== 'string') return undefined;
  let type: MioRealtimeType;
  let payload: Record<string, unknown>;
  if (event.type === 'engagement.spin.completed') {
    type = MIO_REALTIME_TYPES.spinResult;
    payload = {
      spin_id: p['spin_id'],
      reward_coins: p['reward_coins'],
      table_version: p['table_version'],
    };
  } else if (event.type === 'engagement.redemption.status_changed') {
    type = MIO_REALTIME_TYPES.redemptionStatus;
    payload = { redemption_id: p['redemption_id'], from: p['from'], to: p['to'] };
  } else if (BALANCE_TYPES.has(event.type)) {
    type = MIO_REALTIME_TYPES.balanceChanged;
    payload = {
      reason: event.type.slice('payments.coins.'.length),
      amount: p['amount'],
      // credited carries no balances; the client resyncs over REST for them
      ...(typeof p['available_after'] === 'number' ? { available: p['available_after'] } : {}),
      ...(typeof p['held_after'] === 'number' ? { held: p['held_after'] } : {}),
    };
  } else {
    return undefined;
  }
  return {
    tenantId: event.tenant_id,
    sandbox: event.sandbox,
    playerId,
    frame: {
      id: event.event_id,
      type,
      payload,
      ts: Date.parse(event.occurred_at),
    },
  };
}
