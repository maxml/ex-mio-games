import { z } from 'zod';

// Generic real-time event contracts shared by the gateway (a service) and the
// web client (R3). Only generic/example events live here — a `ping`
// liveness probe, a `subscribe` room request, and a `notification` envelope.
// A consuming app layers its own domain events on top of this envelope; it does
// not edit these generic shapes.

/** socket.io namespace the example gateway listens on. */
export const REALTIME_NAMESPACE = 'notifications';

/** Canonical event names, shared so both sides never drift on a string. */
export const REALTIME_EVENTS = {
  ping: 'ping',
  pong: 'pong',
  subscribe: 'subscribe',
  notification: 'notification',
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

// --- client -> server -------------------------------------------------------

/** `ping` payload; `at` is the client clock so the ack can report round-trip. */
export const PingInput = z.object({
  at: z.number().int().nonnegative().optional(),
});
export type PingInput = z.infer<typeof PingInput>;

/** `subscribe` payload — join a room to receive its notifications. */
export const SubscribeInput = z.object({
  room: z.string().min(1).max(128),
});
export type SubscribeInput = z.infer<typeof SubscribeInput>;

// --- server -> client / acks ------------------------------------------------

/** Ack returned for a `ping`. */
export const PongAck = z.object({
  event: z.literal(REALTIME_EVENTS.pong),
  at: z.number().int().nonnegative().nullable(),
  serverTime: z.number().int().nonnegative(),
});
export type PongAck = z.infer<typeof PongAck>;

/** Ack returned for a `subscribe`. */
export const SubscribeAck = z.object({
  ok: z.boolean(),
  room: z.string(),
});
export type SubscribeAck = z.infer<typeof SubscribeAck>;

/** Generic server->client notification envelope. */
export const NotificationEnvelope = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.number().int().nonnegative(),
});
export type NotificationEnvelope = z.infer<typeof NotificationEnvelope>;

// --- MIO gateway (D-10, D-25) ------------------------------------------------

/** Namespace of the MIO gateway hosted by engagement (the `notifications` one above is the generic example). */
export const MIO_REALTIME_NAMESPACE = 'rt';

/** `type` values of the `notification` frames the MIO gateway pushes to a player's own room. */
export const MIO_REALTIME_TYPES = {
  spinResult: 'spin.result',
  balanceChanged: 'balance.changed',
  redemptionStatus: 'redemption.status',
} as const;

export type MioRealtimeType = (typeof MIO_REALTIME_TYPES)[keyof typeof MIO_REALTIME_TYPES];
