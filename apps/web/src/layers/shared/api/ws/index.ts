// Public API for the `shared/api/ws` segment — the singleton socket.io client
// (ADR-0014 §5.2): one multiplexed, long-lived connection to the
// gateway's `notifications` namespace, typed emit/on narrowed against the shared
// Zod contracts, and reconnect with exponential backoff + jitter. Instantiate
// the socket only inside a `useEffect` (the app-layer `WSProvider`); newing it
// during SSR throws.
export {
  getWsClient,
  disconnectWsClient,
  isWsConfigured,
  onNotification,
  emitPing,
  emitSubscribe,
  defaultTokenGetter,
  fetchRealtimeTicket,
  type TokenGetter,
  type WsClientOptions,
} from './client';
export {
  computeBackoffDelay,
  reconnectionOptions,
  RECONNECTION_BASE_DELAY_MS,
  RECONNECTION_MAX_DELAY_MS,
  RECONNECTION_JITTER,
  RECONNECTION_MAX_ATTEMPTS,
  type BackoffOptions,
} from './backoff';
