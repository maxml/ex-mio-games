import type { DataSource } from 'typeorm';
import { grantAppRoleSql, appRoleName } from './grants';
import { runDlqCli } from './dlq-cli';
import { MIGRATION_LOCK_ID, runMigrationsCli } from './migrate';

describe('grantAppRoleSql', () => {
  it('gives CONNECT on this database, revokes everything first, then grants exactly the listed privileges', () => {
    expect(
      grantAppRoleSql(appRoleName('payments'), { coin_credits: ['SELECT', 'INSERT'] }),
    ).toEqual([
      `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'payments_app'); END $$`,
      'REVOKE ALL ON "coin_credits" FROM "payments_app"',
      'GRANT SELECT, INSERT ON "coin_credits" TO "payments_app"',
    ]);
  });

  it('rejects an unsafe identifier', () => {
    expect(() => grantAppRoleSql('app', { 'x; DROP TABLE y': ['SELECT'] })).toThrow();
    expect(() => grantAppRoleSql('app"; --', { t: ['SELECT'] })).toThrow();
  });
});

describe('runMigrationsCli', () => {
  it('takes the advisory lock on its own connection before it runs the migrations', async () => {
    const order: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        order.push(`${sql}:${String(params?.[0])}`);
      }),
      release: jest.fn(async () => undefined),
    };
    // Fix round 2 (test owner): the double now has the shape of a real DataSource, a shipped
    // migration and `showMigrations`, because migrate fails closed without them (D-31 R5). The
    // property is unchanged: the lock is taken on its own connection BEFORE runMigrations.
    // Mutation: run the migrations before the advisory lock in migrate.ts -> red.
    const ds = {
      isInitialized: true,
      initialize: jest.fn(async () => undefined),
      createQueryRunner: () => runner,
      migrations: [{ name: 'Init1' }],
      showMigrations: jest.fn(async () => false),
      runMigrations: jest.fn(async () => {
        order.push('runMigrations');
        return [];
      }),
      destroy: jest.fn(async () => undefined),
    } as unknown as DataSource;
    expect(
      await runMigrationsCli(
        () => ds,
        () => undefined,
      ),
    ).toBe(0);
    expect(order).toEqual([`SELECT pg_advisory_lock($1):${MIGRATION_LOCK_ID}`, 'runMigrations']);
    expect(ds.destroy).toHaveBeenCalled();
  });
});

describe('runDlqCli', () => {
  it('rejects unknown arguments and a bad limit with exit code 2', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await runDlqCli({ service: 'x', argv: ['--bogus'], env: { AMQP_URL: 'amqp://x' } }),
      ).toBe(2);
      expect(
        await runDlqCli({ service: 'x', argv: ['--limit', 'abc'], env: { AMQP_URL: 'amqp://x' } }),
      ).toBe(2);
    } finally {
      write.mockRestore();
    }
  });

  it('needs AMQP_URL', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runDlqCli({ service: 'x', argv: ['--dry-run'], env: {} })).toBe(1);
    } finally {
      write.mockRestore();
    }
  });
});
