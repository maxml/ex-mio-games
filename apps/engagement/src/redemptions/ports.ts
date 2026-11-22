// Stub interfaces for the redemption saga (Stage A). Types only: no behaviour.
// Spec: docs/specs/engagement-store.md §4. The Postgres implementation of
// RedemptionStore is Stage B; frozen tests run against it through these types.
import type {
  CasinoRewardPorts,
  EventEnvelope,
  PaymentsErrorCode,
  RedemptionState,
  RewardMapping,
  RewardRequest,
  RewardRequestBuilder,
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
  /** X-6: the request built at RESERVED -> ISSUING and passed unchanged to every issue and lookup. */
  rewardRequest: RewardRequest | null;
  /** When the order FIRST entered ISSUING; the issue deadline counts from here (never reset by a replay). */
  firstIssuingAt: Date | null;
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
  /** Freeze the request (set with the change INTO ISSUING; the store sets `firstIssuingAt` once). */
  rewardRequest?: RewardRequest;
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

/** W-5: the caller's own redemptions. Implemented by the Postgres store; not part of the frozen contract. */
export interface OwnRedemptionLister {
  listOwn(scope: Scope): Promise<RedemptionRecord[]>;
}

export interface Clock {
  now(): Date;
}

// ---- the coin reserve: payments' synchronous internal API (decisions D-1, D-9) ----------------

/**
 * Refusal codes of the payments service, taken from the contracts (X-5, D-9: payments owns the
 * names and the store never defines a string union of its own). Mapping in the saga:
 * `insufficient_funds` -> REJECTED_FUNDS (answered to the player as 409); the four transition codes
 * and `reserve_not_found` -> NEEDS_REVIEW `<phase>_refused` with the code stored as the reason;
 * `operation_conflict`, `validation_failed`, `idempotency_key_reused`, `forbidden` -> NEEDS_REVIEW plus an
 * alert. `idempotency_in_progress` (409) and any 401/503 from the auth entry point (`TOKEN_*`,
 * `TENANT_STATUS_UNAVAILABLE`) are TRANSPORT: the client port throws, the saga retries the same key and
 * never reviews.
 */
export type CoinsRefusalCode = Extract<
  PaymentsErrorCode,
  | 'insufficient_funds'
  | 'reserve_already_captured'
  | 'reserve_already_released'
  | 'reserve_already_refunded'
  | 'reserve_not_captured'
  | 'reserve_not_found'
  | 'operation_conflict'
  | 'validation_failed'
  | 'idempotency_key_reused'
  | 'forbidden'
>;

/** `ok` carries the reserve's amount. A thrown error means timeout or transport: retry the SAME key. */
export type CoinsReply = { ok: true; amount: number } | { ok: false; code: CoinsRefusalCode };

export interface CoinsCall {
  tenantId: string;
  playerId: string;
  /**
   * Which wallet the hold is placed on. The client sends it in the BODY of the reserve only (X-4,
   * `ReserveCoinsRequest.sandbox`); the tenant is in the PATH (`PAYMENTS_INTERNAL_ROUTES`). It comes from
   * the order's server-side flag, never from the client.
   */
  sandbox: boolean;
  /** The redemption id (the reserve id; in the path of capture, release and refund). */
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
  /**
   * The ONE adapter registry (X-6, D-2, D-12; owned by the ingest epic): resolves the port and its
   * `info` (`recovery_mode`, `issue_deadline_ms`) per tenant and per ORDER flag. `undefined` means no
   * adapter for that tenant/environment: NEEDS_REVIEW `no_adapter` with the coins held. A REJECTED
   * promise (identity down) is transport: reschedule the same attempt, never refund.
   */
  ports: CasinoRewardPorts;
  /**
   * Builds the casino request from the FROZEN order (price and mapping on the record) and the
   * identity player link. `undefined` means no mapping (erased or never created): NEEDS_REVIEW
   * `player_unmapped` with the coins held. The built request is FROZEN on the order at
   * RESERVED -> ISSUING (`StateChange.rewardRequest`), so a later erasure cannot change it and every
   * lookup gets the same request. The issue deadline is `firstIssuingAt + info.issue_deadline_ms`.
   */
  requests: RewardRequestBuilder;
  clock: Clock;
  random: () => number;
}

/** News from the casino outside our own calls (webhook or bus). `eventId` is its delivery id. */
export type CasinoReport =
  | { outcome: 'issued'; external_ref: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'revoked' };

/** Identity's role vocabulary (X-15): `operator_admin` resolves reviews, `operator_staff` only reads. */
export interface Operator {
  id: string;
  role: 'operator_admin' | 'operator_staff';
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
