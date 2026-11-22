import type { RealtimeTicketRedeemResponse } from '@ex-mio/contracts';

/**
 * Rooms are `t:{tenant}:{kind}:{id}` and are built here, on the server, from an identity that
 * identity itself redeemed (D-10). Nothing the client sends reaches this function.
 */
export type RoomKind = 'player' | 'user';

export const roomName = (tenantId: string, kind: RoomKind, id: string): string =>
  `t:${tenantId.toLowerCase()}:${kind}:${id.toLowerCase()}`;

/** The one room a redeemed principal is placed in. A player is a `player`; staff are plain `user`s. */
export function roomOf(principal: RealtimeTicketRedeemResponse): string {
  const kind: RoomKind = principal.roles.includes('player') ? 'player' : 'user';
  return roomName(principal.tid, kind, principal.sub);
}
