import type { EventEnvelope } from '@ex-mio/contracts';
import { accessClaims, generateRsaKey, serviceClaims, signJwt } from '@ex-mio/service-kit/testing';

/*
 * Test auth for the payments HTTP layer (D-4, D-12, X-9). There are no header placeholders: every
 * request carries a JWT signed with a fixture key, and the app is booted through the one service-kit
 * entry point `ServiceAuthModule.forService` with fixture `jwks`, `tenantStatus` and `auditPort`
 * (the `createAppModule(config, { auth })` override, see docs/specs/payments.md section 7).
 */

export const NOW = 1_800_000_000;
const key = generateRsaKey('k1');

/** Fixed ids so tests read well. All are UUIDs. */
export const T = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a'; // tenant A
export const T_OTHER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'; // tenant B
export const OPERATOR = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
export const PLAYER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d';

export interface AuthFixture {
  /** Options for `ServiceAuthModule.forService` (the test overrides; production passes none). */
  options: {
    audience: 'payments';
    jwks: () => Promise<{ keys: unknown[] }>;
    tenantStatus: (tenantId: string) => Promise<'active' | 'suspended'>;
    auditPort: (event: EventEnvelope) => Promise<void>;
    nowSeconds: () => number;
  };
  /** Every event the entry point handed to the audit port (D-11). */
  audit: EventEnvelope[];
}

export function authFixture(): AuthFixture {
  const audit: EventEnvelope[] = [];
  return {
    audit,
    options: {
      audience: 'payments',
      jwks: async () => ({ keys: [key.publicJwk] }),
      tenantStatus: async () => 'active',
      auditPort: async (event) => {
        audit.push(event);
      },
      nowSeconds: () => NOW,
    },
  };
}

const user = (over: Partial<Parameters<typeof accessClaims>[0]>) =>
  signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: 'k1',
    claims: accessClaims({ now: NOW, aud: 'payments', ttl: 900, sub: OPERATOR, tid: T, ...over }),
  });

/** A token as identity would issue it. `sbx` marks a sandbox player (X-3). */
export const tokens = {
  operator: (tid = T) => user({ tid, sub: OPERATOR, roles: ['operator_admin'] }),
  staff: (tid = T) => user({ tid, sub: OPERATOR, roles: ['operator_staff'] }),
  player: (over: { tid?: string; sub?: string; sbx?: true } = {}) =>
    user({ tid: over.tid ?? T, sub: over.sub ?? PLAYER, roles: ['player'], sbx: over.sbx }),
  /** A platform_admin acting inside tenant `inTenant` (`act` claim). */
  acting: (inTenant = T) =>
    user({
      tid: '00000000-0000-7000-8000-000000000001',
      sub: OPERATOR,
      roles: ['platform_admin'],
      act: { tenant_id: inTenant, reason: 'ticket 42 support' },
    }),
  /** A service token as identity issues it: no tenant, no roles, `scope=internal`. */
  service: (from: 'engagement' | 'identity' | 'payments' = 'engagement', aud = 'payments') =>
    signJwt({
      alg: 'RS256',
      key: key.privateKey,
      kid: 'k1',
      claims: serviceClaims({ now: NOW, service: from, aud }),
    }),
};

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
