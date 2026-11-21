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
}
export interface TenantIntegrationPort {
  lookup(tenantSlug: string): Promise<TenantIntegration | undefined>;
}

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
  externalPlayerId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}

/** Model layer. UNIQUE (tenant_id, source, external_event_id) lives in its migration. */
export abstract class InboundEventsRepository {
  /** INSERT ... ON CONFLICT DO NOTHING; on conflict returns the existing row's id. */
  abstract insertIfAbsent(tx: Tx, row: InboundEventRow): Promise<{ inserted: boolean; id: string }>;
}
