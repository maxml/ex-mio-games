import type { EventEnvelope, RedemptionState } from '@ex-mio/contracts';
import {
  StoreRejection,
  type RedemptionRecord,
  type RedemptionStore,
  type Scope,
  type StateChange,
} from '../ports';
import type { TestClock } from './clock';

/** What the suite needs besides the store: a way to seed items and to look at counters and the outbox. */
export interface StoreHarness {
  store: RedemptionStore;
  /** The clock the store was built with; the suite moves it. */
  clock: TestClock;
  tenantId: string;
  otherTenantId: string;
  addItem(o: {
    price: number;
    stock?: number | null;
    perPlayerLimit?: number | null;
  }): Promise<string>;
  editItem(id: string, patch: { price?: number; rewardType?: string }): Promise<void>;
  deactivate(id: string): Promise<void>;
  stockOf(itemId: string): Promise<number | null>;
  /** Every outbox envelope written for the tenant so far. */
  outbox(tenantId: string): Promise<EventEnvelope[]>;
}

/**
 * X-13: redemption events carry `player_id: Uuid`, so a symbolic test name ('p1') maps to a fixed uuid.
 * The mapping is a function of the name, so the same name is the same player everywhere in a test.
 */
const pid = (name: string): string =>
  `0190a1b2-c3d4-7e5f-8a6b-${Buffer.from(name).toString('hex').padStart(12, '0').slice(-12)}`;

/** INV-ENV-INPUT: the environment is always stated. `player` is the PRODUCTION scope; `playerIn` takes it as a required argument. */
const playerIn = (h: StoreHarness, id: string, sandbox: boolean): Scope => ({
  tenantId: h.tenantId,
  playerId: pid(id),
  sandbox,
});
const player = (h: StoreHarness, id: string): Scope => playerIn(h, id, false);

const all = (...s: RedemptionState[]): RedemptionState[] => s;

type Step = RedemptionState | [RedemptionState, Partial<StateChange>];

/** Defaults that make a walk behave like the saga: the reservation is settled where the table says. */
const defaultsFor = (to: RedemptionState): Partial<StateChange> =>
  to === 'RELEASED' || to === 'REJECTED_FUNDS'
    ? { reservation: 'release' }
    : to === 'COMPLETED'
      ? { reservation: 'commit' }
      : {};

/** Applies a chain of transitions, each from the state the previous one reached. */
async function walk(
  h: StoreHarness,
  id: string,
  from: RedemptionState,
  steps: Step[],
): Promise<RedemptionRecord> {
  let at = from;
  let last: RedemptionRecord | undefined;
  for (const s of steps) {
    const [to, extra] = Array.isArray(s) ? s : [s, {}];
    const res = await h.store.apply(h.tenantId, id, {
      expectFrom: [at],
      to,
      cause: `${at}>${to}`,
      ...defaultsFor(to),
      ...extra,
    });
    expect(res.applied).toBe(true);
    last = res.redemption;
    at = to;
  }
  if (!last) throw new Error('empty walk');
  return last;
}

/** A fresh order for a fresh player; returns its id. */
let seq = 0;
const order = (
  h: StoreHarness,
  o: { stock?: number | null; limit?: number | null; price?: number } = {},
): Promise<{ id: string; itemId: string; scope: Scope }> => orderIn(h, false, o);

async function orderIn(
  h: StoreHarness,
  sandbox: boolean,
  o: { stock?: number | null; limit?: number | null; price?: number } = {},
): Promise<{ id: string; itemId: string; scope: Scope }> {
  seq += 1;
  const itemId = await h.addItem({
    price: o.price ?? 10,
    stock: o.stock === undefined ? null : o.stock,
    perPlayerLimit: o.limit ?? null,
  });
  const scope = playerIn(h, `p${seq}`, sandbox);
  const { redemption } = await h.store.placeOrder(scope, { operationKey: `k${seq}`, itemId });
  return { id: redemption.id, itemId, scope };
}

const events = async (h: StoreHarness, id: string, type?: string): Promise<EventEnvelope[]> =>
  (await h.outbox(h.tenantId)).filter(
    (e) =>
      (e.payload as { redemption_id?: string }).redemption_id === id && (!type || e.type === type),
  );

/** The ids the sweeper would see for this tenant (the work queue is cross-tenant). */
const due = async (h: StoreHarness, now: Date): Promise<string[]> =>
  (await h.store.dueForSweep(now)).filter((x) => x.tenantId === h.tenantId).map((x) => x.id);

const refusesAs = (name: string) => expect.objectContaining({ name });

