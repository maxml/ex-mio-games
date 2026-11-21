import type { DynamicModule } from '@nestjs/common';
import { type EventEnvelope, PLATFORM_TENANT_ID } from '@ex-mio/contracts';
import { ServiceAuthModule } from '@ex-mio/service-kit'; // the one auth entry point (L1, Stage B)
import { accessClaims, generateRsaKey, signJwt } from '@ex-mio/service-kit/testing';

/*
 * Test authentication for engagement (coordinator decision D-4 and D-12): the tenant and the
 * principal come from a signed access token verified by the shared service-kit entry point, never
 * from `x-tenant-id` / `x-principal-id` headers (those are gone). The signing helpers are L1's
 * `service-kit/testing` fixtures, taken from identity epic; this file only wires them to the
 * audience `engagement` with a fixture JWKS and a fixed clock.
 */

/** Fixed test clock, seconds. Tokens are minted and verified against it. */
export const NOW_SECONDS = 1_800_000_000;
const key = generateRsaKey('l3-test-key');

/** Every audit event (D-11, D-14) the entry point handed to the audit port. */
export const auditEvents: EventEnvelope[] = [];

/**
 * `ServiceAuthModule.forService` with a fixture JWKS, tenant status `active`, the fixed clock and an
 * in-memory audit port (`auditEvents`); the entry point requires one, and production wiring passes none.
 */
export function authModule(opts: { tenantStatus?: () => 'active' | 'suspended' } = {}): DynamicModule {
  return ServiceAuthModule.forService({
    audience: 'engagement',
    jwks: async () => ({ keys: [key.publicJwk] }),
    tenantStatus: async () => opts.tenantStatus?.() ?? 'active',
    auditPort: async (event: EventEnvelope) => {
      auditEvents.push(event);
    },
    nowSeconds: () => NOW_SECONDS,
  });
}

/**
 * A signed access token for `audience` (default engagement), role `player` unless given. `sbx` marks
 * a player launched through a sandbox credential (X-3); `act` makes it an acting platform_admin.
 */
export function playerToken(
  tenantId: string,
  userId: string,
  over: {
    aud?: string;
    roles?: string[];
    sbx?: true;
    act?: { tenant_id: string; reason: string };
  } = {},
): string {
  return signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: key.kid,
    claims: accessClaims({
      now: NOW_SECONDS,
      sub: userId,
      tid: over.act ? PLATFORM_TENANT_ID : tenantId,
      roles: over.act ? ['platform_admin'] : (over.roles ?? ['player']),
      aud: over.aud ?? 'engagement',
      sbx: over.sbx,
      act: over.act,
    }),
  });
}

/** An operator token (`operator_admin` unless `role` says otherwise) for the tenant. */
export const operatorToken = (
  tenantId: string,
  userId: string,
  role: 'operator_admin' | 'operator_staff' = 'operator_admin',
): string => playerToken(tenantId, userId, { roles: [role] });

/** A platform_admin acting inside `tenantId` (the `act` claim, D-5). */
export const actingToken = (tenantId: string, userId: string): string =>
  playerToken(tenantId, userId, { act: { tenant_id: tenantId, reason: 'ticket 42 support' } });

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** Headers of a request made by player `userId` of tenant `tenantId`. */
export const asPlayer = (tenantId: string, userId: string): Record<string, string> =>
  bearer(playerToken(tenantId, userId));
