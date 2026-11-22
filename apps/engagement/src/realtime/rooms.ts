import type { RealtimeTicketRedeemResponse } from '@ex-mio/contracts';

/**
 * Rooms are `t:{tenant}:{env}:{kind}:{id}` and are built here, on the server, from an identity that
 * identity itself redeemed (D-10). Nothing the client sends reaches this function. Realtime is per
 * environment (D-30, F8): a sandbox player hears sandbox events only, a production player
 * production events only, so the environment is a required part of every room name.
 */
export type RoomKind = 'player' | 'user';

export const roomName = (tenantId: string, sandbox: boolean, kind: RoomKind, id: string): string =>
  `t:${tenantId.toLowerCase()}:${sandbox ? 'sbx' : 'prd'}:${kind}:${id.toLowerCase()}`;

/** The one room a redeemed principal is placed in. A player is a `player`; staff are plain `user`s. */
export function roomOf(principal: RealtimeTicketRedeemResponse): string {
  const kind: RoomKind = principal.roles.includes('player') ? 'player' : 'user';
  return roomName(principal.tid, principal.sandbox, kind, principal.sub);
}
