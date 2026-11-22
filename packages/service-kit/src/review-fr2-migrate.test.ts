import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { runMigrationsCli } from './migrate';

/*
 * Fix round 2 re-review, R5: "what did the fix move?". 124a8c5 made the PRE-condition fail closed
 * (`if (!shipped)`), and MIG-REAL-3 is green. The POST-condition still reads
 * `if (source.showMigrations && (await ds.showMigrations()))`: on an object without the method the
 * check is skipped and a run that left a shipped migration pending exits 0 ("nothing to apply").
 * The same shape-of-a-double dependency R5 named, one line further down. A real DataSource always has
 * the method, so production is safe today; the guard is still fail-open by construction.
 *
 * MIG-FR2-1 (RED at 6298275): one shipped migration, nothing applied, no `showMigrations` -> exit 1.
 *   Fix: call `ds.showMigrations()` unconditionally (a missing method then throws, which is exit 1).
 * MIG-FR2-0 (green control): the same run WITH `showMigrations` exits 1.
 */

function dataSource(dir: string, withShow: boolean): DataSource {
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
  any['runMigrations'] = async () => []; // nothing applied: the shipped migration stays pending
  any['showMigrations'] = withShow ? async () => true : undefined;
  any['destroy'] = async () => undefined;
  return ds;
}

describe('fix round 2: migrate post-condition does not depend on the double (R5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-fr2-'));
    writeFileSync(
      join(dir, '1-One.js'),
      'exports.One1 = class One1 { constructor(){ this.name = "One1"; } async up(){} async down(){} };',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('MIG-FR2-0 control: a pending shipped migration fails the run', async () => {
    expect(
      await runMigrationsCli(
        () => dataSource(dir, true),
        () => undefined,
      ),
    ).toBe(1);
  });

  // Known defect F4, backlog task MIO-211 (with F5, the unpinned 1733* migrations). `it.failing`: green
  // while the post-condition is skipped, RED once migrate calls showMigrations unconditionally. Then
  // turn it back into `it` (the assertion is unchanged). MIG-FR2-0 is the non-vacuity control.
  it.failing(
    'MIG-FR2-1 without `showMigrations` a pending shipped migration still fails the run (MIO-211, expected to fail until fixed)',
    async () => {
      expect(
        await runMigrationsCli(
          () => dataSource(dir, false),
          () => undefined,
        ),
      ).toBe(1);
    },
  );
});
