import { createEvent, uuidv7, type EventEnvelope, type RedemptionState } from '@ex-mio/contracts';
import {
  StoreRejection,
  type ApplyResult,
  type RedemptionRecord,
  type RedemptionStore,
  type Scope,
  type StateChange,
} from '../ports';
import { isOracleLegal } from './transition-oracle';

/**
 * In-memory RedemptionStore used by the saga tests. Test support, not
 * production code: it models the atomic contract in ports.ts (each method is
 * all-or-nothing) and is itself checked by the same conformance suite that
 * runs against the Postgres store (testing/store-conformance.ts).
 *
 * `apply` validates and builds everything first and mutates last, so a failure
 * (illegal pair, invalid event payload) leaves no trace.
 */
export interface MemItem {
  id: string;
  version: number;
  price: number;
  reward: { type: string; params: Record<string, string | number | boolean> };
  stock: number | null;
  perPlayerLimit: number | null;
  active: boolean;
}

export interface OutboxRow {
  envelope: EventEnvelope;
  relayed: boolean;
}

/** The sweeper re-sends the coin reserve of a REQUESTED order after this long. */
const REQUEST_GRACE_MS = 30_000;
const SWEPT: ReadonlySet<RedemptionState> = new Set([
  'REQUESTED',
  'RESERVED',
  'ISSUING',
  'UNKNOWN',
  'ISSUED',
  'REJECTED',
]);

const illegal = (message: string): Error => {
  // Same name as model/redemption-state's IllegalTransitionError; tests match on `name`.
  const err = new Error(message);
  err.name = 'IllegalTransitionError';
  return err;
};

export class MemoryStore implements RedemptionStore {
  readonly items = new Map<string, MemItem>();
  readonly redemptions = new Map<string, RedemptionRecord>();
  readonly outbox: OutboxRow[] = [];
  private readonly inbox = new Set<string>();
  private readonly used = new Map<string, number>(); // `${tenant}:${player}:${item}` -> count
  constructor(private readonly now: () => Date = () => new Date()) {}

  addItem(partial: Partial<MemItem> & { price: number }): MemItem {
    const item: MemItem = {
      id: uuidv7(),
      version: 1,
      reward: { type: 'free_spins', params: { count: 10 } },
      stock: null,
      perPlayerLimit: null,
      active: true,
      ...partial,
    };
    this.items.set(item.id, item);
    return item;
  }

  editItem(id: string, patch: Partial<MemItem>): void {
    const it = this.items.get(id);
    if (!it) throw new Error('no item');
    Object.assign(it, patch, { version: it.version + 1 });
  }

  /** Items shown to players: active only. */
  stockOf(id: string): number | null {
    return this.items.get(id)?.stock ?? null;
  }

  /** X-13/D-13: the sandbox flag goes on the ENVELOPE (createEvent), never into the payload. */
  private envelope(
    tenantId: string,
    type: string,
    payload: Record<string, unknown>,
    sandbox: boolean,
  ): OutboxRow {
    return {
      relayed: false,
      envelope: createEvent({
        type: type as never,
        tenantId,
        payload: payload as never,
        sandbox,
      }),
    };
  }

  async placeOrder(
    scope: Scope,
    input: { operationKey: string; itemId: string },
  ): Promise<{ redemption: RedemptionRecord; created: boolean }> {
    for (const r of this.redemptions.values()) {
      if (
        r.tenantId === scope.tenantId &&
        r.playerId === scope.playerId &&
        r.sandbox === scope.sandbox &&
        r.operationKey === input.operationKey
      ) {
        if (r.itemId !== input.itemId) throw new StoreRejection('idempotency_key_reused');
        return { redemption: structuredClone(r), created: false };
      }
    }
    const item = this.items.get(input.itemId);
    if (!item) throw new StoreRejection('item_not_found');
    if (!item.active) throw new StoreRejection('item_inactive');
    const usedKey = `${scope.tenantId}:${scope.playerId}:${item.id}`;
    const used = this.used.get(usedKey) ?? 0;
    // D-28, like Postgres (redemption.store.ts): stock and the per-player limit are production-only.
    if (!scope.sandbox) {
      if (item.perPlayerLimit !== null && used >= item.perPlayerLimit)
        throw new StoreRejection('limit_reached');
      if (item.stock !== null && item.stock <= 0) throw new StoreRejection('out_of_stock');
    }
    const at = this.now();
    const rec: RedemptionRecord = {
      id: uuidv7(),
      tenantId: scope.tenantId,
      playerId: scope.playerId,
      sandbox: scope.sandbox,
      itemId: item.id,
      itemVersion: item.version,
      price: item.price,
      reward: structuredClone(item.reward),
      operationKey: input.operationKey,
      state: 'REQUESTED',
      attempts: 0,
      nextAttemptAt: new Date(at.getTime() + REQUEST_GRACE_MS),
      unknownSince: null,
      casinoReference: null,
      failureReason: null,
      rewardRequest: null,
      firstIssuingAt: null,
      reservation: 'reserved',
      history: [{ from: null, to: 'REQUESTED', cause: 'order_placed', at }],
      createdAt: at,
      updatedAt: at,
    };
    const row = this.envelope(
      rec.tenantId,
      'engagement.redemption.status_changed',
      {
        redemption_id: rec.id,
        player_id: rec.playerId,
        from: null,
        to: 'REQUESTED',
        cause: 'order_placed',
      },
      rec.sandbox,
    );
    // every check and every envelope is done: mutate
    if (!scope.sandbox) {
      if (item.stock !== null) item.stock -= 1;
      this.used.set(usedKey, used + 1);
    }
    this.redemptions.set(rec.id, rec);
    this.outbox.push(row);
    return { redemption: structuredClone(rec), created: true };
  }

