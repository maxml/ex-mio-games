import { HttpException } from '@nestjs/common';
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
 * The `sbx` claim of the access token. The service-kit entry point (`ServiceAuthModule`) has already
 * verified the signature, the audience and the expiry before any handler runs (it is an APP_GUARD),
 * so reading the claim from the same bearer token is reading verified data. It is the ONLY source of
 * the sandbox flag: never a body, a query or any request header (D-12, D-15).
 */
export function sandboxClaim(authorization: unknown): boolean {
  if (typeof authorization !== 'string') return false;
  const token = /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
  const payload = token?.split('.')[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sbx?: unknown;
    };
    return claims.sbx === true;
  } catch {
    return false;
  }
}

/**
 * The caller, from the verified token (X-9): the tenant, the principal and the roles come from the
 * service-kit auth context, never from a header. Only a user token is a principal here; a service
 * token is not (403).
 */
export function readPrincipal(headers: Record<string, unknown>): Principal {
  const auth = currentAuth();
  if (auth.mode !== 'user') throw new SagaError('forbidden', 'a user token is required');
  return {
    id: auth.principalId,
    roles: auth.roles,
    sandbox: sandboxClaim(headers['authorization']),
    acting: auth.acting !== undefined,
  };
}

/** 403 `forbidden` unless the caller holds one of the roles. Runs before any input is used. */
export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.some((r) => principal.roles.includes(r))) {
    throw new SagaError('forbidden', 'role not allowed');
  }
}

/**
 * D-5, D-15 Q-2 (a): an acting platform_admin session never moves coins, and resolving a redemption
 * moves coins one hop away (`redemptions.resolve` is in identity's `ACTING_DENIED_ACTIONS`). 403
 * `ACTING_FORBIDDEN` BEFORE the service is called; the entry point audits the refusal (D-11).
 */
export function refuseActing(principal: Principal): void {
  if (principal.acting)
    throw new HttpException(
      { code: 'ACTING_FORBIDDEN', message: 'an acting session cannot resolve a redemption' },
      403,
    );
}

/** A player id is a UUID: the payments service validates `player_id` as one. */
export const playerIdOf = (principal: Principal): string => parseInput(Uuid, principal.id);
