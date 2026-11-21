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
  const parsed = z.record(TenantIntegrationSchema).parse(raw ? JSON.parse(raw) : {});
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
