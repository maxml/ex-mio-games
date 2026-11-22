import { StoreRejection, type Scope } from '../ports';
import type { StoreHarness } from './store-conformance';

/*
 * Final review (question 5, D-28 "Sandbox stock"): a sandbox order does not decrement the real
 * stock and does not count against the per-player limit; both stay production-only. The rule was
 * written into PgRedemptionStore only. The in-memory fake (testing/memory-store.ts), which every
 * saga unit test runs on, still decrements stock and the limit for a sandbox order, so the saga
 * tests run against a store that disagrees with Postgres (D-8: the fake must conform).
 *
 * This suite runs against both: review-final-sandbox.conformance.test.ts (memory, unit) and
 * review-final-sandbox.pg.itest.ts (Postgres, compose-only: `test:pg`).
 *
 * Mutations:
 *  - redemption.store.ts `if (!scope.sandbox)` around the counter and the stock removed
 *    -> SBX-1, SBX-2, SBX-4 red (Postgres run).
 *  - redemption.store.ts `restoreStock && !rec.sandbox` -> `restoreStock` -> SBX-3 red.
 *  - The memory store is the mutation at a4d97bb: SBX-1, SBX-2, SBX-3, SBX-4 RED there.
 */

const pid = (n: number): string => `0190a1b2-c3d4-7e5f-8a6b-5bd00000${String(n).padStart(4, '0')}`;

export function sandboxStockConformance(name: string, make: () => Promise<StoreHarness>): void {
  describe(`final review D-28 sandbox orders skip stock and the per-player limit (${name})`, () => {
    const as = (h: StoreHarness, n: number, sandbox: boolean): Scope => ({
      tenantId: h.tenantId,
      playerId: pid(n),
      sandbox,
    });
    const rejection = async (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'created',
        (e: unknown) => (e instanceof StoreRejection ? e.code : `threw ${String(e)}`),
      );

    it('SBX-1 a sandbox order leaves the real stock alone; the last unit stays for a production order', async () => {
      const h = await make();
      const item = await h.addItem({ price: 10, stock: 1 });
      const s = await h.store.placeOrder(as(h, 1, true), {
        operationKey: 'sbx-key-1',
        itemId: item,
      });
      expect(s.created).toBe(true);
      expect(s.redemption.sandbox).toBe(true);
      expect(await h.stockOf(item)).toBe(1);
      const p = await h.store.placeOrder(as(h, 1, false), {
        operationKey: 'prd-key-1',
        itemId: item,
      });
      expect(p.created).toBe(true);
      expect(await h.stockOf(item)).toBe(0);
    });

    it('SBX-2 sandbox orders do not use the production per-player limit; the production limit still holds', async () => {
      const h = await make();
      const item = await h.addItem({ price: 10, stock: null, perPlayerLimit: 1 });
      for (const key of ['sbx-key-a', 'sbx-key-b']) {
        const r = await h.store.placeOrder(as(h, 2, true), { operationKey: key, itemId: item });
        expect(r.created).toBe(true);
      }
      const p = await h.store.placeOrder(as(h, 2, false), {
        operationKey: 'prd-key-a',
        itemId: item,
      });
      expect(p.created).toBe(true);
      expect(
        await rejection(
          h.store.placeOrder(as(h, 2, false), { operationKey: 'prd-key-b', itemId: item }),
        ),
      ).toBe('limit_reached');
    });

    it('SBX-3 releasing a sandbox order gives back no stock it never took', async () => {
      const h = await make();
      const item = await h.addItem({ price: 10, stock: 2 });
      const s = await h.store.placeOrder(as(h, 3, true), {
        operationKey: 'sbx-key-r',
        itemId: item,
      });
      const res = await h.store.apply(h.tenantId, s.redemption.id, {
        expectFrom: ['REQUESTED'],
        to: 'REJECTED_FUNDS',
        cause: 'insufficient_funds',
        reservation: 'release',
      });
      expect(res.applied).toBe(true);
      expect(await h.stockOf(item)).toBe(2);
    });

    it('SBX-4 an item out of stock in production can still be ordered in sandbox (the stock step is skipped)', async () => {
      const h = await make();
      const item = await h.addItem({ price: 10, stock: 0 });
      expect(
        await rejection(
          h.store.placeOrder(as(h, 4, false), { operationKey: 'prd-key-o', itemId: item }),
        ),
      ).toBe('out_of_stock');
      const s = await h.store.placeOrder(as(h, 4, true), {
        operationKey: 'sbx-key-o',
        itemId: item,
      });
      expect(s.created).toBe(true);
      expect(await h.stockOf(item)).toBe(0);
    });
  });
}
