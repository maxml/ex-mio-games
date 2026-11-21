// Stub interfaces for the redemption saga (Stage A). Types only: no behaviour.
// Spec: docs/specs/engagement-store.md §4. The Postgres implementation of
// RedemptionStore is Stage B; frozen tests run against it through these types.
import type {
  CasinoRewardPort,
  EventEnvelope,
  RedemptionState,
  RewardMapping,
  RewardRequest,
} from '@ex-mio/contracts';

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

/**
 * An extra registered event written to the outbox in the same transaction as a state change
 * (the store stamps `redemption_id`, `player_id` and `sandbox`). The saga publishes none after
 * decision D-1; the hook stays because it is how atomicity is pinned (an invalid payload must
 * leave nothing behind).
 */
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
  /**
   * `commit` or `release` the stock/limit reservation. Both act ONLY while the reservation is
   * `reserved`: a second release restores nothing, a commit after a release does nothing (D-8).
   */
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
  | 'idempotency_key_reused'
  /** Thrown by the saga (not the store) when the coin reserve answers 409 insufficient_funds. */
  | 'insufficient_funds';

export class StoreRejection extends Error {
  constructor(readonly code: StoreRejectionCode) {
    super(code);
    this.name = 'StoreRejection';
  }
}

/**
 * Every method is ONE atomic transaction, tenant-scoped (RLS). It either does
 * all of its writes (row, history, reservation counters, outbox, inbox, work queue) or none.
 * `apply` is the choke point of three invariants, whoever calls it:
 *  1. a (from, to) pair outside REDEMPTION_TRANSITIONS throws IllegalTransitionError;
 *  2. NEEDS_REVIEW -> UNKNOWN (replay) throws IllegalTransitionError unless the latest entry
 *     into NEEDS_REVIEW came from UNKNOWN (the coins are still held, decision D-8);
 *  3. `reservation: 'release'` restores stock and the player's counter only while the
 *     reservation is `reserved` (stock is returned exactly once, whatever the path).
 * Implementations take a clock: `new PgRedemptionStore(db, { now })`, `new MemoryStore(now)`.
 */
export interface RedemptionStore {
  /**
   * Create the order: conditional decrement of stock and of the player's limit
   * (never below zero), freeze price and reward mapping, insert REQUESTED with
   * `nextAttemptAt = now + 30 s` (the sweeper re-sends the coin reserve if the inline call never
   * finished), status_changed outbox event only. Same (tenant, player, operationKey) and same
   * item: returns the existing order, `created: false`, nothing else changes. Same key, other
   * item: throws StoreRejection('idempotency_key_reused').
   */
  placeOrder(
    scope: Scope,
    input: { operationKey: string; itemId: string },
  ): Promise<{ redemption: RedemptionRecord; created: boolean }>;

  apply(tenantId: string, redemptionId: string, change: StateChange): Promise<ApplyResult>;

  /**
   * Move the next sweep time without changing state (a still-unknown inquiry).
   * Applies only while the state equals `expectState`. Writes no history and no event.
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

  /**
   * Cross-tenant worker query over the RLS-free work queue (no PII). Never bypasses RLS.
   * Due = state in REQUESTED, RESERVED, ISSUING, UNKNOWN, ISSUED, REJECTED (each has a call to
   * make) and (`nextAttemptAt` is null or <= now). Never due: REJECTED_FUNDS, COMPLETED,
   * RELEASED, REFUNDED, NEEDS_REVIEW.
   */
  dueForSweep(now: Date): Promise<{ tenantId: string; id: string }[]>;
}

export interface Clock {
  now(): Date;
}

// ---- the coin reserve: payments' synchronous internal API (decisions D-1, D-9) ----------------

/**
 * Refusal codes of the payments service (its `PAYMENTS_ERROR_CODES`): 409 insufficient_funds,
 * 409 invalid_reserve_transition (a conflicting transition, e.g. capture after release),
 * 404 reserve_not_found, 409 operation_conflict (same reserve id, other parameters).
 * ASSUMED names, copied from the payments Stage A contract; follow it if it moves.
 */
export type CoinsRefusalCode =
  | 'insufficient_funds'
  | 'invalid_reserve_transition'
  | 'reserve_not_found'
  | 'operation_conflict';

/** `ok` carries the reserve's amount. A thrown error means timeout or transport: retry the SAME key. */
export type CoinsReply = { ok: true; amount: number } | { ok: false; code: CoinsRefusalCode };

export interface CoinsCall {
  tenantId: string;
  playerId: string;
  /** Selects the sandbox or the production ledger; never part of the request body. */
  sandbox: boolean;
  /** The redemption id. */
  reserveId: string;
}

/**
 * HTTP client port. The idempotency key of each phase is `hold:{id}`, `capture:{id}`,
 * `release:{id}` or `refund:{id}`. Capture, release and refund are idempotent by the state of the
 * reserve: a repeat of an applied transition returns the stored result (D-9).
 */
export interface CoinsPort {
  reserve(call: CoinsCall & { amount: number }, idempotencyKey: string): Promise<CoinsReply>;
  capture(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply>;
  release(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply>;
  refund(call: CoinsCall, idempotencyKey: string): Promise<CoinsReply>;
}

// ---- the saga -----------------------------------------------------------------------------

export interface SagaDeps {
  store: RedemptionStore;
  coins: CoinsPort;
  /** Sandbox orders get the sandbox adapter, chosen from the ORDER's flag. Per tenant in production. */
  adapterFor(tenantId: string, sandbox: boolean): CasinoRewardPort;
  /**
   * Builds the casino request from the FROZEN order (price and mapping on the record), including
   * the player-id to external-player-id mapping. The same request is passed to `issueReward`
   * and to every `getRewardStatus`, so a casino without a lookup by key can replay it.
   */
  rewardRequest(order: RedemptionRecord): Promise<RewardRequest>;
  clock: Clock;
  random: () => number;
}

/** News from the casino outside our own calls (webhook or bus). `eventId` is its delivery id. */
export type CasinoReport =
  | { outcome: 'issued'; external_ref: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'revoked' };

export interface Operator {
  id: string;
  role: 'owner' | 'admin' | 'analyst';
}

export interface RedemptionSaga {
  /**
   * placeOrder, then the coin reserve inline (key `hold:{id}`). `insufficient_funds` releases
   * the reservation and throws StoreRejection('insufficient_funds') (HTTP 409). A transport
   * error leaves REQUESTED for the sweeper. A replay returns the stored result.
   */
  redeem(
    scope: Scope,
    operationKey: string,
    itemId: string,
  ): Promise<{ redemption: RedemptionRecord; created: boolean }>;
  /** One pass over everything due. Returns how many redemptions it acted on. */
  sweep(now: Date): Promise<number>;
  onCasinoReport(
    tenantId: string,
    id: string,
    report: CasinoReport,
    eventId: string,
  ): Promise<void>;
  /** Only for a review entered from UNKNOWN; otherwise rejects with code `illegal_transition`. */
  replay(tenantId: string, id: string): Promise<RedemptionRecord>;
  resolveReview(
    tenantId: string,
    id: string,
    input: { outcome: 'issued' | 'not_issued'; reason: string; operator: Operator },
  ): Promise<RedemptionRecord>;
}

export type { EventEnvelope };
