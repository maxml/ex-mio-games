import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { createDataSource, runMigrationsCli } from '@ex-mio/service-kit';

const PG_PORT = Number(process.env.POSTGRES_PORT ?? 54329);
const DB = `mig_${Date.now()}`;
const migrations = resolve(__dirname, '../../../apps/payments/src/model/migrations');

const admin = () =>
  new Client({
    host: 'localhost',
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres-dev',
    database: 'postgres',
  });

describe('migrate.js with two replicas on a fresh database (F-OPS-1)', () => {
  beforeAll(async () => {
    const c = admin();
    await c.connect();
    await c.query(`CREATE DATABASE "${DB}" OWNER payments_owner`);
    await c.query(`REVOKE ALL ON DATABASE "${DB}" FROM PUBLIC`);
    await c.end();
  });
  afterAll(async () => {
    const c = admin();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await c.end();
  });

  it('both exit 0: the second waits for the first, then finds nothing to apply', async () => {
    const env = {
      MIGRATION_DATABASE_URL: `postgresql://payments_owner:payments-owner-dev@localhost:${PG_PORT}/${DB}`,
      NODE_ENV: 'test',
    };
    const replica = () =>
      runMigrationsCli(
        () =>
          createDataSource({
            env,
            urlEnv: 'MIGRATION_DATABASE_URL',
            entities: [],
            migrations: [join(migrations, '*.ts')],
          }),
        () => undefined,
      );
    const codes = await Promise.all([replica(), replica()]);
    expect(codes).toEqual([0, 0]);

    // The grants migration ran too: the app role reads what it is allowed to read.
    const app = new Client({
      host: 'localhost',
      port: PG_PORT,
      user: 'payments_app',
      password: 'payments-app-dev',
      database: DB,
    });
    await app.connect();
    try {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM outbox`);
      expect(rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  }, 60_000);
});
