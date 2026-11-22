import { uuidv7 } from '@ex-mio/contracts';
import { TestClock } from './testing/clock';
import { MemoryStore } from './testing/memory-store';
import type { StoreHarness } from './testing/store-conformance';
import { stageBConformance } from './testing/stage-b-conformance';

// Stage B fix-round contract (F2, F3, F5) against the in-memory fake; the Postgres run is
// redemption-store.stageb.pg.itest.ts. Two harnesses share ONE store: the inbox is shared by tenants.
stageBConformance('memory', async () => {
  const clock = new TestClock();
  const store = new MemoryStore(() => clock.now());
  const harness = (): StoreHarness => ({
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
  });
  return [harness(), harness()];
});