/**
 * The RedemptionStore contract (docs/specs/engagement-store.md §4.1). Runs
 * against the in-memory store (to keep the fake honest) and against the
 * Postgres store (`redemption-store.pg.itest.ts`, `pnpm --filter @ex-mio/engagement test:pg`).
 * The same function runs in both: a behaviour the saga relies on is pinned here or nowhere.
 *
 * Mutations (each makes the named test red):
 *  - stock check not conditional / not atomic -> 'never goes below zero under 50 parallel reservations'
 *  - per-player limit check removed             -> 'per-player limit holds under parallel orders'
 *  - dedupe lookup removed                      -> 'same operation key returns the existing order'
 *  - price/mapping read live instead of frozen  -> 'price and reward mapping are frozen on the order'
 *  - illegal-pair check removed from apply      -> 'apply rejects a pair outside the table'
 *  - inbox row not written / not checked        -> 'a repeated event id applies nothing' (a LEGAL pair is
 *    repeated, so only the inbox can stop it) and 'a failed change leaves no inbox row'
 *  - state written before the outbox is built   -> 'a change that fails midway leaves nothing behind'
 *  - release not guarded by the reservation     -> 'stock is returned exactly once through release,
 *    review and not_issued' and 'releasing the reservation twice restores stock once'
 *  - replay guard removed from apply            -> 'replay is refused unless the review was entered
 *    from UNKNOWN' (4 origins) and 'the origin is the latest entry into NEEDS_REVIEW'
 *  - getOwn ignores player or sandbox           -> 'lookup is (tenant, player, sandbox, id)'
 *  - expectFrom not checked atomically          -> '10 concurrent applies of one change: exactly one wins'
 *  - dueForSweep includes REQUESTED at once, a final state, or ignores nextAttemptAt, or
 *    treats null as not due                     -> 'dueForSweep'
 *  - reschedule ignores expectState or writes history -> 'reschedule'
 *  - attempts increment/reset ignored           -> 'attempts increment and reset'
 *  - unknown_since reset on every UNKNOWN entry, or never reset -> 'unknownSince is set once ...'
 *  - the issued/rejected/needs_review event not written or wrong reason -> 'the issued, rejected and
 *    needs_review events carry the casino reference and the reason'
 *  - caller outbox message not stamped          -> 'caller outbox messages are stamped'
 *  - history rewritten or reordered             -> 'history is append-only and in order'
 *  - a commit after a release restores or flips the reservation -> 'a committed reservation is never released'
 */
