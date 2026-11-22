import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { runMigrationsCli } from './migrate';

/*
 * Fix-round re-review, coordinator question 1. `runMigrationsCli` reads `migrations` and
 * `showMigrations` as OPTIONAL so the hand-made double in ops.test.ts keeps working. These tests pin
 * the behaviour on a REAL typeorm DataSource (its constructor sets `migrations = []`, and
 * `buildMetadatas()` loads the glob with no database), so the pre-condition is proven on the shape
 * production builds, not on a double.
 *
 * Only `initialize` (which would connect) and the four calls that need a connection are replaced;
 * `migrations` is the DataSource's own field, filled by its own `buildMetadatas`.
 *
 * MIG-REAL-1 (green): an empty migrations glob on a real DataSource exits 1.
 *   Mutation: delete the `shipped === 0` pre-condition in migrate.ts -> red.
 * MIG-REAL-2 (green): the same DataSource with one shipped and applied migration exits 0 (control).
 * MIG-REAL-3 (RED at dd9d464): a DataSource whose `migrations` list is ABSENT must fail closed. Today
 *   `source.migrations?.length` is undefined, `undefined === 0` is false, and the run says
 *   "nothing to apply" with exit 0: the guard is skipped for any object that does not carry the
 *   field. Fix: `if (!shipped)`, and give the ops.test.ts double a `migrations` array.
 */

function realDataSource(dir: string, applied: number): DataSource {
  const ds = new DataSource({
    type: 'postgres',
    url: 'postgres://nobody@127.0.0.1:1/none',
    entities: [],
    migrations: [join(dir, '*.js')],
  });
  const any = ds as unknown as Record<string, unknown>;
  any['initialize'] = async () => {
    await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    Object.defineProperty(ds, 'isInitialized', { value: true, configurable: true });
    return ds;
  };
  any['createQueryRunner'] = () => ({ query: async () => [], release: async () => undefined });
  any['runMigrations'] = async () => ds.migrations.slice(0, applied);
  any['showMigrations'] = async () => applied < ds.migrations.length;
  any['destroy'] = async () => undefined;
  return ds;
}

describe('fix-round re-review: runMigrationsCli on a real DataSource (Q1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('MIG-REAL-0 a real DataSource carries `migrations` as an array before and after buildMetadatas', async () => {
    const ds = realDataSource(dir, 0);
    expect(Array.isArray(ds.migrations)).toBe(true);
    await ds.initialize();
    expect(Array.isArray(ds.migrations)).toBe(true);
    expect(typeof ds.showMigrations).toBe('function');
  });

  it('MIG-REAL-1 an empty migrations directory fails the run (exit 1)', async () => {
    expect(
      await runMigrationsCli(
        () => realDataSource(dir, 0),
        () => undefined,
      ),
    ).toBe(1);
  });

  it('MIG-REAL-2 control: one shipped migration, applied, exits 0', async () => {
    writeFileSync(
      join(dir, '1-One.js'),
      'exports.One1 = class One1 { constructor(){ this.name = "One1"; } async up(){} async down(){} };',
    );
    expect(
      await runMigrationsCli(
        () => realDataSource(dir, 1),
        () => undefined,
      ),
    ).toBe(0);
    // ...and a run that leaves it pending fails.
    expect(
      await runMigrationsCli(
        () => realDataSource(dir, 0),
        () => undefined,
      ),
    ).toBe(1);
  });

  it('MIG-REAL-3 a data source without a `migrations` list fails closed instead of "nothing to apply"', async () => {
    const ds = realDataSource(dir, 0);
    const lines: string[] = [];
    const stripped = (): DataSource => {
      Object.defineProperty(ds, 'migrations', { value: undefined, configurable: true });
      const init = ds.initialize.bind(ds);
      (ds as unknown as Record<string, unknown>)['initialize'] = async () => {
        await init();
        Object.defineProperty(ds, 'migrations', { value: undefined, configurable: true });
        return ds;
      };
      // The calls a connection would answer: nothing applied, nothing pending (so exit 1 can only
      // come from the missing-list pre-condition, not from a throw in the stubs).
      (ds as unknown as Record<string, unknown>)['runMigrations'] = async () => [];
      (ds as unknown as Record<string, unknown>)['showMigrations'] = async () => false;
      return ds;
    };
    expect(await runMigrationsCli(stripped, (l) => void lines.push(l))).toBe(1);
  });
});
