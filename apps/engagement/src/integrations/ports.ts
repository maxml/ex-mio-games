import type {
  CasinoPlayerPort,
  TenantIntegration as ContractTenantIntegration,
} from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

// STAGE A STUB: interfaces and DI tokens only. Specified in docs/specs/engagement-ingest.md section 4.

/** Source of per-tenant integration settings: the identity service (static config in dev). */
export const TENANT_INTEGRATIONS = Symbol('TENANT_INTEGRATIONS');
/**
 * X-7: the shape is identity's contract type, not a private one: `platform` (the adapter registry
 * key), `status`, `environment` (`production|sandbox`, the source of `envelope.sandbox` for a
 * deposit, X-3), 1..2 `webhook_secrets`, the per-tenant `player_hash_key` (D-12, never logged, never
 * published) and the optional `reward_api` (a tenant without it has no reward port).
 */
export type TenantIntegration = ContractTenantIntegration;
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
  /** D-26: the environment of the credential that verified the webhook; part of the dedupe key. */
  sandbox: boolean;
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

/** Model layer. UNIQUE (tenant_id, sandbox, source, external_event_id) lives in its migration. */
export abstract class InboundEventsRepository {
  /** INSERT ... ON CONFLICT DO NOTHING; on conflict returns the existing row's id. */
  abstract insertIfAbsent(tx: Tx, row: InboundEventRow): Promise<{ inserted: boolean; id: string }>;
}
