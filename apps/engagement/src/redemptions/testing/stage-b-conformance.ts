import type { StoreHarness } from './store-conformance';
import type { Scope } from '../ports';

/** Two harnesses over the SAME store or database, with different tenants (fresh ids each call). */
export type PairSetup = () => Promise<[StoreHarness, StoreHarness]>;

// A fixed id on purpose: running the suite twice on one database must stay green, so the inbox
// may only dedupe per (tenant, consumer, event id).
const FIXED_EVENT_ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e1f00aa';

// Player ids are UUIDs (the event contract and payments validate them, X-4); the readable labels of
// this file ('p-f2') are mapped to a stable UUID so the order's events stay valid envelopes.
const uuidOfLabel = (label: string): string => {
  const hex = Buffer.from(label).toString('hex').padEnd(12, '0').slice(0, 12);
  return `0190a1b2-c3d4-7e5f-8a6b-${hex}`;
};

/** INV-ENV-INPUT: the environment is a required argument, never defaulted. */
const scopeOf = (h: StoreHarness, playerId: string, sandbox: boolean): Scope => ({
  tenantId: h.tenantId,
  playerId: uuidOfLabel(playerId),
  sandbox,
});

/**
 * L4 stage B fix round: store-contract tests for review findings F2, F3 and F5 (and decision D-18).
 * Runs against the in-memory fake and against Postgres (same function), like `storeConformance`.
 *
 * Mutations (each makes the named test red):
 *  - `sandbox` left out of the order lookup, the unique key or the advisory-lock key
 *      -> 'F2 the same operation key in sandbox and in production gives two orders'
 *  - inbox dedupe keyed by (consumer, event id) without the tenant
 *      -> 'F3 inbox dedupe is per tenant'
 *  - the same-key advisory lock removed (Postgres only; the fake is single-threaded)
 *      -> 'F5 parallel placeOrder with one key: one order, every caller answered'
 */
export function stageBConformance(label: string, pair: PairSetup): void {
  describe(`L4 stage B fixes, store contract: ${label}`, () => {
    it('F2 the same operation key in sandbox and in production gives two orders', async () => {
      const [h] = await pair();
      const itemId = await h.addItem({ price: 10, stock: 5, perPlayerLimit: null });
      const live = await h.store.placeOrder(scopeOf(h, 'p-f2', false), {
        operationKey: 'same-key',
        itemId,
      });
      const test = await h.store.placeOrder(scopeOf(h, 'p-f2', true), {
        operationKey: 'same-key',
        itemId,
      });
      expect(live.created).toBe(true);
      expect(test.created).toBe(true);
      expect(test.redemption.id).not.toBe(live.redemption.id);
      expect(live.redemption.sandbox).toBe(false);
      expect(test.redemption.sandbox).toBe(true);
      expect(await h.stockOf(itemId)).toBe(3);
      // each mode still dedupes inside itself
      const liveAgain = await h.store.placeOrder(scopeOf(h, 'p-f2', false), {
        operationKey: 'same-key',
        itemId,
      });
      const testAgain = await h.store.placeOrder(scopeOf(h, 'p-f2', true), {
        operationKey: 'same-key',
        itemId,
      });
      expect(liveAgain).toMatchObject({ created: false });
      expect(liveAgain.redemption.id).toBe(live.redemption.id);
      expect(testAgain).toMatchObject({ created: false });
      expect(testAgain.redemption.id).toBe(test.redemption.id);
      expect(await h.stockOf(itemId)).toBe(3);
    });

    it('F3 inbox dedupe is per tenant: the same event id in two tenants applies in both, and still dedupes inside one', async () => {
      const [a, b] = await pair();
      const placeOn = async (h: StoreHarness) => {
        const itemId = await h.addItem({ price: 10, stock: null, perPlayerLimit: null });
        return (
          await h.store.placeOrder(scopeOf(h, 'p-f3', false), { operationKey: 'k-f3', itemId })
        ).redemption;
      };
      const ra = await placeOn(a);
      const rb = await placeOn(b);
      const change = (to: 'RESERVED' | 'NEEDS_REVIEW') => ({
        expectFrom: ['REQUESTED' as const],
        to,
        cause: 'f3',
        dedupe: { consumer: 'saga', eventId: FIXED_EVENT_ID },
      });
      const first = await a.store.apply(a.tenantId, ra.id, change('RESERVED'));
      expect(first.applied).toBe(true);
      // another tenant, the same consumer and event id: not a repeat
      const other = await b.store.apply(b.tenantId, rb.id, change('RESERVED'));
      expect(other.applied).toBe(true);
      expect(other.redemption.state).toBe('RESERVED');
      // inside one tenant it is a repeat: applies nothing, even through a legal pair
      const itemB = await a.addItem({ price: 10, stock: null, perPlayerLimit: null });
      const second = (
        await a.store.placeOrder(scopeOf(a, 'p-f3b', false), {
          operationKey: 'k-f3b',
          itemId: itemB,
        })
      ).redemption;
      const repeat = await a.store.apply(a.tenantId, second.id, change('RESERVED'));
      expect(repeat.applied).toBe(false);
      expect(repeat.redemption.state).toBe('REQUESTED');
    });

    it('F5 parallel placeOrder with one key: one order, every caller answered, stock taken once', async () => {
      const [h] = await pair();
      // Several rounds of one key each: a race is probabilistic, a lock-free store loses one of them.
      const ROUNDS = 12;
      const itemId = await h.addItem({ price: 10, stock: 100, perPlayerLimit: null });
      for (let round = 0; round < ROUNDS; round++) {
        const results = await Promise.allSettled(
          Array.from({ length: 30 }, () =>
            h.store.placeOrder(scopeOf(h, 'p-f5', false), {
              operationKey: `race-${round}`,
              itemId,
            }),
          ),
        );
        const failed = results.filter((r) => r.status === 'rejected');
        expect(failed).toEqual([]);
        const ok = results.map(
          (r) =>
            (r as PromiseFulfilledResult<{ redemption: { id: string }; created: boolean }>).value,
        );
        expect(new Set(ok.map((r) => r.redemption.id)).size).toBe(1);
        expect(ok.filter((r) => r.created)).toHaveLength(1);
      }
      expect(await h.stockOf(itemId)).toBe(100 - ROUNDS);
    });
  });
}
