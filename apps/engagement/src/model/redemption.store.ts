import { createEvent, uuidv7, type EventEnvelope, type RedemptionState } from '@ex-mio/contracts';
import { Db, type Tx } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import {
  StoreRejection,
  type ApplyResult,
  type Clock,
  type RedemptionRecord,
  type RedemptionStore,
  type Scope,
  type StateChange,
} from '../redemptions/ports';
import { assertTransition, IllegalTransitionError } from './redemption-state';

/** The sweeper re-sends the coin reserve of a REQUESTED order after this long. */
export const REQUEST_GRACE_MS = 30_000;

/** States that have a call to make: they are in the work queue. */
const SWEPT: ReadonlySet<RedemptionState> = new Set([
  'REQUESTED',
  'RESERVED',
  'ISSUING',
  'UNKNOWN',
  'ISSUED',
  'REJECTED',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_BATCH = 1000;

interface RedemptionRow {
  id: string;
  tenant_id: string;
  player_id: string;
  sandbox: boolean;
  item_id: string;
  item_version: number;
  price: number;
  reward: RedemptionRecord['reward'];
  operation_key: string;
  state: RedemptionState;
  attempts: number;
  next_attempt_at: Date | null;
  unknown_since: Date | null;
  casino_reference: string | null;
  failure_reason: string | null;
  reservation: RedemptionRecord['reservation'];
  created_at: Date;
  updated_at: Date;
}

interface HistoryRow {
  redemption_id: string;
  from_state: RedemptionState | null;
  to_state: RedemptionState;
  cause: string;
  at: Date;
}

const COLUMNS = `"id", "tenant_id", "player_id", "sandbox", "item_id", "item_version", "price", "reward",
  "operation_key", "state", "attempts", "next_attempt_at", "unknown_since", "casino_reference",
  "failure_reason", "reservation", "created_at", "updated_at"`;

const toRecord = (row: RedemptionRow, history: HistoryRow[]): RedemptionRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  playerId: row.player_id,
  sandbox: row.sandbox,
  itemId: row.item_id,
  itemVersion: row.item_version,
  price: row.price,
  reward: row.reward,
  operationKey: row.operation_key,
  state: row.state,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  unknownSince: row.unknown_since,
  casinoReference: row.casino_reference,
  failureReason: row.failure_reason,
  reservation: row.reservation,
  history: history.map((h) => ({ from: h.from_state, to: h.to_state, cause: h.cause, at: h.at })),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * `UPDATE`/`INSERT ... RETURNING` through TypeORM's `query` has driver-specific result shapes;
 * counting the rows inside a CTE gives one plain SELECT result everywhere.
 */
async function affected(tx: Tx, statement: string, params: unknown[]): Promise<number> {
  const rows: { n: number }[] = await tx.query(
    `WITH u AS (${statement} RETURNING 1) SELECT count(*)::int AS "n" FROM u`,
    params,
  );
  return rows[0]?.n ?? 0;
}

/**
 * The Postgres RedemptionStore (spec 4.1, 5). Every method is ONE transaction under the tenant's
 * RLS context (`runWithTenant` around the explicit tenant id), so it either does all of its writes
 * (row, history, counters, outbox, inbox, work queue) or none.
 */
export class PgRedemptionStore implements RedemptionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private inTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runWithTenant({ tenantId }, () => this.db.tenantTx(fn));
  }

  private event(
    tenantId: string,
    type: string,
    payload: Record<string, unknown>,
    causationId?: string | null,
  ): EventEnvelope {
    return createEvent({
      type: type as never,
      tenantId,
      payload: payload as never,
      ...(causationId ? { causationId } : {}),
    });
  }

  private async history(tx: Tx, ids: string[]): Promise<Map<string, HistoryRow[]>> {
    const out = new Map<string, HistoryRow[]>();
    if (ids.length === 0) return out;
    const rows: HistoryRow[] = await tx.query(
      `SELECT "redemption_id", "from_state", "to_state", "cause", "at" FROM "redemption_history"
       WHERE "redemption_id" = ANY($1::uuid[]) ORDER BY "id"`,
      [ids],
    );
    for (const r of rows) {
      const list = out.get(r.redemption_id) ?? [];
      list.push(r);
      out.set(r.redemption_id, list);
    }
    return out;
  }

  private async hydrate(tx: Tx, rows: RedemptionRow[]): Promise<RedemptionRecord[]> {
    const hist = await this.history(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toRecord(r, hist.get(r.id) ?? []));
  }

  private async loadOne(tx: Tx, id: string, lock = false): Promise<RedemptionRecord | null> {
    if (!UUID_RE.test(id)) return null;
    const rows: RedemptionRow[] = await tx.query(
      `SELECT ${COLUMNS} FROM "redemptions" WHERE "id" = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return (await this.hydrate(tx, rows))[0] ?? null;
  }

  private async syncQueue(tx: Tx, r: RedemptionRecord): Promise<void> {
    if (SWEPT.has(r.state)) {
      await tx.query(
        `INSERT INTO "redemption_work_queue" ("redemption_id", "tenant_id", "next_attempt_at")
         VALUES ($1, $2, $3)
         ON CONFLICT ("redemption_id") DO UPDATE SET "next_attempt_at" = EXCLUDED."next_attempt_at"`,
        [r.id, r.tenantId, r.nextAttemptAt],
      );
    } else {
      await tx.query(`DELETE FROM "redemption_work_queue" WHERE "redemption_id" = $1`, [r.id]);
    }
  }

  async placeOrder(
    scope: Scope,
    input: { operationKey: string; itemId: string },
  ): Promise<{ redemption: RedemptionRecord; created: boolean }> {
    return this.inTenant(scope.tenantId, async (tx) => {
      // Same (tenant, player, key) calls queue here, so the loser sees the winner's committed row.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        ['order', scope.tenantId, scope.playerId, String(scope.sandbox), input.operationKey].join(
          '\u001f',
        ),
      ]);
      const existing: { id: string; item_id: string }[] = await tx.query(
        `SELECT "id", "item_id" FROM "redemptions"
         WHERE "tenant_id" = $1 AND "player_id" = $2 AND "sandbox" = $3 AND "operation_key" = $4`,
        [scope.tenantId, scope.playerId, scope.sandbox, input.operationKey],
      );
      const have = existing[0];
      if (have) {
        if (have.item_id.toLowerCase() !== input.itemId.toLowerCase())
          throw new StoreRejection('idempotency_key_reused');
        const rec = await this.loadOne(tx, have.id);
        return { redemption: rec!, created: false };
      }

      if (!UUID_RE.test(input.itemId)) throw new StoreRejection('item_not_found');
      const items: {
        id: string;
        version: number;
        price: number;
        reward: RedemptionRecord['reward'];
        active: boolean;
      }[] = await tx.query(
        `SELECT "id", "version", "price", "reward", "active" FROM "store_items"
         WHERE "id" = $1 AND "tenant_id" = $2`,
        [input.itemId, scope.tenantId],
      );
      const item = items[0];
      if (!item) throw new StoreRejection('item_not_found');
      if (!item.active) throw new StoreRejection('item_inactive');

      // The per-player counter, then the stock: both conditional single statements, so the check
      // and the change cannot be separated by another transaction (never below zero).
      const counted = await affected(
        tx,
        `INSERT INTO "item_player_usage" ("tenant_id", "item_id", "player_id", "used")
         VALUES ($1, $2, $3, 1)
         ON CONFLICT ("tenant_id", "item_id", "player_id") DO UPDATE
           SET "used" = "item_player_usage"."used" + 1
           WHERE (SELECT "per_player_limit" FROM "store_items" WHERE "id" = $2) IS NULL
              OR "item_player_usage"."used" <
                 (SELECT "per_player_limit" FROM "store_items" WHERE "id" = $2)`,
        [scope.tenantId, item.id, scope.playerId],
      );
      if (counted === 0) throw new StoreRejection('limit_reached');
      const taken = await affected(
        tx,
        `UPDATE "store_items"
           SET "stock" = CASE WHEN "stock" IS NULL THEN NULL ELSE "stock" - 1 END
         WHERE "id" = $1 AND ("stock" IS NULL OR "stock" > 0)`,
        [item.id],
      );
      if (taken === 0) throw new StoreRejection('out_of_stock');

      const at = this.clock.now();
      const id = uuidv7();
      const nextAttemptAt = new Date(at.getTime() + REQUEST_GRACE_MS);
      await tx.query(
        `INSERT INTO "redemptions" ("id", "tenant_id", "player_id", "sandbox", "item_id", "item_version",
           "price", "reward", "operation_key", "state", "attempts", "next_attempt_at", "reservation",
           "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'REQUESTED', 0, $10, 'reserved', $11, $11)`,
        [
          id,
          scope.tenantId,
          scope.playerId,
          scope.sandbox,
          item.id,
          item.version,
          item.price,
          JSON.stringify(item.reward),
          input.operationKey,
          nextAttemptAt,
          at,
        ],
      );
      await tx.query(
        `INSERT INTO "redemption_history" ("tenant_id", "redemption_id", "from_state", "to_state", "cause", "at")
         VALUES ($1, $2, NULL, 'REQUESTED', 'order_placed', $3)`,
        [scope.tenantId, id, at],
      );
      await tx.query(
        `INSERT INTO "redemption_work_queue" ("redemption_id", "tenant_id", "next_attempt_at")
         VALUES ($1, $2, $3)`,
        [id, scope.tenantId, nextAttemptAt],
      );
      await this.db.publish(
        tx,
        this.event(scope.tenantId, 'engagement.redemption.status_changed', {
          redemption_id: id,
          player_id: scope.playerId,
          sandbox: scope.sandbox,
          from: null,
          to: 'REQUESTED',
          cause: 'order_placed',
        }),
      );
      return { redemption: (await this.loadOne(tx, id))!, created: true };
    });
  }

  async apply(tenantId: string, redemptionId: string, change: StateChange): Promise<ApplyResult> {
    return this.inTenant(tenantId, async (tx) => {
      // The row lock serializes every change of one redemption: the loser of a race re-reads the
      // winner's state and fails its `expectFrom` check.
      const rec = await this.loadOne(tx, redemptionId, true);
      if (!rec || rec.tenantId !== tenantId) throw new Error('redemption not found');

      if (change.dedupe) {
        const seen: unknown[] = await tx.query(
          `SELECT 1 FROM "redemption_inbox"
           WHERE "tenant_id" = $1 AND "consumer" = $2 AND "event_id" = $3`,
          [tenantId, change.dedupe.consumer, change.dedupe.eventId],
        );
        if (seen.length > 0) return { applied: false, redemption: rec };
      }
      if (!change.expectFrom.includes(rec.state)) return { applied: false, redemption: rec };
      assertTransition(rec.state, change.to);
      if (rec.state === 'NEEDS_REVIEW' && change.to === 'UNKNOWN') {
        const entered = [...rec.history].reverse().find((h) => h.to === 'NEEDS_REVIEW');
        if (entered?.from !== 'UNKNOWN')
          throw new IllegalTransitionError(
            `replay refused: the review was entered from ${entered?.from ?? 'nowhere'}`,
          );
      }

      const at = this.clock.now();
      const from = rec.state;
      const next: RedemptionRecord = { ...rec, state: change.to, updatedAt: at };
      if (change.attemptsReset) next.attempts = 0;
      if (change.attemptsIncrement) next.attempts += 1;
      if (change.nextAttemptAt !== undefined) next.nextAttemptAt = change.nextAttemptAt;
      if (change.casinoReference !== undefined) next.casinoReference = change.casinoReference;
      if (change.failureReason !== undefined) next.failureReason = change.failureReason;
      if (change.to === 'UNKNOWN' && next.unknownSince === null) next.unknownSince = at;
      if (change.to === 'ISSUED' || change.to === 'REJECTED' || change.to === 'NEEDS_REVIEW')
        next.unknownSince = null;
      let restoreStock = false;
      if (change.reservation && rec.reservation === 'reserved') {
        next.reservation = change.reservation === 'commit' ? 'committed' : 'released';
        restoreStock = change.reservation === 'release';
      }

      // Build every event before writing anything (an invalid payload throws here and the
      // transaction rolls back whatever was written, the inbox row included).
      const base = { redemption_id: rec.id, player_id: rec.playerId, sandbox: rec.sandbox };
      const reason = change.failureReason ?? change.cause;
      const events: EventEnvelope[] = [
        this.event(tenantId, 'engagement.redemption.status_changed', {
          ...base,
          from,
          to: change.to,
          cause: change.cause,
        }),
      ];
      if (change.to === 'ISSUED' && change.casinoReference)
        events.push(
          this.event(tenantId, 'engagement.redemption.issued', {
            ...base,
            casino_reference: change.casinoReference,
            price: rec.price,
          }),
        );
      if (change.to === 'REJECTED' || change.to === 'REJECTED_FUNDS')
        events.push(this.event(tenantId, 'engagement.redemption.rejected', { ...base, reason }));
      if (change.to === 'NEEDS_REVIEW')
        events.push(
          this.event(tenantId, 'engagement.redemption.needs_review', { ...base, reason }),
        );
      for (const m of change.outbox ?? [])
        events.push(this.event(tenantId, m.type, { ...m.payload, ...base }, m.causationId));

      if (change.dedupe) {
        const fresh: unknown[] = await tx.query(
          `INSERT INTO "redemption_inbox" ("tenant_id", "consumer", "event_id") VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING "event_id"`,
          [tenantId, change.dedupe.consumer, change.dedupe.eventId],
        );
        if (fresh.length === 0) return { applied: false, redemption: rec };
      }

      await tx.query(
        `UPDATE "redemptions" SET "state" = $2, "attempts" = $3, "next_attempt_at" = $4,
           "unknown_since" = $5, "casino_reference" = $6, "failure_reason" = $7,
           "reservation" = $8, "updated_at" = $9
         WHERE "id" = $1`,
        [
          rec.id,
          next.state,
          next.attempts,
          next.nextAttemptAt,
          next.unknownSince,
          next.casinoReference,
          next.failureReason,
          next.reservation,
          at,
        ],
      );
      await tx.query(
        `INSERT INTO "redemption_history" ("tenant_id", "redemption_id", "from_state", "to_state", "cause", "at")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, rec.id, from, change.to, change.cause, at],
      );
      // Same lock order as placeOrder (the player's counter, then the stock): no deadlock between them.
      if (restoreStock) {
        await tx.query(
          `UPDATE "item_player_usage" SET "used" = GREATEST(0, "used" - 1)
           WHERE "tenant_id" = $1 AND "item_id" = $2 AND "player_id" = $3`,
          [tenantId, rec.itemId, rec.playerId],
        );
        await tx.query(
          `UPDATE "store_items" SET "stock" = "stock" + 1 WHERE "id" = $1 AND "stock" IS NOT NULL`,
          [rec.itemId],
        );
      }
      await this.syncQueue(tx, next);
      for (const e of events) await this.db.publish(tx, e);

      next.history = [...rec.history, { from, to: change.to, cause: change.cause, at }];
      return { applied: true, redemption: next };
    });
  }

  async reschedule(
    tenantId: string,
    redemptionId: string,
    expectState: RedemptionState,
    nextAttemptAt: Date,
  ): Promise<void> {
    if (!UUID_RE.test(redemptionId)) return;
    await this.inTenant(tenantId, async (tx) => {
      const moved = await affected(
        tx,
        `UPDATE "redemptions" SET "next_attempt_at" = $3 WHERE "id" = $1 AND "state" = $2`,
        [redemptionId, expectState, nextAttemptAt],
      );
      if (moved > 0)
        await tx.query(
          `UPDATE "redemption_work_queue" SET "next_attempt_at" = $2 WHERE "redemption_id" = $1`,
          [redemptionId, nextAttemptAt],
        );
    });
  }

  getOwn(scope: Scope, redemptionId: string): Promise<RedemptionRecord | null> {
    if (!UUID_RE.test(redemptionId)) return Promise.resolve(null);
    return this.inTenant(scope.tenantId, async (tx) => {
      const rows: RedemptionRow[] = await tx.query(
        `SELECT ${COLUMNS} FROM "redemptions"
         WHERE "id" = $1 AND "tenant_id" = $2 AND "player_id" = $3 AND "sandbox" = $4`,
        [redemptionId, scope.tenantId, scope.playerId, scope.sandbox],
      );
      return (await this.hydrate(tx, rows))[0] ?? null;
    });
  }

  getForOperator(tenantId: string, redemptionId: string): Promise<RedemptionRecord | null> {
    return this.inTenant(tenantId, (tx) => this.loadOne(tx, redemptionId));
  }

  listForOperator(tenantId: string, state?: RedemptionState): Promise<RedemptionRecord[]> {
    return this.inTenant(tenantId, async (tx) => {
      const rows: RedemptionRow[] = await tx.query(
        `SELECT ${COLUMNS} FROM "redemptions"
         WHERE "tenant_id" = $1 AND ($2::text IS NULL OR "state" = $2)
         ORDER BY "created_at" DESC, "id" DESC LIMIT 500`,
        [tenantId, state ?? null],
      );
      return this.hydrate(tx, rows);
    });
  }

  /** Cross-tenant, over the RLS-free work queue (ids and times only). Never bypasses RLS. */
  async dueForSweep(now: Date): Promise<{ tenantId: string; id: string }[]> {
    const rows: { tenant_id: string; redemption_id: string }[] = await this.db.platformTx((tx) =>
      tx.query(
        `SELECT "tenant_id", "redemption_id" FROM "redemption_work_queue"
         WHERE "next_attempt_at" IS NULL OR "next_attempt_at" <= $1
         ORDER BY "next_attempt_at" NULLS FIRST LIMIT ${SWEEP_BATCH}`,
        [now],
      ),
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, id: r.redemption_id }));
  }
}
