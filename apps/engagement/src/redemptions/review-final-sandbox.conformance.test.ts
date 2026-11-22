import { uuidv7 } from '@ex-mio/contracts';
import { TestClock } from './testing/clock';
import { MemoryStore } from './testing/memory-store';
import { sandboxStockConformance } from './testing/review-final-sandbox-conformance';

// Final review: the in-memory fake against the D-28 sandbox rule. The same suite runs against
// Postgres in review-final-sandbox.pg.itest.ts.
sandboxStockConformance('memory', async () => {
  const clock = new TestClock();
  const store = new MemoryStore(() => clock.now());
  return {
    store,
    clock,
    tenantId: uuidv7(),
    otherTenantId: uuidv7(),
    async addItem(o) {
      return store.addItem({
        price: o.price,
        stock: o.stock ?? null,
        perPlayerLimit: o.perPlayerLimit ?? null,
      }).id;
    },
    async editItem() {},
    async deactivate() {},
    async stockOf(id) {
      return store.stockOf(id);
    },
    async outbox() {
      return store.outbox.map((r) => r.envelope);
    },
  };
});
