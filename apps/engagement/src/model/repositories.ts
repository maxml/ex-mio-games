import type { RewardSegment, RuleDefinition } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

// STAGE A STUB: abstract repository contracts only. Specified in docs/specs/engagement-ingest.md
// section 6 to 8. The SQL (and its migration) is Stage B.

export interface StoredRule {
  rule_id: string;
  version: number;
  definition: RuleDefinition;
}

export interface NewCredit {
  id: string;
  tenantId: string;
  userId: string;
  wheelId: string;
  sourceEventId: string;
  ruleId: string;
  ruleVersion: number;
  seq: number;
  /** X-3 / D-13: true when the credit came from a deposit through a sandbox credential. */
  sandbox?: boolean;
}

export interface SpinCredit {
  id: string;
  userId: string;
  wheelId: string;
  status: 'available' | 'used';
  /** The credit's own flag; a spin on a sandbox credit is a sandbox spin. */
  sandbox?: boolean;
}

export interface RewardTableVersion {
  wheelId: string;
  version: number;
  segments: RewardSegment[];
}

export interface SpinRecord {
  id: string;
  userId: string;
  creditId: string;
  operationId: string;
  seedVersion: number;
  tableVersion: number;
  hmac: string;
  segmentIndex: number;
  segmentLabel: string;
  rewardCoins: number;
}

export abstract class RulesRepository {
  /** Every rule version of the tenant (the engine picks the version active at `occurred_at`). */
  abstract listRules(tx: Tx): Promise<StoredRule[]>;
  /** How many times each rule already fired for this player. Keyed by rule_id. */
  abstract priorGrantCounts(tx: Tx, userId: string): Promise<Record<string, number>>;
}

export abstract class SpinCreditsRepository {
  /**
   * INSERT ... ON CONFLICT (tenant_id, source_event_id, rule_id, seq) DO NOTHING RETURNING.
   * Returns only the rows that were really inserted.
   */
  abstract grant(tx: Tx, rows: NewCredit[]): Promise<NewCredit[]>;
  /**
   * The ONLY way a credit leaves `available`. Exactly ONE row, never all of the player's credits:
   *   UPDATE spin_credits SET status='used', used_at=now()
   *    WHERE id = (SELECT id FROM spin_credits
   *                 WHERE tenant_id=$1 AND user_id=$2 AND status='available' [AND id=$3]
   *                 ORDER BY created_at, id
   *                 FOR UPDATE SKIP LOCKED LIMIT 1)
   *      AND status='available'
   *    RETURNING *.
   * `user_id` is in the SELECT on both paths (with and without `credit_id`). `SKIP LOCKED` is a
   * throughput choice (waiters take other rows instead of queueing); it is NOT a pinned invariant:
   * under READ COMMITTED the totals are the same without it (measured, review R2-4), so no test
   * claims to catch its removal. `undefined` means zero rows updated.
   */
  abstract consume(
    tx: Tx,
    input: { userId: string; creditId?: string },
  ): Promise<SpinCredit | undefined>;
  /**
   * `GET /v1/me/spins`: the number of `available` credits of ONE player in the ambient tenant.
   *   SELECT count(*) FROM spin_credits WHERE tenant_id=$1 AND user_id=$2 AND status='available'
   * `user_id` is the principal, never input.
   */
  abstract countAvailable(tx: Tx, input: { userId: string }): Promise<number>;
  /** Used only to tell 404 (not this player's) from 409 (theirs, not available). */
  abstract findOwn(
    tx: Tx,
    input: { userId: string; creditId: string },
  ): Promise<SpinCredit | undefined>;
}

export abstract class WheelsRepository {
  /** The latest published, immutable version of the wheel's reward table. */
  abstract activeTable(tx: Tx, wheelId: string): Promise<RewardTableVersion | undefined>;
  /** W-2: the tenant's active wheel: the wheel of its most recently published reward table. */
  abstract activeWheelId(tx: Tx): Promise<string | undefined>;
}

export abstract class SpinsRepository {
  /** `spins.operation_id` is UNIQUE per (tenant_id, user_id). */
  abstract findByOperation(
    tx: Tx,
    input: { userId: string; operationId: string },
  ): Promise<SpinRecord | undefined>;
  abstract insert(tx: Tx, spin: SpinRecord): Promise<void>;
}

/**
 * Server seeds per version. The seed itself never leaves the service. `seed(tenantId, version)` is
 * what lets a spin stored under an older version be recomputed after a rotation (MIO-063, MIO-069);
 * it throws for a version that does not exist.
 */
export const SEEDS = Symbol('SEEDS');
export interface SeedProvider {
  current(tenantId: string): { version: number; seed: string };
  seed(tenantId: string, version: number): string;
}

/**
 * Where seeds are kept, by version (env in dev, a secret store later). The real `SeedProvider` is
 * `createSeedProvider(store)` in `model/seeds.ts` (R2-3): `current` is the highest version in the
 * store, `seed` reads by the version asked for. A rotation is a new version added to the store.
 */
export interface SeedStore {
  versions(tenantId: string): number[];
  get(tenantId: string, version: number): string | undefined;
}
