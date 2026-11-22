import type { SeedStore } from './repositories';
import { createSeedProvider } from './seeds';

/**
 * The real SeedProvider over a versioned seed store (review R2-3, F12; MIO-063, MIO-069). The store
 * here is a mutable fake that implements the SeedStore interface; the provider is the production
 * code. This is the reader an audit depends on: a spin stored under seed version 1 is recomputed
 * with `seed(tenant, 1)` after a rotation.
 *
 * Mutations (each turns the named tests red):
 *  - `seed(tenant, version)` ignores `version` and returns the current seed (or the first)
 *                                                          -> INV-SEED-BY-VERSION.
 *  - `current` returns the lowest version or the last one inserted rather than the highest
 *                                                          -> INV-SEED-CURRENT-IS-HIGHEST.
 *  - an unknown version returns undefined / the current seed instead of throwing
 *                                                          -> INV-SEED-UNKNOWN-THROWS.
 *  - the provider caches the first `current` and never sees a version added later
 *                                                          -> INV-SEED-ROTATION-LIVE.
 *  - the store is shared across tenants (tenant argument dropped)
 *                                                          -> INV-SEED-PER-TENANT.
 */

const T1 = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const T2 = '0190a1b2-c3d4-4e5f-8a6b-000000000002';

class MemoryStore implements SeedStore {
  private readonly data = new Map<string, Map<number, string>>();
  add(tenantId: string, version: number, seed: string): void {
    const m = this.data.get(tenantId) ?? new Map<number, string>();
    m.set(version, seed);
    this.data.set(tenantId, m);
  }
  versions(tenantId: string): number[] {
    return [...(this.data.get(tenantId)?.keys() ?? [])];
  }
  get(tenantId: string, version: number): string | undefined {
    return this.data.get(tenantId)?.get(version);
  }
}

describe('SeedProvider (real implementation over a versioned store)', () => {
  const store = new MemoryStore();
  store.add(T1, 2, 'seed-t1-v2'); // inserted out of order on purpose
  store.add(T1, 1, 'seed-t1-v1');
  store.add(T2, 1, 'seed-t2-v1');
  const seeds = createSeedProvider(store);

  it('INV-SEED-BY-VERSION: seed(tenant, version) returns the seed of exactly that version', () => {
    expect(seeds.seed(T1, 1)).toBe('seed-t1-v1');
    expect(seeds.seed(T1, 2)).toBe('seed-t1-v2');
    expect(seeds.seed(T1, 1)).not.toBe(seeds.seed(T1, 2));
  });

  it('INV-SEED-CURRENT-IS-HIGHEST: current(tenant) is the highest version, whatever the insertion order', () => {
    expect(seeds.current(T1)).toEqual({ version: 2, seed: 'seed-t1-v2' });
    expect(seeds.current(T2)).toEqual({ version: 1, seed: 'seed-t2-v1' });
  });

  it('INV-SEED-UNKNOWN-THROWS: a version that does not exist, or a tenant without seeds, throws', () => {
    expect(() => seeds.seed(T1, 3)).toThrow();
    expect(() => seeds.seed(T1, 0)).toThrow();
    expect(() => seeds.seed(T1, 1.5)).toThrow();
    expect(() => seeds.seed('0190a1b2-c3d4-4e5f-8a6b-0000000000ff', 1)).toThrow();
    expect(() => seeds.current('0190a1b2-c3d4-4e5f-8a6b-0000000000ff')).toThrow();
  });

  it('INV-SEED-PER-TENANT: a tenant never reads another tenant seed', () => {
    expect(seeds.seed(T2, 1)).toBe('seed-t2-v1');
    expect(() => seeds.seed(T2, 2)).toThrow(); // v2 exists for T1 only
  });

  it('INV-SEED-ROTATION-LIVE: a version added to the store becomes current without a restart, and the old version stays readable', () => {
    const live = new MemoryStore();
    live.add(T1, 1, 'a');
    const p = createSeedProvider(live);
    expect(p.current(T1).version).toBe(1);
    live.add(T1, 2, 'b'); // rotation
    expect(p.current(T1)).toEqual({ version: 2, seed: 'b' });
    expect(p.seed(T1, 1)).toBe('a');
  });
});
