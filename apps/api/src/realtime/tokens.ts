import type { AuthUser } from '@ex-mio/auth';

/**
 * DI token for the auth facade the gateway authenticates handshakes against.
 * server.ts binds it to the same wired `AuthService` the HTTP layer uses, so
 * the gateway never stands up a second auth system.
 */
export const REALTIME_AUTH = Symbol('REALTIME_AUTH');

/**
 * Minimal slice of `AuthService` the gateway needs — just token verification.
 * Keeping the gateway behind this narrow port (instead of the full facade)
 * makes the unit test a one-method fake and keeps the module decoupled.
 */
export interface RealtimeAuthService {
  verifyToken(token: string): Promise<AuthUser | null>;
}
