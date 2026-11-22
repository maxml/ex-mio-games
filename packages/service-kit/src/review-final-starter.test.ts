import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DataSource } from 'typeorm';
import { runMigrationsCli } from './migrate';

/*
 * Final review, starter cross-check (items 7, 8, 12). Each item failed in a sibling codebase.
 *
 * STARTER-7 (RED at a4d97bb): Deckhand runs `migrations.run` with `/bin/sh -lc` in a runtime
 *   container that holds NO app code. `.deckhand/deploy.yml` says `sh scripts/migrate-all.sh`:
 *   that file is not in the container, so the step cannot run. The working form is
 *   `docker run <service image> node dist/migrate.js`, per service, inline in the manifest.
 *   Mutation for the fix: point `run` back at a repo script -> red.
 * STARTER-8 (RED at a4d97bb): `runMigrationsCli` exits 0 with "nothing to apply" when the image
 *   ships no migrations (a missing `dist/model/migrations` glob matches nothing), and it never
 *   checks that what is applied equals what is shipped. Mutation for the fix: drop the check -> red.
 * STARTER-12 (green): `synchronize` is never on outside tests. Mutation (re-applied in the review):
 *   `synchronize: true` in postgres.ts -> red.
 */

const ROOT = resolve(__dirname, '../../..');

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === '.next') return [];
    const rel = join(dir, name);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
};

/** A DataSource double: what runMigrationsCli touches, nothing more. */
function fakeDataSource(o: {
  shipped: number;
  applied: number;
  pendingAfter: boolean;
}): DataSource {
  const migrations = Array.from({ length: o.shipped }, (_, i) => ({ name: `M${i}` }));
  return {
    isInitialized: true,
    migrations,
    initialize: async () => undefined,
    destroy: async () => undefined,
    createQueryRunner: () => ({ query: async () => [], release: async () => undefined }),
    runMigrations: async () => migrations.slice(0, o.applied),
    showMigrations: async () => o.pendingAfter,
    query: async () => [],
  } as unknown as DataSource;
}

describe('final review: starter cross-check', () => {
  it('STARTER-7 the Deckhand migration step runs the service images, not a repo script', () => {
    const manifest = readFileSync(join(ROOT, '.deckhand/deploy.yml'), 'utf8');
    const block = manifest.split(/\nmigrations:\s*\n/)[1]?.split(/\n\S/)[0] ?? '';
    const run = /\n?\s+run:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    expect(run).not.toBe('');
    // The runtime container has no checkout: no repo path, no pnpm, no bare node of app code.
    expect(run).not.toMatch(/scripts\/|\bpnpm\b|^\s*['"]?node\b/);
    for (const svc of ['identity', 'engagement', 'payments']) {
      expect(run).toMatch(new RegExp(`docker run[^;&|]*${svc}[^;&|]*node dist/migrate\\.js`));
    }
  });

  it('STARTER-8a a migrate run with no shipped migrations fails (exit != 0) instead of "nothing to apply"', async () => {
    const lines: string[] = [];
    const code = await runMigrationsCli(
      () => fakeDataSource({ shipped: 0, applied: 0, pendingAfter: false }),
      (l) => void lines.push(l),
    );
    expect(code).not.toBe(0);
  });

  it('STARTER-8b a run that leaves shipped migrations pending fails', async () => {
    const code = await runMigrationsCli(
      () => fakeDataSource({ shipped: 3, applied: 1, pendingAfter: true }),
      () => undefined,
    );
    expect(code).not.toBe(0);
  });

  it('STARTER-8c control: a run that applies every shipped migration (or finds them applied) exits 0', async () => {
    expect(
      await runMigrationsCli(
        () => fakeDataSource({ shipped: 3, applied: 3, pendingAfter: false }),
        () => undefined,
      ),
    ).toBe(0);
    expect(
      await runMigrationsCli(
        () => fakeDataSource({ shipped: 3, applied: 0, pendingAfter: false }),
        () => undefined,
      ),
    ).toBe(0);
  });

  it('STARTER-12 no TypeORM option turns synchronize, dropSchema or migrationsRun on outside tests', () => {
    const files = ['apps', 'packages']
      .flatMap((top) => readdirSync(join(ROOT, top)).flatMap((n) => walk(join(top, n, 'src'))))
      .filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.(test|spec|itest|pgtest)\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const on = files.filter((f) =>
      /\b(synchronize|dropSchema|migrationsRun)\s*:\s*(true|!|process\.env|env\.)/.test(
        readFileSync(join(ROOT, f), 'utf8'),
      ),
    );
    expect(on).toEqual([]);
  });
});