  async apply(tenantId: string, redemptionId: string, change: StateChange): Promise<ApplyResult> {
    const rec = this.redemptions.get(redemptionId);
    if (!rec || rec.tenantId !== tenantId) throw new Error('redemption not found');
    const dedupeKey = change.dedupe
      ? `${tenantId}\u001f${change.dedupe.consumer}\u001f${change.dedupe.eventId}`
      : null;
    if (dedupeKey && this.inbox.has(dedupeKey))
      return { applied: false, redemption: structuredClone(rec) };
    if (!change.expectFrom.includes(rec.state))
      return { applied: false, redemption: structuredClone(rec) };
    if (!isOracleLegal(rec.state, change.to))
      throw illegal(`illegal transition ${rec.state} -> ${change.to}`);
    if (rec.state === 'NEEDS_REVIEW' && change.to === 'UNKNOWN') {
      const entered = [...rec.history].reverse().find((h) => h.to === 'NEEDS_REVIEW');
      if (entered?.from !== 'UNKNOWN')
        throw illegal(`replay refused: the review was entered from ${entered?.from ?? 'nowhere'}`);
    }

    // build everything before touching anything
    const at = this.now();
    const from: RedemptionState = rec.state;
    const next = structuredClone(rec);
    next.state = change.to;
    next.updatedAt = at;
    next.history.push({ from, to: change.to, cause: change.cause, at });
    if (change.attemptsReset) next.attempts = 0;
    if (change.attemptsIncrement) next.attempts += 1;
    if (change.nextAttemptAt !== undefined) next.nextAttemptAt = change.nextAttemptAt;
    if (change.casinoReference !== undefined) next.casinoReference = change.casinoReference;
    if (change.failureReason !== undefined) next.failureReason = change.failureReason;
    if (change.rewardRequest !== undefined)
      next.rewardRequest = structuredClone(change.rewardRequest);
    if (change.to === 'ISSUING' && next.firstIssuingAt === null) next.firstIssuingAt = at;
    if (change.to === 'UNKNOWN' && next.unknownSince === null) next.unknownSince = at;
    if (change.to === 'ISSUED' || change.to === 'REJECTED' || change.to === 'NEEDS_REVIEW')
      next.unknownSince = null;
    let restoreStock = false;
    if (change.reservation && rec.reservation === 'reserved') {
      next.reservation = change.reservation === 'commit' ? 'committed' : 'released';
      restoreStock = change.reservation === 'release';
    }
    const base = { redemption_id: rec.id, player_id: rec.playerId };
    const sandbox = rec.sandbox;
    const rows: OutboxRow[] = [
      this.envelope(
        tenantId,
        'engagement.redemption.status_changed',
        { ...base, from, to: change.to, cause: change.cause },
        sandbox,
      ),
    ];
    if (change.to === 'ISSUED' && change.casinoReference)
      rows.push(
        this.envelope(
          tenantId,
          'engagement.redemption.issued',
          { ...base, casino_reference: change.casinoReference, price: rec.price },
          sandbox,
        ),
      );
    if (change.to === 'REJECTED' || change.to === 'REJECTED_FUNDS')
      rows.push(
        this.envelope(
          tenantId,
          'engagement.redemption.rejected',
          { ...base, reason: change.failureReason ?? change.cause },
          sandbox,
        ),
      );
    if (change.to === 'NEEDS_REVIEW')
      rows.push(
        this.envelope(
          tenantId,
          'engagement.redemption.needs_review',
          { ...base, reason: change.failureReason ?? change.cause },
          sandbox,
        ),
      );
    for (const m of change.outbox ?? [])
      rows.push(this.envelope(tenantId, m.type, { ...m.payload, ...base }, sandbox));

    // commit
    if (dedupeKey) this.inbox.add(dedupeKey);
    this.redemptions.set(rec.id, next);
    if (restoreStock && !rec.sandbox) {
      const item = this.items.get(rec.itemId);
      if (item && item.stock !== null) item.stock += 1;
      const k = `${rec.tenantId}:${rec.playerId}:${rec.itemId}`;
      this.used.set(k, Math.max(0, (this.used.get(k) ?? 1) - 1));
    }
    this.outbox.push(...rows);
    return { applied: true, redemption: structuredClone(next) };
  }

  async reschedule(
    tenantId: string,
    id: string,
    expectState: RedemptionState,
    nextAttemptAt: Date,
  ): Promise<void> {
    const r = this.redemptions.get(id);
    if (r && r.tenantId === tenantId && r.state === expectState) r.nextAttemptAt = nextAttemptAt;
  }

  async getOwn(scope: Scope, id: string): Promise<RedemptionRecord | null> {
    const r = this.redemptions.get(id);
    if (
      !r ||
      r.tenantId !== scope.tenantId ||
      r.playerId !== scope.playerId ||
      r.sandbox !== scope.sandbox
    )
      return null;
    return structuredClone(r);
  }

  async getForOperator(tenantId: string, id: string): Promise<RedemptionRecord | null> {
    const r = this.redemptions.get(id);
    return r && r.tenantId === tenantId ? structuredClone(r) : null;
  }

  async listForOperator(tenantId: string, state?: RedemptionState): Promise<RedemptionRecord[]> {
    return [...this.redemptions.values()]
      .filter((r) => r.tenantId === tenantId && (!state || r.state === state))
      .map((r) => structuredClone(r));
  }

  async dueForSweep(now: Date): Promise<{ tenantId: string; id: string }[]> {
    return [...this.redemptions.values()]
      .filter(
        (r) =>
          SWEPT.has(r.state) &&
          (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= now.getTime()),
      )
      .map((r) => ({ tenantId: r.tenantId, id: r.id }));
  }
}
