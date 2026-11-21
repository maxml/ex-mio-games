import { uuidv7 } from '@ex-mio/contracts';
import { MemoryStore } from './testing/memory-store';
import { storeConformance } from './testing/store-conformance';

// Keeps the in-memory fake honest: the same contract suite runs against the
// Postgres store in redemption-store.pg.itest.ts. (This file is green at Stage A.)
storeConformance('memory', async () => {
  const store = new MemoryStore();
  const tenantId = uuidv7();
  return {
    store,
    tenantId,
    otherTenantId: uuidv7(),
    async addItem(o) {
      return store.addItem({
        price: o.price,
        stock: o.stock ?? null,
        perPlayerLimit: o.perPlayerLimit ?? null,
      }).id;
    },
    async editItem(id, patch) {
      store.editItem(id, {
        ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.rewardType ? { reward: { type: patch.rewardType, params: {} } } : {}),
      });
    },
    async deactivate(id) {
      store.editItem(id, { active: false });
    },
    async stockOf(id) {
      return store.stockOf(id);
    },
    async outbox() {
      return store.outbox.map((r) => r.envelope);
    },
  };
});
