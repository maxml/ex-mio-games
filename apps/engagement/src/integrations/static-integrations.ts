import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TenantIntegration as TenantIntegrationSchema } from '@ex-mio/contracts';
import type { Transport } from './adapter';
import type { PlayerDirectoryPort, TenantIntegration, TenantIntegrationPort } from './ports';

/**
 * Development stand-in for the identity service's integration credentials (spec section 10): the
 * `INGEST_STATIC_TENANTS` JSON, keyed by tenant slug. Every record is parsed with identity's own
 * `TenantIntegration` contract (X-7), so the dev path enforces the same shape the identity client
 * returns: 1..2 non-empty webhook secrets, `platform`, `environment`. The real identity client
 * replaces it.
 */
export function staticTenantIntegrations(raw: string | undefined): TenantIntegrationPort {
  // Development values are short on purpose (`dev-hash-key-1`): everything else is the real contract.
  const devShape = TenantIntegrationSchema.extend({ player_hash_key: z.string().min(1) });
  const parsed = z.record(devShape).parse(raw ? JSON.parse(raw) : {});
  const bySlug = new Map<string, TenantIntegration>(Object.entries(parsed));
  const byId = new Map<string, TenantIntegration>(
    [...bySlug.values()].map((t) => [t.tenant_id, t]),
  );
  return {
    lookup: async (slug) => bySlug.get(slug),
    lookupById: async (id) => byId.get(id),
  };
}

/**
 * The dev stand-in sits in FRONT of identity instead of replacing it: a slug or tenant id the static
 * JSON does not name still resolves through identity, so tenants made by a real signup keep working
 * in a stack that also configures static tenants (the compose file does).
 */
export function staticThenIdentity(
  statics: TenantIntegrationPort,
  identity: TenantIntegrationPort,
): TenantIntegrationPort {
  return {
    lookup: async (slug) => (await statics.lookup(slug)) ?? identity.lookup(slug),
    lookupById: async (id) => (await statics.lookupById(id)) ?? identity.lookupById(id),
  };
}

/**
 * Static tenants exist only in this service, so identity has no tenant to hold a player for them:
 * their player id is a stable UUID derived from the tenant, the source and the casino's id. Any other
 * tenant goes to identity, the only writer of the real mapping (X-1).
 */
export function staticThenIdentityPlayers(
  statics: TenantIntegrationPort,
  identity: PlayerDirectoryPort,
): PlayerDirectoryPort {
  return {
    async resolveOrCreate(tenantId, source, externalPlayerId) {
      if (!(await statics.lookupById(tenantId)))
        return identity.resolveOrCreate(tenantId, source, externalPlayerId);
      const h = createHash('sha256')
        .update(`${tenantId}\n${source}\n${externalPlayerId}`)
        .digest('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
  };
}

/** The outbound transport of the casino adapters: one JSON request, the parsed body back. */
export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, body };
};
