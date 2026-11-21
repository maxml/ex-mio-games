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
}

export interface SpinCredit {
  id: string;
  userId: string;
  wheelId: string;
  status: 'available' | 'used';
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
   * The ONLY way a credit leaves `available`:
   * UPDATE spin_credits SET status='used', used_at=now()
   *  WHERE tenant_id=$1 AND user_id=$2 AND status='available' [AND id=$3] RETURNING *.
   * `undefined` means zero rows updated.
   */
  abstract consume(
    tx: Tx,
    input: { userId: string; creditId?: string },
  ): Promise<SpinCredit | undefined>;
  /** Used only to tell 404 (not this player's) from 409 (theirs, not available). */
  abstract findOwn(
    tx: Tx,
    input: { userId: string; creditId: string },
  ): Promise<SpinCredit | undefined>;
}

export abstract class WheelsRepository {
  /** The latest published, immutable version of the wheel's reward table. */
  abstract activeTable(tx: Tx, wheelId: string): Promise<RewardTableVersion | undefined>;
}

export abstract class SpinsRepository {
  /** `spins.operation_id` is UNIQUE per (tenant_id, user_id). */
  abstract findByOperation(
    tx: Tx,
    input: { userId: string; operationId: string },
  ): Promise<SpinRecord | undefined>;
  abstract insert(tx: Tx, spin: SpinRecord): Promise<void>;
}

/** Server seeds per version. The seed itself never leaves the service. */
export const SEEDS = Symbol('SEEDS');
export interface SeedProvider {
  current(tenantId: string): { version: number; seed: string };
}
