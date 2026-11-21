// Stub interfaces for the redemption saga (Stage A). Types only: no behaviour.
// Spec: docs/specs/engagement-store.md §4. The Postgres implementation of
// RedemptionStore is Stage B; frozen tests run against it through these types.
import type { EventEnvelope, RedemptionState, RewardMapping } from '@ex-mio/contracts';

/** Who is acting. `sandbox` comes from server-side context, never from a body. */
export interface Scope {
  tenantId: string;
  playerId: string;
  sandbox: boolean;
}

export interface RedemptionRecord {
  id: string;
  tenantId: string;
  playerId: string;
  sandbox: boolean;
  itemId: string;
  itemVersion: number;
  /** Frozen at order time. */
  price: number;
  /** Frozen at order time. */
  reward: RewardMapping;
  /** Durable business-operation id: the caller's Idempotency-Key. */
  operationKey: string;
  state: RedemptionState;
  attempts: number;
  /** When the sweeper may act next; null when nothing is scheduled. */
  nextAttemptAt: Date | null;
  /** When the redemption first entered UNKNOWN in its current unknown streak. */
  unknownSince: Date | null;
  casinoReference: string | null;
  failureReason: string | null;
  reservation: 'reserved' | 'committed' | 'released';
  history: { from: RedemptionState | null; to: RedemptionState; cause: string; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

/** A command or event written to the outbox in the same transaction as a state change. */
export interface OutboxMessage {
  type: string;
  payload: Record<string, unknown>;
  causationId?: string | null;
}

export interface StateChange {
  /** Applied only if the current state is one of these; otherwise `applied: false` (a lost race). */
  expectFrom: RedemptionState[];
  to: RedemptionState;
  cause: string;
  outbox?: OutboxMessage[];
  reservation?: 'commit' | 'release';
  attemptsIncrement?: boolean;
  /** Set attempts back to zero (only `replay` uses it). */
  attemptsReset?: boolean;
  nextAttemptAt?: Date | null;
  casinoReference?: string;
  failureReason?: string;
  /** Record the inbox row (consumer, eventId) in the same transaction; a repeat applies nothing. */
  dedupe?: { consumer: string; eventId: string };
}

export interface ApplyResult {
  applied: boolean;
  redemption: RedemptionRecord;
}

export type StoreRejectionCode =
  | 'item_not_found'
  | 'item_inactive'
  | 'out_of_stock'
  | 'limit_reached'
  | 'idempotency_key_reused';

export class StoreRejection extends Error {
  constructor(readonly code: StoreRejectionCode) {
    super(code);
    this.name = 'StoreRejection';
  }
}

/**
 * Every method is ONE atomic transaction, tenant-scoped (RLS). It either does
 * all of its writes (row, history, reservation counters, outbox, inbox) or none.
 * `apply` rejects a (from, to) pair outside REDEMPTION_TRANSITIONS by throwing
 * IllegalTransitionError, whoever calls it: this is the choke point.
 */
export interface RedemptionStore {
  /**
   * Create the order: conditional decrement of stock and of the player's limit
   * (never below zero), freeze price and reward mapping, insert REQUESTED,
   * outbox `engagement.hold.place` with operation_id `hold:{id}`. Same
   * (tenant, player, operationKey) and same item: returns the existing order,
   * `created: false`, nothing else changes. Same key, other item: throws
   * StoreRejection('idempotency_key_reused').
   */
  placeOrder(
    scope: Scope,
    input: { operationKey: string; itemId: string },
  ): Promise<{ redemption: RedemptionRecord; created: boolean }>;

  apply(tenantId: string, redemptionId: string, change: StateChange): Promise<ApplyResult>;

  /**
   * Move the next sweep time without changing state (a still-unknown inquiry).
   * Applies only while the state equals `expectState`.
   */
  reschedule(
    tenantId: string,
    redemptionId: string,
    expectState: RedemptionState,
    nextAttemptAt: Date,
  ): Promise<void>;

  /** Own redemption only: the lookup key is (tenant, player, sandbox, id). Null when not found. */
  getOwn(scope: Scope, redemptionId: string): Promise<RedemptionRecord | null>;
  getForOperator(tenantId: string, redemptionId: string): Promise<RedemptionRecord | null>;
  listForOperator(tenantId: string, state?: RedemptionState): Promise<RedemptionRecord[]>;

  /** Cross-tenant worker query over the RLS-free work queue (no PII). Never bypasses RLS. */
  dueForSweep(now: Date): Promise<{ tenantId: string; id: string }[]>;
}

/** Durable boundaries inside the saga that no store transaction covers. */
export type CrashBoundary = 'after_issuing_committed' | 'after_casino_effect';

export interface CrashPoints {
  hit(boundary: CrashBoundary): Promise<void> | void;
}

export interface Clock {
  now(): Date;
}

export type { EventEnvelope };
