import type { DataSource } from 'typeorm';
import { grantAppRoleSql, appRoleName } from './grants';
import { runDlqCli } from './dlq-cli';
import { MIGRATION_LOCK_ID, runMigrationsCli } from './migrate';

describe('grantAppRoleSql', () => {
  it('revokes everything first, then grants exactly the listed privileges', () => {
    expect(
      grantAppRoleSql(appRoleName('payments'), { coin_credits: ['SELECT', 'INSERT'] }),
    ).toEqual([
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
    const ds = {
      isInitialized: true,
      initialize: jest.fn(async () => undefined),
      createQueryRunner: () => runner,
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
