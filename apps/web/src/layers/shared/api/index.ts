// Public API for the `shared/api` segment. The HTTP wrapper/error-envelope
// (`./http`) and the singleton WebSocket client (`./ws`) are the two transports
// (ADR-0001 §7); `./endpoints` holds reference calls built on the HTTP client; the
// typed query-key factory (`./query-keys`) is the single source of truth for
// TanStack Query cache keys (ADR-0001 §8). The `ws` segment is still an empty F1
// baseline skeleton.
export * from './http';
export * from './query-keys';
export * from './ws';
export * from './endpoints';
