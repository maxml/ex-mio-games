import type {
  EventEnvelope,
  IntegrationEnvironment,
  Role,
  TenantStatus,
  TenantType,
} from '@ex-mio/contracts';

/**
 * Data-access ports. Services depend on these, never on a driver. Two implementations exist: the
 * Postgres one (`pg-repos.ts`, production) and an in-memory one (`testing/memory-store.ts`, the
 * kernel the frozen tests run on). Both enforce the same unique keys, and a duplicate surfaces as
 * `UniqueViolationError`.
 */

/** Opaque transaction handle (an EntityManager in Postgres). */
export type Tx = unknown;

export interface UnitOfWork {
  /**
   * Run `fn` atomically. With a tenant id the transaction is tenant-scoped (`SET LOCAL
   * app.tenant_id`, row-level security applies); with `null` it is a platform transaction.
   */
  run<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Add an event to the outbox in the caller's transaction. */
  publish(tx: Tx, event: EventEnvelope): Promise<void>;
}

export interface TenantRow {
  id: string;
  type: TenantType;
  name: string;
  slug: string;
  status: TenantStatus;
  domains: string[];
  provider_tenant_id: string | null;
}

export interface UserRow {
  tenant_id: string;
  id: string;
  email: string | null;
  kind: 'staff' | 'player';
  roles: Role[];
}

export interface PlayerLinkRow {
  user_id: string;
  platform: string;
  external_player_id: string;
}

export interface CredentialRow {
  tenant_id: string;
  key_id: string;
  platform: string;
  /** X-3: a credential is for exactly one environment; it never changes after issue. */
  environment: IntegrationEnvironment;
  api_key_hash: string;
  secret_enc: string;
  status: 'active' | 'retiring' | 'revoked';
  /** Unix seconds; set while `retiring`. */
  retiring_until: number | null;
  created_at: number;
}

export interface AuditRow {
  tenant_id: string;
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_tenant_id: string | null;
  acting_tenant_id: string | null;
  action: string;
  reason: string;
  service: string | null;
  route: string | null;
  decision: string | null;
  caller_service: string | null;
}

export interface SigningKeyRow {
  kid: string;
  public_jwk: Record<string, string>;
  private_enc: string;
  created_at: number;
  retired: boolean;
}

export interface TenantsRepo {
  insert(tx: Tx, row: TenantRow): Promise<void>;
  findById(tx: Tx, id: string): Promise<TenantRow | null>;
  findBySlug(tx: Tx, slug: string): Promise<TenantRow | null>;
  findByDomain(tx: Tx, domain: string): Promise<TenantRow | null>;
  platform(tx: Tx): Promise<TenantRow | null>;
  setStatus(tx: Tx, id: string, status: TenantStatus): Promise<boolean>;
  setProviderTenant(tx: Tx, id: string, providerTenantId: string): Promise<void>;
  listOperatorSlugs(tx: Tx): Promise<string[]>;
}

export interface UsersRepo {
  insert(
    tx: Tx,
    row: { tenant_id: string; id: string; email: string | null; kind: 'staff' | 'player' },
  ): Promise<void>;
  insertRole(tx: Tx, tenantId: string, userId: string, role: Role): Promise<void>;
  insertProviderLink(
    tx: Tx,
    row: { tenant_id: string; user_id: string; provider: string; provider_uid: string },
  ): Promise<void>;
  providerUid(tx: Tx, tenantId: string, userId: string): Promise<string | null>;
  findByEmail(tx: Tx, tenantId: string, emailLower: string): Promise<UserRow | null>;
  findById(tx: Tx, tenantId: string, id: string): Promise<UserRow | null>;
  listStaff(tx: Tx, tenantId: string): Promise<UserRow[]>;
}

export interface PlayersRepo {
  find(
    tx: Tx,
    tenantId: string,
    platform: string,
    externalPlayerId: string,
  ): Promise<PlayerLinkRow | null>;
  findByUser(tx: Tx, tenantId: string, userId: string): Promise<PlayerLinkRow | null>;
  insert(tx: Tx, tenantId: string, row: PlayerLinkRow): Promise<void>;
  /** Erasure (MIO-107): delete the mapping row. True when a row existed. */
  delete(tx: Tx, tenantId: string, userId: string): Promise<boolean>;
  list(tx: Tx, tenantId: string): Promise<PlayerLinkRow[]>;
}

export interface LaunchJtiRepo {
  /** Throws UniqueViolationError when the nonce was already recorded for this tenant. */
  insert(tx: Tx, tenantId: string, jti: string, expiresAt: number): Promise<void>;
}

export interface CredentialsRepo {
  insert(tx: Tx, row: CredentialRow): Promise<void>;
  findByKeyId(tx: Tx, tenantId: string, keyId: string): Promise<CredentialRow | null>;
  findByApiKeyHash(tx: Tx, tenantId: string, hash: string): Promise<CredentialRow | null>;
  list(tx: Tx, tenantId: string): Promise<CredentialRow[]>;
  update(
    tx: Tx,
    tenantId: string,
    keyId: string,
    patch: { status: CredentialRow['status']; retiring_until: number | null },
  ): Promise<void>;
}

/** D-27: where MIO calls a casino to issue a reward, per tenant, casino platform and environment. */
export interface RewardApiRow {
  tenant_id: string;
  platform: string;
  environment: IntegrationEnvironment;
  base_url: string;
  /** Sealed with the credentials KEK; null when the casino needs no signing secret. */
  api_key_enc: string | null;
  issue_deadline_ms: number | null;
}

export interface RewardApisRepo {
  /** Insert, or replace the row of the same (tenant, platform, environment). */
  upsert(tx: Tx, row: RewardApiRow): Promise<void>;
  list(tx: Tx, tenantId: string): Promise<RewardApiRow[]>;
}

export interface AuditRepo {
  /** False when a row with this (tenant, id) already existed (a redelivery). */
  insert(tx: Tx, row: AuditRow): Promise<boolean>;
  list(tx: Tx, tenantId: string): Promise<AuditRow[]>;
}

export interface SigningKeysRepo {
  list(tx: Tx): Promise<SigningKeyRow[]>;
  insert(tx: Tx, row: SigningKeyRow): Promise<void>;
  retire(tx: Tx, kid: string): Promise<void>;
}

export interface Repos {
  tenants: TenantsRepo;
  users: UsersRepo;
  players: PlayersRepo;
  jti: LaunchJtiRepo;
  credentials: CredentialsRepo;
  rewardApis: RewardApisRepo;
  audit: AuditRepo;
  keys: SigningKeysRepo;
}

export interface Clock {
  /** Unix seconds. */
  now(): number;
}