export function storeConformance(label: string, setup: () => Promise<StoreHarness>): void {
  describe(`RedemptionStore contract: ${label}`, () => {
    let h: StoreHarness;
    beforeEach(async () => {
      h = await setup();
    });

    // ---- placeOrder -----------------------------------------------------------------------------

    it('same operation key returns the existing order, once', async () => {
      const item = await h.addItem({ price: 10, stock: 5 });
      const a = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: item });
      const b = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: item });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.redemption.id).toBe(a.redemption.id);
      expect(await h.stockOf(item)).toBe(4);
      expect(await events(h, a.redemption.id)).toHaveLength(1);
    });

    it('placeOrder writes one status_changed(null -> REQUESTED) and schedules the sweep grace', async () => {
      const { id } = await order(h);
      const ev = await events(h, id);
      expect(ev.map((e) => e.type)).toEqual(['engagement.redemption.status_changed']);
      expect(ev[0]?.payload).toMatchObject({ from: null, to: 'REQUESTED' });
      expect('sandbox' in (ev[0]?.payload as object)).toBe(false); // X-13: the envelope holds it
      expect(ev[0]?.sandbox).toBe(false); // INV-ENV-INPUT: production is stated, never absent
      const rec = await h.store.getForOperator(h.tenantId, id);
      // The coin reserve is a synchronous call (D-1): no hold command is written. If that call never
      // finished, the sweeper re-sends it 30 s later with the same key.
      expect(rec?.nextAttemptAt?.getTime()).toBe(rec!.createdAt.getTime() + 30_000);
      expect((await h.outbox(h.tenantId)).some((e) => e.type.includes('.hold.'))).toBe(false);
      expect(
        (await h.outbox(h.tenantId)).some((e) => e.type === 'engagement.redemption.requested'),
      ).toBe(false);
    });

    it('the same key with a different item is idempotency_key_reused and changes nothing', async () => {
      const i1 = await h.addItem({ price: 10, stock: 5 });
      const i2 = await h.addItem({ price: 10, stock: 5 });
      await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: i1 });
      await expect(
        h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: i2 }),
      ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
      expect(await h.stockOf(i2)).toBe(5);
    });

    it('the same key from another player is a separate order', async () => {
      const item = await h.addItem({ price: 10, stock: 5 });
      const a = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: item });
      const b = await h.store.placeOrder(player(h, 'p2'), { operationKey: 'k1', itemId: item });
      expect(b.created).toBe(true);
      expect(b.redemption.id).not.toBe(a.redemption.id);
    });

    it('stock never goes below zero under 50 parallel reservations', async () => {
      const item = await h.addItem({ price: 10, stock: 7 });
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          h.store.placeOrder(player(h, `p${i}`), { operationKey: `k${i}`, itemId: item }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(7);
      expect(failed).toHaveLength(43);
      for (const f of failed) {
        expect(f.reason).toBeInstanceOf(StoreRejection);
        expect(f.reason.code).toBe('out_of_stock');
      }
      expect(await h.stockOf(item)).toBe(0);
    });

    it('the last item goes to exactly one of two players', async () => {
      const item = await h.addItem({ price: 10, stock: 1 });
      const r = await Promise.allSettled([
        h.store.placeOrder(player(h, 'a'), { operationKey: 'ka', itemId: item }),
        h.store.placeOrder(player(h, 'b'), { operationKey: 'kb', itemId: item }),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await h.stockOf(item)).toBe(0);
    });

    it('per-player limit holds under parallel orders', async () => {
      const item = await h.addItem({ price: 10, stock: null, perPlayerLimit: 2 });
      const r = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          h.store.placeOrder(player(h, 'p1'), { operationKey: `k${i}`, itemId: item }),
        ),
      );
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
      const rej = r.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
      expect(rej.every((x) => x.reason.code === 'limit_reached')).toBe(true);
    });

    it('an inactive item cannot be redeemed, and an existing redemption of it keeps its status', async () => {
      const item = await h.addItem({ price: 10, stock: 3 });
      const first = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k0', itemId: item });
      await h.deactivate(item);
      await expect(
        h.store.placeOrder(player(h, 'p2'), { operationKey: 'k', itemId: item }),
      ).rejects.toMatchObject({ code: 'item_inactive' });
      const kept = await h.store.getOwn(player(h, 'p1'), first.redemption.id);
      expect(kept).toMatchObject({ state: 'REQUESTED', price: 10 });
    });

    it('price and reward mapping are frozen on the order', async () => {
      const item = await h.addItem({ price: 10, stock: 3 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      await h.editItem(item, { price: 99, rewardType: 'cash_bonus' });
      const again = await h.store.getOwn(player(h, 'p1'), redemption.id);
      expect(again?.price).toBe(10);
      expect(again?.reward.type).toBe('free_spins');
    });

    // ---- apply: the choke point -----------------------------------------------------------------

    it('state change and outbox message commit together', async () => {
      const item = await h.addItem({ price: 10, stock: 3 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      const before = (await h.outbox(h.tenantId)).length;
      const res = await h.store.apply(h.tenantId, redemption.id, {
        expectFrom: all('REQUESTED'),
        to: 'RESERVED',
        cause: 'reserved',
        nextAttemptAt: new Date(0),
      });
      expect(res.applied).toBe(true);
      const after = await h.outbox(h.tenantId);
      const changed = after
        .slice(before)
        .filter((e) => e.type === 'engagement.redemption.status_changed');
      expect(changed).toHaveLength(1);
      expect('sandbox' in (changed[0]?.payload as object)).toBe(false);
      expect(changed[0]?.sandbox).toBe(false);
    });

    it('apply rejects a pair outside the table', async () => {
      const { id } = await order(h);
      await expect(
        h.store.apply(h.tenantId, id, {
          expectFrom: all('REQUESTED'),
          to: 'ISSUED',
          cause: 'skip',
        }),
      ).rejects.toEqual(refusesAs('IllegalTransitionError'));
    });

    // P1 of the review: an illegal pair throws BEFORE any write, so it cannot see a store that
    // mutates and then throws. This one fails AFTER the state, history, reservation and inbox work.
    it('a change that fails midway leaves nothing behind (state, history, stock, inbox, outbox)', async () => {
      const { id, itemId, scope } = await order(h, { stock: 2 });
      const eventsBefore = (await h.outbox(h.tenantId)).length;
      const bad: StateChange = {
        expectFrom: all('REQUESTED'),
        to: 'REJECTED_FUNDS',
        cause: 'insufficient_funds',
        reservation: 'release',
        dedupe: { consumer: 'saga', eventId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a77' },
        // an invalid payload: `casino_reference` must be a string
        outbox: [{ type: 'engagement.redemption.issued', payload: { casino_reference: 5 } }],
      };
      await expect(h.store.apply(h.tenantId, id, bad)).rejects.toBeDefined();
      const rec = await h.store.getOwn(scope, id);
      expect(rec?.state).toBe('REQUESTED');
      expect(rec?.reservation).toBe('reserved');
      expect(rec?.history).toHaveLength(1);
      expect(await h.stockOf(itemId)).toBe(1);
      expect((await h.outbox(h.tenantId)).length).toBe(eventsBefore);
      // and the inbox row was not consumed: the same event id now applies with a valid change
      const good = { ...bad, outbox: undefined };
      expect((await h.store.apply(h.tenantId, id, good)).applied).toBe(true);
    });

    it('a change whose expected state is stale applies nothing', async () => {
      const { id } = await order(h);
      const res = await h.store.apply(h.tenantId, id, {
        expectFrom: all('RESERVED'),
        to: 'ISSUING',
        cause: 'x',
      });
      expect(res.applied).toBe(false);
      expect(res.redemption.state).toBe('REQUESTED');
      expect(res.redemption.history).toHaveLength(1);
    });

    // F5 / S5: the old test repeated RESERVED -> RESERVED, an illegal pair, so it went red without
    // the inbox. Here a LEGAL pair is repeated from a state that allows it: only the inbox row
    // stops the second application (ISSUED -> NEEDS_REVIEW -> ISSUED -> NEEDS_REVIEW).
    it('a repeated event id applies nothing, even when its transition is legal again', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['RESERVED', 'ISSUING', 'ISSUED']);
      const review: StateChange = {
        expectFrom: all('ISSUED', 'COMPLETED'),
        to: 'NEEDS_REVIEW',
        cause: 'late_rejection',
        dedupe: { consumer: 'saga', eventId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' },
      };
      expect((await h.store.apply(h.tenantId, id, review)).applied).toBe(true);
      await walk(h, id, 'NEEDS_REVIEW', ['ISSUED']); // the operator resolved it
      const n = (await h.outbox(h.tenantId)).length;
      const again = await h.store.apply(h.tenantId, id, review);
      expect(again.applied).toBe(false);
      expect(again.redemption.state).toBe('ISSUED');
      expect((await h.outbox(h.tenantId)).length).toBe(n);
      // the same event id from another consumer is another inbox row
      const other = await h.store.apply(h.tenantId, id, {
        ...review,
        dedupe: { consumer: 'another', eventId: review.dedupe!.eventId },
      });
      expect(other.applied).toBe(true);
    });

    it('10 concurrent applies of one change: exactly one wins', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['RESERVED']);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          h.store.apply(h.tenantId, id, {
            expectFrom: all('RESERVED'),
            to: 'ISSUING',
            cause: 'sweeper',
            attemptsIncrement: true,
          }),
        ),
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      const rec = await h.store.getForOperator(h.tenantId, id);
      expect(rec?.attempts).toBe(1);
      expect(rec?.history.filter((x) => x.to === 'ISSUING')).toHaveLength(1);
      const toIssuing = (await events(h, id, 'engagement.redemption.status_changed')).filter(
        (e) => (e.payload as { to: string }).to === 'ISSUING',
      );
      expect(toIssuing).toHaveLength(1);
    });

    // ---- the reservation: stock returned exactly once (F3, D-8) -----------------------------------

    it('releasing the reservation twice restores stock once', async () => {
      const item = await h.addItem({ price: 10, stock: 2 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      expect(await h.stockOf(item)).toBe(1);
      const rel = {
        expectFrom: all('REQUESTED'),
        to: 'REJECTED_FUNDS' as const,
        cause: 'insufficient_funds',
        reservation: 'release' as const,
      };
      await h.store.apply(h.tenantId, redemption.id, rel);
      await h.store.apply(h.tenantId, redemption.id, rel);
      expect(await h.stockOf(item)).toBe(2);
    });

    // P2 of the review: RELEASED -> review -> operator not_issued -> REJECTED -> RELEASED carries a
    // second `release`. Nothing may check the caller: the choke point is the reservation itself.
    it('stock is returned exactly once through release, review and not_issued', async () => {
      const { id, itemId, scope } = await order(h, { stock: 2, limit: 1 });
      expect(await h.stockOf(itemId)).toBe(1);
      await walk(h, id, 'REQUESTED', ['RESERVED', 'ISSUING', 'REJECTED', 'RELEASED']);
      expect(await h.stockOf(itemId)).toBe(2);
      await walk(h, id, 'RELEASED', ['NEEDS_REVIEW', 'REJECTED', 'RELEASED']); // release again
      expect(await h.stockOf(itemId)).toBe(2);
      expect((await h.store.getOwn(scope, id))?.reservation).toBe('released');
      // the per-player counter went back once too: one more order, then the limit holds
      await h.store.placeOrder(scope, { operationKey: 'again', itemId });
      await expect(
        h.store.placeOrder(scope, { operationKey: 'and-again', itemId }),
      ).rejects.toMatchObject({ code: 'limit_reached' });
    });

    it('a committed reservation is never released, and a released one is never committed', async () => {
      const done = await order(h, { stock: 2 });
      await walk(h, done.id, 'REQUESTED', ['RESERVED', 'ISSUING', 'ISSUED', 'COMPLETED']);
      expect((await h.store.getOwn(done.scope, done.id))?.reservation).toBe('committed');
      await walk(h, done.id, 'COMPLETED', [['REFUNDED', { reservation: 'release' }]]);
      expect(await h.stockOf(done.itemId)).toBe(1);
      expect((await h.store.getOwn(done.scope, done.id))?.reservation).toBe('committed');

      const gone = await order(h, { stock: 2 });
      await walk(h, gone.id, 'REQUESTED', ['RESERVED', 'ISSUING', 'REJECTED', 'RELEASED']);
      await walk(h, gone.id, 'RELEASED', ['NEEDS_REVIEW', ['ISSUED', { reservation: 'commit' }]]);
      expect((await h.store.getOwn(gone.scope, gone.id))?.reservation).toBe('released');
      expect(await h.stockOf(gone.itemId)).toBe(2);
    });

    // ---- replay is allowed only for a review entered from UNKNOWN (F6, D-8) -----------------------

    it.each([
      ['REJECTED (late success)', ['RESERVED', 'ISSUING', 'REJECTED']],
      ['RELEASED (coins already returned)', ['RESERVED', 'ISSUING', 'REJECTED', 'RELEASED']],
      ['ISSUED (capture refused)', ['RESERVED', 'ISSUING', 'ISSUED']],
      ['COMPLETED (late rejection)', ['RESERVED', 'ISSUING', 'ISSUED', 'COMPLETED']],
    ] as [string, RedemptionState[]][])(
      'replay is refused unless the review was entered from UNKNOWN: review entered from %s',
      async (_label, path) => {
        const { id } = await order(h);
        await walk(h, id, 'REQUESTED', path);
        await walk(h, id, path[path.length - 1]!, ['NEEDS_REVIEW']);
        const before = await h.store.getForOperator(h.tenantId, id);
        await expect(
          h.store.apply(h.tenantId, id, {
            expectFrom: all('NEEDS_REVIEW'),
            to: 'UNKNOWN',
            cause: 'replay',
            attemptsReset: true,
          }),
        ).rejects.toEqual(refusesAs('IllegalTransitionError'));
        const after = await h.store.getForOperator(h.tenantId, id);
        expect(after?.state).toBe('NEEDS_REVIEW');
        expect(after?.history).toHaveLength(before!.history.length);
      },
    );

    it('replay is refused for a review entered from REQUESTED (the reserve answer did not match)', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['NEEDS_REVIEW']);
      await expect(
        h.store.apply(h.tenantId, id, {
          expectFrom: all('NEEDS_REVIEW'),
          to: 'UNKNOWN',
          cause: 'replay',
        }),
      ).rejects.toEqual(refusesAs('IllegalTransitionError'));
    });

    it('replay is allowed for a review entered from UNKNOWN, with a fresh attempt budget', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', [
        'RESERVED',
        ['ISSUING', { attemptsIncrement: true }],
        'UNKNOWN',
        ['NEEDS_REVIEW', { failureReason: 'attempts_exhausted' }],
      ]);
      const res = await h.store.apply(h.tenantId, id, {
        expectFrom: all('NEEDS_REVIEW'),
        to: 'UNKNOWN',
        cause: 'replay',
        attemptsReset: true,
      });
      expect(res.applied).toBe(true);
      expect(res.redemption).toMatchObject({ state: 'UNKNOWN', attempts: 0 });
    });

    it('the origin is the LATEST entry into NEEDS_REVIEW: UNKNOWN once, COMPLETED later -> refused', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['RESERVED', 'ISSUING', 'UNKNOWN', 'NEEDS_REVIEW']);
      await walk(h, id, 'NEEDS_REVIEW', ['ISSUED', 'COMPLETED', 'NEEDS_REVIEW']);
      await expect(
        h.store.apply(h.tenantId, id, {
          expectFrom: all('NEEDS_REVIEW'),
          to: 'UNKNOWN',
          cause: 'replay',
        }),
      ).rejects.toEqual(refusesAs('IllegalTransitionError'));
    });

    // ---- the work queue the sweeper reads (F7) -----------------------------------------------------

    it('dueForSweep: which states, which times, null counts as due', async () => {
      const t0 = h.clock.now();
      const at = (ms: number) => new Date(t0.getTime() + ms);

      const requested = await order(h);
      expect(await due(h, t0)).not.toContain(requested.id); // grace: the inline reserve is running
      expect(await due(h, at(29_000))).not.toContain(requested.id);
      expect(await due(h, at(30_000))).toContain(requested.id);

      const reserved = await order(h);
      await walk(h, reserved.id, 'REQUESTED', [['RESERVED', { nextAttemptAt: t0 }]]);
      expect(await due(h, t0)).toContain(reserved.id);

      // an ISSUING row holds a 60 s lease: not due until it expires
      const issuing = await order(h);
      await walk(h, issuing.id, 'REQUESTED', [
        'RESERVED',
        ['ISSUING', { nextAttemptAt: at(60_000), attemptsIncrement: true }],
      ]);
      expect(await due(h, at(59_000))).not.toContain(issuing.id);
      expect(await due(h, at(60_000))).toContain(issuing.id);

      const unknown = await order(h);
      await walk(h, unknown.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        ['UNKNOWN', { nextAttemptAt: at(5_000) }],
      ]);
      expect(await due(h, at(4_000))).not.toContain(unknown.id);
      expect(await due(h, at(5_000))).toContain(unknown.id);

      // states that wait for a payments call are due; null means "now"
      const issued = await order(h);
      await walk(h, issued.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        ['ISSUED', { nextAttemptAt: null }],
      ]);
      const rejected = await order(h);
      await walk(h, rejected.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        ['REJECTED', { nextAttemptAt: null }],
      ]);
      const nullRow = await due(h, t0);
      expect(nullRow).toContain(issued.id);
      expect(nullRow).toContain(rejected.id);

      // never due, even with a null or past time
      const funds = await order(h);
      await walk(h, funds.id, 'REQUESTED', [['REJECTED_FUNDS', { nextAttemptAt: null }]]);
      const completed = await order(h);
      await walk(h, completed.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        'ISSUED',
        ['COMPLETED', { nextAttemptAt: null }],
      ]);
      const released = await order(h);
      await walk(h, released.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        'REJECTED',
        ['RELEASED', { nextAttemptAt: null }],
      ]);
      const refunded = await order(h);
      await walk(h, refunded.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        'ISSUED',
        'COMPLETED',
        ['REFUNDED', { nextAttemptAt: null }],
      ]);
      const review = await order(h);
      await walk(h, review.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        'UNKNOWN',
        ['NEEDS_REVIEW', { nextAttemptAt: null }],
      ]);
      const later = await due(h, at(10 * 24 * 3_600_000));
      for (const done of [funds, completed, released, refunded, review])
        expect(later).not.toContain(done.id);
    });

    it('reschedule moves the sweep time only while the state matches, and writes nothing else', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['RESERVED', 'ISSUING', 'UNKNOWN']);
      const eventsBefore = (await h.outbox(h.tenantId)).length;
      const historyBefore = (await h.store.getForOperator(h.tenantId, id))!.history.length;
      const t1 = new Date(h.clock.now().getTime() + 40_000);
      const t2 = new Date(h.clock.now().getTime() + 90_000);
      await h.store.reschedule(h.tenantId, id, 'UNKNOWN', t1);
      expect((await h.store.getForOperator(h.tenantId, id))?.nextAttemptAt?.getTime()).toBe(
        t1.getTime(),
      );
      await h.store.reschedule(h.tenantId, id, 'ISSUING', t2); // stale expectation
      expect((await h.store.getForOperator(h.tenantId, id))?.nextAttemptAt?.getTime()).toBe(
        t1.getTime(),
      );
      expect((await h.outbox(h.tenantId)).length).toBe(eventsBefore);
      expect((await h.store.getForOperator(h.tenantId, id))!.history).toHaveLength(historyBefore);
      expect(await due(h, new Date(t1.getTime() - 1))).not.toContain(id);
      expect(await due(h, t1)).toContain(id);
    });

    it('attempts increment and reset only when asked', async () => {
      const { id } = await order(h);
      const r1 = await walk(h, id, 'REQUESTED', ['RESERVED']);
      expect(r1.attempts).toBe(0);
      const r2 = await walk(h, id, 'RESERVED', [['ISSUING', { attemptsIncrement: true }]]);
      expect(r2.attempts).toBe(1);
      const r3 = await walk(h, id, 'ISSUING', ['UNKNOWN']);
      expect(r3.attempts).toBe(1);
      const r4 = await walk(h, id, 'UNKNOWN', [['ISSUING', { attemptsIncrement: true }]]);
      expect(r4.attempts).toBe(2);
      await walk(h, id, 'ISSUING', ['UNKNOWN', 'NEEDS_REVIEW']);
      const r5 = await walk(h, id, 'NEEDS_REVIEW', [['UNKNOWN', { attemptsReset: true }]]);
      expect(r5.attempts).toBe(0);
    });

    it('unknownSince is set once per streak, survives UNKNOWN -> ISSUING -> UNKNOWN, and resets on a decision', async () => {
      const { id } = await order(h);
      await walk(h, id, 'REQUESTED', ['RESERVED', 'ISSUING']);
      h.clock.advance(1_000);
      const t1 = h.clock.now();
      const u1 = await walk(h, id, 'ISSUING', ['UNKNOWN']);
      expect(u1.unknownSince?.getTime()).toBe(t1.getTime());
      h.clock.advance(5_000);
      await walk(h, id, 'UNKNOWN', ['ISSUING']);
      h.clock.advance(5_000);
      const u2 = await walk(h, id, 'ISSUING', ['UNKNOWN']);
      expect(u2.unknownSince?.getTime()).toBe(t1.getTime()); // the 24 h age counts from the first one
      h.clock.advance(5_000);
      const issued = await walk(h, id, 'UNKNOWN', ['ISSUED']);
      expect(issued.unknownSince).toBeNull();

      // a replay starts a fresh streak at its own time
      const second = await order(h);
      await walk(h, second.id, 'REQUESTED', ['RESERVED', 'ISSUING', 'UNKNOWN', 'NEEDS_REVIEW']);
      expect((await h.store.getForOperator(h.tenantId, second.id))?.unknownSince).toBeNull();
      h.clock.advance(7_000);
      const replayAt = h.clock.now();
      const replayed = await walk(h, second.id, 'NEEDS_REVIEW', ['UNKNOWN']);
      expect(replayed.unknownSince?.getTime()).toBe(replayAt.getTime());
    });

    // ---- events, history, outbox stamping ------------------------------------------------------------

    it('the issued, rejected and needs_review events carry the casino reference and the reason', async () => {
      const ok = await order(h, { price: 12 });
      await walk(h, ok.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        ['ISSUED', { casinoReference: 'ref-9' }],
      ]);
      const issued = await events(h, ok.id, 'engagement.redemption.issued');
      expect(issued.map((e) => e.payload)).toEqual([
        expect.objectContaining({ casino_reference: 'ref-9', price: 12 }),
      ]);

      const no = await order(h);
      await walk(h, no.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        ['REJECTED', { failureReason: 'casino_rejected:player_not_eligible' }],
      ]);
      expect(
        (await events(h, no.id, 'engagement.redemption.rejected')).map((e) => e.payload),
      ).toEqual([expect.objectContaining({ reason: 'casino_rejected:player_not_eligible' })]);

      const funds = await order(h);
      await walk(h, funds.id, 'REQUESTED', [
        ['REJECTED_FUNDS', { failureReason: 'insufficient_funds' }],
      ]);
      expect(
        (await events(h, funds.id, 'engagement.redemption.rejected')).map((e) => e.payload),
      ).toEqual([expect.objectContaining({ reason: 'insufficient_funds' })]);

      const rev = await order(h);
      await walk(h, rev.id, 'REQUESTED', [
        'RESERVED',
        'ISSUING',
        'UNKNOWN',
        ['NEEDS_REVIEW', { failureReason: 'attempts_exhausted' }],
      ]);
      expect(
        (await events(h, rev.id, 'engagement.redemption.needs_review')).map((e) => e.payload),
      ).toEqual([expect.objectContaining({ reason: 'attempts_exhausted' })]);

      // every change also wrote exactly one status_changed, in order
      const changes = (await events(h, rev.id, 'engagement.redemption.status_changed')).map(
        (e) => (e.payload as { to: string }).to,
      );
      expect(changes).toEqual(['REQUESTED', 'RESERVED', 'ISSUING', 'UNKNOWN', 'NEEDS_REVIEW']);
    });

    it('caller outbox messages are stamped with the redemption and the player; the sandbox flag goes on the envelope', async () => {
      const { id, scope } = await orderIn(h, true);
      await h.store.apply(h.tenantId, id, {
        expectFrom: all('REQUESTED'),
        to: 'RESERVED',
        cause: 'reserved',
        outbox: [
          {
            type: 'engagement.redemption.needs_review',
            // a caller cannot override the stamp
            payload: { reason: 'x', redemption_id: 'forged', player_id: 'forged' },
          },
        ],
      });
      const stamped = await events(h, id, 'engagement.redemption.needs_review');
      expect(stamped).toHaveLength(1);
      expect(stamped[0]?.payload).toMatchObject({
        redemption_id: id,
        player_id: scope.playerId,
        reason: 'x',
      });
      expect(stamped[0]?.sandbox).toBe(true); // set from the order's server-side flag
      expect('sandbox' in (stamped[0]?.payload as object)).toBe(false);
    });

    it('history is append-only and in order', async () => {
      const { id } = await order(h);
      const snapshots: string[][] = [];
      const hist = async () =>
        (await h.store.getForOperator(h.tenantId, id))!.history.map(
          (e) => `${e.from}>${e.to}:${e.cause}`,
        );
      snapshots.push(await hist());
      for (const to of ['RESERVED', 'ISSUING', 'ISSUED', 'COMPLETED'] as RedemptionState[]) {
        const rec = (await h.store.getForOperator(h.tenantId, id))!;
        await h.store.apply(h.tenantId, id, {
          expectFrom: all(rec.state),
          to,
          cause: `to ${to}`,
          ...defaultsFor(to),
        });
        // a stale change in between adds nothing
        await h.store.apply(h.tenantId, id, {
          expectFrom: all('REQUESTED'),
          to: 'RESERVED',
          cause: 'stale',
        });
        snapshots.push(await hist());
      }
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i]).toHaveLength(snapshots[i - 1]!.length + 1);
        expect(snapshots[i]!.slice(0, snapshots[i - 1]!.length)).toEqual(snapshots[i - 1]);
      }
      const rec = (await h.store.getForOperator(h.tenantId, id))!;
      rec.history.forEach((e, i) => {
        if (i > 0) expect(e.from).toBe(rec.history[i - 1]!.to);
      });
    });

    // ---- reading ---------------------------------------------------------------------------------------

    it('lookup is (tenant, player, sandbox, id)', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      expect(await h.store.getOwn(player(h, 'p1'), redemption.id)).not.toBeNull();
      expect(await h.store.getForOperator(h.tenantId, redemption.id)).not.toBeNull();
      expect(await h.store.getOwn(player(h, 'p2'), redemption.id)).toBeNull();
      expect(await h.store.getOwn(playerIn(h, 'p1', true), redemption.id)).toBeNull();
      expect(
        await h.store.getOwn(
          { tenantId: h.otherTenantId, playerId: pid('p1'), sandbox: false },
          redemption.id,
        ),
      ).toBeNull();
      expect(await h.store.getForOperator(h.otherTenantId, redemption.id)).toBeNull();
      expect(await h.store.listForOperator(h.otherTenantId)).toHaveLength(0);
    });

    it('listForOperator(state) returns only that state, for that tenant', async () => {
      const a = await order(h);
      const b = await order(h);
      const c = await order(h);
      await walk(h, b.id, 'REQUESTED', ['RESERVED']);
      await walk(h, c.id, 'REQUESTED', ['RESERVED', 'ISSUING', 'UNKNOWN', 'NEEDS_REVIEW']);
      const ids = (rows: RedemptionRecord[]) => rows.map((r) => r.id).sort();
      expect(ids(await h.store.listForOperator(h.tenantId, 'NEEDS_REVIEW'))).toEqual([c.id]);
      expect(ids(await h.store.listForOperator(h.tenantId, 'RESERVED'))).toEqual([b.id]);
      expect(ids(await h.store.listForOperator(h.tenantId, 'REQUESTED'))).toEqual([a.id]);
      expect(ids(await h.store.listForOperator(h.tenantId))).toEqual([a.id, b.id, c.id].sort());
      expect(await h.store.listForOperator(h.otherTenantId, 'NEEDS_REVIEW')).toHaveLength(0);
    });

    // X-13/D-13. Mutation: put sandbox into a payload, or set the envelope flag from anything but the order.
    it('a sandbox order carries sandbox=true on its row and on the ENVELOPE of every event, never in a payload', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(playerIn(h, 'p1', true), {
        operationKey: 'k',
        itemId: item,
      });
      expect(redemption.sandbox).toBe(true);
      const events = await h.outbox(h.tenantId);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.sandbox).toBe(true);
        expect('sandbox' in (e.payload as object)).toBe(false);
      }
    });
  });
}
