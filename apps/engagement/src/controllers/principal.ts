import { PrincipalHeaders, Uuid } from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { SagaError } from '../redemptions/saga-error';

export type Role = 'player' | 'owner' | 'admin' | 'analyst';

export interface Principal {
  id: string;
  role: Role;
  /** From the server-side context (header placeholder until identity issues claims), never a body. */
  sandbox: boolean;
}

/**
 * The caller, from the placeholder request context (D4). A missing or malformed principal is 400;
 * which routes it may use is `requireRole`.
 */
export function readPrincipal(headers: Record<string, unknown>): Principal {
  const parsed = parseInput(PrincipalHeaders, headers);
  return {
    id: parsed['x-principal-id'],
    role: parsed['x-principal-role'],
    sandbox: parsed['x-sandbox'] === '1',
  };
}

/** 403 `forbidden` unless the caller has one of the roles. Runs before any input is used. */
export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.includes(principal.role)) throw new SagaError('forbidden', 'role not allowed');
}

/** A player id is a UUID: the payments service validates `player_id` as one. */
export const playerIdOf = (principal: Principal): string => parseInput(Uuid, principal.id);
