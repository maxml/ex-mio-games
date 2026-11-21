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
 * will run against the Postgres store (redemption-store.conformance.ts).
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

  private emit(tenantId: string, type: string, payload: Record<string, unknown>): void {
    this.outbox.push({
      relayed: false,
      envelope: createEvent({
        type: type as never,
        tenantId,
        payload: payload as never,
      }),
    });
  }

  async placeOrder(
    scope: Scope,
    input: { operationKey: string; itemId: string },
  ): Promise<{ redemption: RedemptionRecord; created: boolean }> {
    for (const r of this.redemptions.values()) {
      if (
        r.tenantId === scope.tenantId &&
        r.playerId === scope.playerId &&
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
    if (item.perPlayerLimit !== null && used >= item.perPlayerLimit)
      throw new StoreRejection('limit_reached');
    if (item.stock !== null && item.stock <= 0) throw new StoreRejection('out_of_stock');
    if (item.stock !== null) item.stock -= 1;
    this.used.set(usedKey, used + 1);
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
      nextAttemptAt: null,
      unknownSince: null,
      casinoReference: null,
      failureReason: null,
      reservation: 'reserved',
      history: [{ from: null, to: 'REQUESTED', cause: 'order_placed', at }],
      createdAt: at,
      updatedAt: at,
    };
    this.redemptions.set(rec.id, rec);
    this.emit(rec.tenantId, 'engagement.redemption.status_changed', {
      redemption_id: rec.id,
      player_id: rec.playerId,
      sandbox: rec.sandbox,
      from: null,
      to: 'REQUESTED',
      cause: 'order_placed',
    });
    this.emit(rec.tenantId, 'engagement.hold.place', {
      operation_id: `hold:${rec.id}`,
      redemption_id: rec.id,
      player_id: rec.playerId,
      sandbox: rec.sandbox,
      amount: rec.price,
    });
    return { redemption: structuredClone(rec), created: true };
  }

  async apply(tenantId: string, redemptionId: string, change: StateChange): Promise<ApplyResult> {
    const rec = this.redemptions.get(redemptionId);
    if (!rec || rec.tenantId !== tenantId) throw new Error('redemption not found');
    if (change.dedupe) {
      const k = `${change.dedupe.consumer}\u001f${change.dedupe.eventId}`;
      if (this.inbox.has(k)) return { applied: false, redemption: structuredClone(rec) };
    }
    if (!change.expectFrom.includes(rec.state))
      return { applied: false, redemption: structuredClone(rec) };
    if (!isOracleLegal(rec.state, change.to)) {
      // Same name as model/redemption-state's IllegalTransitionError; tests match on `name`.
      const err = new Error(`illegal transition ${rec.state} -> ${change.to}`);
      err.name = 'IllegalTransitionError';
      throw err;
    }
    if (change.dedupe) this.inbox.add(`${change.dedupe.consumer}\u001f${change.dedupe.eventId}`);
    const at = this.now();
    const from: RedemptionState = rec.state;
    rec.state = change.to;
    rec.updatedAt = at;
    rec.history.push({ from, to: change.to, cause: change.cause, at });
    if (change.attemptsReset) rec.attempts = 0;
    if (change.attemptsIncrement) rec.attempts += 1;
    if (change.nextAttemptAt !== undefined) rec.nextAttemptAt = change.nextAttemptAt;
    if (change.casinoReference !== undefined) rec.casinoReference = change.casinoReference;
    if (change.failureReason !== undefined) rec.failureReason = change.failureReason;
    if (change.to === 'UNKNOWN' && from !== 'UNKNOWN' && rec.unknownSince === null)
      rec.unknownSince = at;
    if (change.to === 'ISSUED' || change.to === 'REJECTED' || change.to === 'NEEDS_REVIEW')
      rec.unknownSince = null;
    if (change.reservation === 'commit') rec.reservation = 'committed';
    if (change.reservation === 'release') {
      rec.reservation = 'released';
      const item = this.items.get(rec.itemId);
      if (item && item.stock !== null) item.stock += 1;
      const k = `${rec.tenantId}:${rec.playerId}:${rec.itemId}`;
      this.used.set(k, Math.max(0, (this.used.get(k) ?? 1) - 1));
    }
    const base = { redemption_id: rec.id, player_id: rec.playerId, sandbox: rec.sandbox };
    this.emit(tenantId, 'engagement.redemption.status_changed', {
      ...base,
      from,
      to: change.to,
      cause: change.cause,
    });
    if (change.to === 'ISSUED' && change.casinoReference)
      this.emit(tenantId, 'engagement.redemption.issued', {
        ...base,
        casino_reference: change.casinoReference,
        price: rec.price,
      });
    if (change.to === 'REJECTED' || change.to === 'REJECTED_FUNDS')
      this.emit(tenantId, 'engagement.redemption.rejected', {
        ...base,
        reason: change.failureReason ?? change.cause,
      });
    if (change.to === 'NEEDS_REVIEW')
      this.emit(tenantId, 'engagement.redemption.needs_review', {
        ...base,
        reason: change.failureReason ?? change.cause,
      });
    for (const m of change.outbox ?? []) {
      this.emit(tenantId, m.type, {
        ...m.payload,
        redemption_id: rec.id,
        player_id: rec.playerId,
        sandbox: rec.sandbox,
      });
    }
    return { applied: true, redemption: structuredClone(rec) };
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
          (r.state === 'RESERVED' || r.state === 'ISSUING' || r.state === 'UNKNOWN') &&
          (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= now.getTime()),
      )
      .map((r) => ({ tenantId: r.tenantId, id: r.id }));
  }
}
