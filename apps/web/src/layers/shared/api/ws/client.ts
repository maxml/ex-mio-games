import { io, type Socket } from 'socket.io-client';
import {
  NotificationEnvelope,
  PingInput,
  PongAck,
  REALTIME_EVENTS,
  REALTIME_NAMESPACE,
  SubscribeAck,
  SubscribeInput,
} from '@ex-mio/shared-types';
// Deep import of the runtime resolver (not the `shared/config` barrel): the
// barrel also re-exports the i18n navigation primitives, and pulling those into
// the transport graph is both unnecessary and unresolvable under Vitest.
import { resolveWsBaseUrl } from '../../config/runtime';
import { reconnectionOptions } from './backoff';

/**
 * Max time to wait for a server ack on an emit before rejecting. The gateway can
 * throw a `WsException` (forbidden room, rate limit, unauth, validation) and send
 * NO ack, so a bare ack callback would never settle. socket.io's `timeout()`
 * turns that silence into a rejected promise.
 */
export const WS_ACK_TIMEOUT_MS = 5000;

// Singleton, multiplexed socket.io client for the `notifications` namespace
// (ADR-0003 §5.2). One long-lived connection is shared across the
// app; components never `new` up their own socket. The socket is created lazily
// the first time `getWsClient` is called — and that call happens only inside the
// app-layer `WSProvider`'s `useEffect`, never at module scope, because newing a
// socket during SSR throws.

/**
 * Source of the handshake bearer token. Injectable so the real session token can
 * be supplied by the app (auth/session wiring is app-specific); re-evaluated on every
 * (re)connection so a refreshed token is used. May be sync or async.
 */
export type TokenGetter = () => string | null | undefined | Promise<string | null | undefined>;

export interface WsClientOptions {
  /**
   * Explicit gateway origin override. Defaults to {@link resolveWsBaseUrl} — the
   * runtime resolver that derives the WS origin from the current page (same
   * origin) or the configured API base. The namespace is appended.
   */
  url?: string;
  /** Handshake token source; defaults to {@link defaultTokenGetter}. */
  getToken?: TokenGetter;
}

/**
 * Placeholder token source. The real session token comes from the app's auth wiring
 * (ADR-0003 §3 handshake auth: the gateway resolves it through the auth facade).
 * Seeded from `NEXT_PUBLIC_WS_TOKEN` so a developer can point at a real token
 * without code changes; defaults to empty, which the gateway rejects.
 */
export const defaultTokenGetter: TokenGetter = () => process.env.NEXT_PUBLIC_WS_TOKEN ?? null;

let socket: Socket | null = null;

/**
 * Whether a realtime gateway origin can be resolved. The provider calls this
 * before creating any socket. In the browser this is ALWAYS true: with no
 * `NEXT_PUBLIC_API_URL` (and no explicit url) the WS resolves to the SAME ORIGIN
 * (`wss://` on https, `ws://` on http) from `window.location`, so the
 * domain-agnostic production image has realtime ON, not off. It is false only
 * with no window and no configured base (an SSR/defensive path — the socket is
 * never created there anyway), so the app degrades to "realtime off" rather than
 * throwing at mount.
 */
export const isWsConfigured = (url?: string): boolean => Boolean(resolveWsBaseUrl(url));

function resolveUrl(explicit?: string): string {
  const base = resolveWsBaseUrl(explicit);
  if (!base) {
    throw new Error(
      'Cannot resolve a realtime socket origin (no window and no configured API URL).',
    );
  }
  return `${base.replace(/\/+$/, '')}/${REALTIME_NAMESPACE}`;
}

/**
 * Return the shared socket, creating it on first call. Idempotent: later calls
 * return the same instance regardless of options. `autoConnect` is off so the
 * provider controls when the connection opens (after listeners are attached).
 */
export function getWsClient(options: WsClientOptions = {}): Socket {
  if (socket) {
    return socket;
  }
  const getToken = options.getToken ?? defaultTokenGetter;
  socket = io(resolveUrl(options.url), {
    transports: ['websocket'],
    autoConnect: false,
    // Function form: re-invoked before each (re)connection, so a token refreshed
    // after a drop is used on reconnect (ADR-0003 §3 — browsers can't set the WS
    // `Authorization` header, so the token rides socket.io's `auth` handshake).
    auth: (cb) => {
      void Promise.resolve(getToken()).then((token) => cb({ token: token ?? '' }));
    },
    ...reconnectionOptions,
  });
  return socket;
}

/** Tear the singleton down (provider unmount / tests). */
export function disconnectWsClient(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/**
 * Subscribe to inbound `notification` frames, narrowing each against the shared
 * Zod schema (ADR-0003 §4). Malformed frames are dropped, never dispatched.
 * Returns an unsubscribe function.
 */
export function onNotification(
  client: Socket,
  handler: (notification: NotificationEnvelope) => void,
): () => void {
  const listener = (raw: unknown) => {
    const parsed = NotificationEnvelope.safeParse(raw);
    if (!parsed.success) {
      return; // drop malformed frame
    }
    handler(parsed.data);
  };
  client.on(REALTIME_EVENTS.notification, listener);
  return () => {
    client.off(REALTIME_EVENTS.notification, listener);
  };
}

/** Emit `ping` and resolve with the validated `pong` ack (round-trip probe). */
export function emitPing(client: Socket, input: PingInput = {}): Promise<PongAck> {
  const payload = PingInput.parse(input);
  return new Promise((resolve, reject) => {
    // `timeout()` rejects with an error if no ack arrives in time (e.g. the
    // gateway threw and never acked), so the promise can never hang.
    client
      .timeout(WS_ACK_TIMEOUT_MS)
      .emit(REALTIME_EVENTS.ping, payload, (err: unknown, ack: unknown) => {
        if (err) {
          reject(new Error('realtime: ping timed out'));
          return;
        }
        const parsed = PongAck.safeParse(ack);
        if (!parsed.success) {
          reject(new Error('realtime: invalid pong ack'));
          return;
        }
        resolve(parsed.data);
      });
  });
}

/** Emit `subscribe` to join a room and resolve with the validated ack. */
export function emitSubscribe(client: Socket, input: SubscribeInput): Promise<SubscribeAck> {
  const payload = SubscribeInput.parse(input);
  return new Promise((resolve, reject) => {
    // `timeout()` rejects if the gateway never acks (e.g. a `WsException` for a
    // forbidden room or rate limit), so the promise can never hang.
    client
      .timeout(WS_ACK_TIMEOUT_MS)
      .emit(REALTIME_EVENTS.subscribe, payload, (err: unknown, ack: unknown) => {
        if (err) {
          reject(new Error('realtime: subscribe timed out'));
          return;
        }
        const parsed = SubscribeAck.safeParse(ack);
        if (!parsed.success) {
          reject(new Error('realtime: invalid subscribe ack'));
          return;
        }
        resolve(parsed.data);
      });
  });
}
