import { z } from 'zod';
import { CasinoRewardApiConfig, Uuid } from '@ex-mio/contracts';
import type { Transport } from './adapter';
import type { PlayerDirectoryPort, TenantIntegration, TenantIntegrationPort } from './ports';

/**
 * Development stand-in for the identity service's integration credentials (spec section 10): the
 * `INGEST_STATIC_TENANTS` JSON, keyed by tenant slug. The real identity client replaces it.
 */
const StaticTenant = z
  .object({
    tenant_id: Uuid,
    casino: z.string().min(1),
    status: z.enum(['active', 'suspended']),
    webhook_secrets: z.array(z.string().min(1)).min(1).max(2),
    player_hash_key: z.string().min(1),
    reward_api: CasinoRewardApiConfig.optional(),
  })
  .strict();

export function staticTenantIntegrations(raw: string | undefined): TenantIntegrationPort {
  const parsed = z.record(StaticTenant).parse(raw ? JSON.parse(raw) : {});
  const bySlug = new Map<string, TenantIntegration>(Object.entries(parsed));
  const byId = new Map<string, TenantIntegration>(
    [...bySlug.values()].map((t) => [t.tenant_id, t]),
  );
  return {
    lookup: async (slug) => bySlug.get(slug),
    lookupById: async (id) => byId.get(id),
  };
}

/** Until identity's player mapping client is wired (epic L1), resolving a player fails loudly. */
export const unconfiguredPlayerDirectory: PlayerDirectoryPort = {
  resolveOrCreate: async () => {
    throw new Error('PLAYER_DIRECTORY is not configured: the identity client is not wired yet');
  },
};

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
