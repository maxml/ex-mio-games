import type { CasinoPlayerPort, CasinoRewardApiConfig } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

// STAGE A STUB: interfaces and DI tokens only. Specified in docs/specs/engagement-ingest.md section 4.

/** Source of per-tenant integration settings: the identity service (static config in dev). */
export const TENANT_INTEGRATIONS = Symbol('TENANT_INTEGRATIONS');
export interface TenantIntegration {
  tenant_id: string;
  casino: string; // adapter registry key
  status: 'active' | 'suspended';
  /** One or two active secrets (two while a rotation is open). */
  webhook_secrets: string[];
  /**
   * D-12: the per-tenant key of the HMAC that replaces the raw casino player id in
   * `inbound_events`. Never logged, never published.
   */
  player_hash_key: string;
  /** D-12: where and how to issue rewards. A tenant without it has no reward port. */
  reward_api?: CasinoRewardApiConfig;
}
export interface TenantIntegrationPort {
  lookup(tenantSlug: string): Promise<TenantIntegration | undefined>;
  /** Same record by tenant id; the per-tenant adapter registry resolves through this. */
  lookupById(tenantId: string): Promise<TenantIntegration | undefined>;
}

/** The registry per tenant (D-12): `CasinoRewardPorts` of the contracts package. */
export const TENANT_CASINO_PORTS = Symbol('TENANT_CASINO_PORTS');
/** The casino player id from the identity mapping: `CasinoPlayerPort` of the contracts package. */
export const CASINO_PLAYERS = Symbol('CASINO_PLAYERS');
export type { CasinoPlayerPort };

export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): Date;
}

export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

/** The identity service is the only writer of the player mapping (resolveOrCreatePlayer). */
export const PLAYER_DIRECTORY = Symbol('PLAYER_DIRECTORY');
export interface PlayerDirectoryPort {
  resolveOrCreate(tenantId: string, source: string, externalPlayerId: string): Promise<string>;
}

export interface InboundEventRow {
  tenantId: string;
  source: string;
  externalEventId: string;
  /**
   * D-12: hex HMAC-SHA256 of the casino player id, keyed with `TenantIntegration.player_hash_key`
   * over `${source}\n${external_player_id}`. The raw id is not a field of this row and not a column
   * of `inbound_events`; it lives only in the identity player mapping (MIO-107 deletes it there).
   */
  externalPlayerHmac: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}

/** Model layer. UNIQUE (tenant_id, source, external_event_id) lives in its migration. */
export abstract class InboundEventsRepository {
  /** INSERT ... ON CONFLICT DO NOTHING; on conflict returns the existing row's id. */
  abstract insertIfAbsent(tx: Tx, row: InboundEventRow): Promise<{ inserted: boolean; id: string }>;
}
