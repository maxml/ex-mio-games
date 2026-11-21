import type { DynamicModule } from '@nestjs/common';
import { ServiceAuthModule } from '@ex-mio/service-kit'; // RED until identity epic (L1) merges: the one auth entry point
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

/** `ServiceAuthModule.forService` with a fixture JWKS, tenant status `active` and the fixed clock. */
export function authModule(opts: { tenantStatus?: () => 'active' | 'suspended' } = {}): DynamicModule {
  return ServiceAuthModule.forService({
    audience: 'engagement',
    jwks: async () => ({ keys: [key.publicJwk] }),
    tenantStatus: async () => opts.tenantStatus?.() ?? 'active',
    nowSeconds: () => NOW_SECONDS,
  });
}

/** A signed access token for `audience` (default engagement), role `player` unless given. */
export function playerToken(
  tenantId: string,
  userId: string,
  over: { aud?: string; roles?: string[] } = {},
): string {
  return signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: key.kid,
    claims: accessClaims({
      now: NOW_SECONDS,
      sub: userId,
      tid: tenantId,
      roles: over.roles ?? ['player'],
      aud: over.aud ?? 'engagement',
    }),
  });
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** Headers of a request made by player `userId` of tenant `tenantId`. */
export const asPlayer = (tenantId: string, userId: string): Record<string, string> =>
  bearer(playerToken(tenantId, userId));
