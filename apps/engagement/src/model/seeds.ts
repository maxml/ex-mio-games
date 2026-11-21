import type { SeedProvider, SeedStore } from './repositories';

/**
 * The real `SeedProvider` over a versioned `SeedStore` (R2-3). Nothing is cached: a version added to
 * the store (a rotation) is the current one on the next call, and an older version stays readable so
 * a spin stored under it can be recomputed (MIO-063, MIO-069). Unknown tenant or version throws.
 */
export function createSeedProvider(store: SeedStore): SeedProvider {
  return {
    current(tenantId) {
      const versions = store.versions(tenantId);
      if (versions.length === 0) throw new Error('no wheel seed for this tenant');
      const version = Math.max(...versions);
      const seed = store.get(tenantId, version);
      if (seed === undefined) throw new Error('wheel seed store is inconsistent');
      return { version, seed };
    },
    seed(tenantId, version) {
      if (!Number.isInteger(version) || version < 1) throw new Error('invalid seed version');
      const seed = store.get(tenantId, version);
      if (seed === undefined) throw new Error('unknown wheel seed version');
      return seed;
    },
  };
}

/**
 * Dev store from the `WHEEL_SEEDS` environment value, a JSON object `{"<version>": "<seed>"}`. The
 * same versions apply to every tenant; a secret store replaces it later. Never logged.
 */
export function envSeedStore(raw: string): SeedStore {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WHEEL_SEEDS must be a JSON object of version to seed');
  }
  const seeds = new Map<number, string>();
  for (const [key, value] of Object.entries(parsed)) {
    const version = Number(key);
    if (!Number.isInteger(version) || version < 1 || typeof value !== 'string' || value === '') {
      throw new Error('WHEEL_SEEDS entries must be positive integer versions with a string seed');
    }
    seeds.set(version, value);
  }
  return {
    versions: () => [...seeds.keys()],
    get: (_tenantId, version) => seeds.get(version),
  };
}
