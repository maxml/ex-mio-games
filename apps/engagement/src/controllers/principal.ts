import { Uuid } from '@ex-mio/contracts';
import { currentAuth, parseInput } from '@ex-mio/service-kit';
import { SagaError } from '../redemptions/saga-error';

/** Identity's role vocabulary (X-15). */
export type Role = 'player' | 'operator_admin' | 'operator_staff';

export interface Principal {
  /** The token's `sub`. */
  id: string;
  roles: readonly string[];
  /** X-3 / D-13: true only for a player launched through a sandbox credential (the `sbx` claim). */
  sandbox: boolean;
  /** An acting platform_admin session (the `act` claim, D-5). */
  acting: boolean;
}

/**
 * The caller, from the verified token (X-9): the tenant, the principal, the roles and the sandbox
 * flag (the `sbx` claim, `AuthContext.sandbox`: never a body, a query or a header, D-12, D-15) come
 * from the service-kit auth context. Only a user token is a principal here; a service token is not
 * (403). The argument is kept for the callers' signature and is not read.
 */
export function readPrincipal(_headers?: Record<string, unknown>): Principal {
  const auth = currentAuth();
  if (auth.mode !== 'user') throw new SagaError('forbidden', 'a user token is required');
  return {
    id: auth.principalId,
    roles: auth.roles,
    sandbox: auth.sandbox === true,
    acting: auth.acting !== undefined,
  };
}

/** 403 `forbidden` unless the caller holds one of the roles. Runs before any input is used. */
export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.some((r) => principal.roles.includes(r))) {
    throw new SagaError('forbidden', 'role not allowed');
  }
}

/** A player id is a UUID: the payments service validates `player_id` as one. */
export const playerIdOf = (principal: Principal): string => parseInput(Uuid, principal.id);
