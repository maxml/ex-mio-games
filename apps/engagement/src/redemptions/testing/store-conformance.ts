import type { EventEnvelope, RedemptionState } from '@ex-mio/contracts';
import { StoreRejection, type RedemptionStore, type Scope } from '../ports';

/** What the suite needs besides the store: a way to seed items and to look at counters and the outbox. */
export interface StoreHarness {
  store: RedemptionStore;
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

const player = (h: StoreHarness, id: string, sandbox = false): Scope => ({
  tenantId: h.tenantId,
  playerId: id,
  sandbox,
});

const all = (...s: RedemptionState[]): RedemptionState[] => s;

/**
 * The RedemptionStore contract (docs/specs/engagement-store.md §4.1). Runs
 * against the in-memory store now (to keep the fake honest) and against the
 * Postgres store in Stage B (`redemption-store.pg.itest.ts`).
 *
 * Mutations (each makes the named test red):
 *  - stock check not conditional / not atomic -> 'never goes below zero under 50 parallel reservations'
 *  - per-player limit check removed             -> 'per-player limit holds under parallel orders'
 *  - dedupe lookup removed                      -> 'same operation key returns the existing order'
 *  - price/mapping read live instead of frozen  -> 'price and reward mapping are frozen on the order'
 *  - illegal-pair check removed from apply      -> 'apply rejects a pair outside the table'
 *  - inbox row not written in the same tx       -> 'a repeated event id applies nothing'
 *  - outbox write moved outside the tx          -> 'state change and outbox message commit together'
 *  - release not guarded by state               -> 'releasing the reservation twice restores stock once'
 *  - getOwn ignores player or sandbox           -> 'lookup is (tenant, player, sandbox, id)'
 */
export function storeConformance(label: string, setup: () => Promise<StoreHarness>): void {
  describe(`RedemptionStore contract: ${label}`, () => {
    let h: StoreHarness;
    beforeEach(async () => {
      h = await setup();
    });

    it('same operation key returns the existing order, once', async () => {
      const item = await h.addItem({ price: 10, stock: 5 });
      const a = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: item });
      const b = await h.store.placeOrder(player(h, 'p1'), { operationKey: 'k1', itemId: item });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.redemption.id).toBe(a.redemption.id);
      expect(await h.stockOf(item)).toBe(4);
      const holds = (await h.outbox(h.tenantId)).filter((e) => e.type === 'engagement.hold.place');
      expect(holds).toHaveLength(1);
      expect((holds[0]?.payload as { operation_id: string }).operation_id).toBe(
        `hold:${a.redemption.id}`,
      );
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

    it('an inactive item cannot be redeemed', async () => {
      const item = await h.addItem({ price: 10 });
      await h.deactivate(item);
      await expect(
        h.store.placeOrder(player(h, 'p1'), { operationKey: 'k', itemId: item }),
      ).rejects.toMatchObject({ code: 'item_inactive' });
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
        cause: 'hold_placed',
        nextAttemptAt: new Date(0),
      });
      expect(res.applied).toBe(true);
      const after = await h.outbox(h.tenantId);
      const changed = after
        .slice(before)
        .filter((e) => e.type === 'engagement.redemption.status_changed');
      expect(changed).toHaveLength(1);
      expect((changed[0]?.payload as { sandbox: boolean }).sandbox).toBe(false);
      // and a failing change leaves neither the state nor an outbox row behind
      const n = (await h.outbox(h.tenantId)).length;
      await expect(
        h.store.apply(h.tenantId, redemption.id, {
          expectFrom: all('RESERVED'),
          to: 'COMPLETED',
          cause: 'bad',
          outbox: [{ type: 'engagement.hold.capture', payload: { operation_id: 'x' } }],
        }),
      ).rejects.toMatchObject({ name: 'IllegalTransitionError' });
      expect((await h.outbox(h.tenantId)).length).toBe(n);
      expect((await h.store.getOwn(player(h, 'p1'), redemption.id))?.state).toBe('RESERVED');
    });

    it('apply rejects a pair outside the table', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      await expect(
        h.store.apply(h.tenantId, redemption.id, {
          expectFrom: all('REQUESTED'),
          to: 'ISSUED',
          cause: 'skip',
        }),
      ).rejects.toMatchObject({ name: 'IllegalTransitionError' });
    });

    it('a change whose expected state is stale applies nothing', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      const res = await h.store.apply(h.tenantId, redemption.id, {
        expectFrom: all('RESERVED'),
        to: 'ISSUING',
        cause: 'x',
      });
      expect(res.applied).toBe(false);
      expect(res.redemption.state).toBe('REQUESTED');
    });

    it('a repeated event id applies nothing', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      const change = {
        expectFrom: all('REQUESTED', 'RESERVED'),
        to: 'RESERVED' as const,
        cause: 'hold_placed',
        dedupe: { consumer: 'saga', eventId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' },
      };
      expect((await h.store.apply(h.tenantId, redemption.id, change)).applied).toBe(true);
      const n = (await h.outbox(h.tenantId)).length;
      expect((await h.store.apply(h.tenantId, redemption.id, change)).applied).toBe(false);
      expect((await h.outbox(h.tenantId)).length).toBe(n);
    });

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

    it('lookup is (tenant, player, sandbox, id)', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1'), {
        operationKey: 'k',
        itemId: item,
      });
      expect(await h.store.getOwn(player(h, 'p1'), redemption.id)).not.toBeNull();
      expect(await h.store.getOwn(player(h, 'p2'), redemption.id)).toBeNull();
      expect(await h.store.getOwn(player(h, 'p1', true), redemption.id)).toBeNull();
      expect(
        await h.store.getOwn(
          { tenantId: h.otherTenantId, playerId: 'p1', sandbox: false },
          redemption.id,
        ),
      ).toBeNull();
      expect(await h.store.getForOperator(h.otherTenantId, redemption.id)).toBeNull();
      expect(await h.store.listForOperator(h.otherTenantId)).toHaveLength(0);
    });

    it('a sandbox order carries sandbox=true on its rows and events', async () => {
      const item = await h.addItem({ price: 10 });
      const { redemption } = await h.store.placeOrder(player(h, 'p1', true), {
        operationKey: 'k',
        itemId: item,
      });
      expect(redemption.sandbox).toBe(true);
      const events = await h.outbox(h.tenantId);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect((e.payload as { sandbox: boolean }).sandbox).toBe(true);
    });
  });
}
