import { Client } from 'pg';

// Shared by the `*.pgtest.ts` files. They need a Postgres with the payments migrations applied
// (the compose postgres, see docs/specs/payments.md section "How to run the tests").

const port = Number(process.env.POSTGRES_PORT ?? 54329);

/** `payments_app`: the runtime role (not owner, not superuser, NOBYPASSRLS).
 *  `payments_owner`: the owner and migration role. `postgres`: superuser, used only to inspect or tamper.
 *  Names and passwords are the foundation's (docker/postgres/init.sh). */
export type PgRole = 'payments_app' | 'payments_owner' | 'postgres';

const passwords: Record<PgRole, string> = {
  payments_app: 'payments-app-dev',
  payments_owner: 'payments-owner-dev',
  postgres: 'postgres-dev',
};

export async function connectAs(role: PgRole): Promise<Client> {
  const client = new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port,
    user: role,
    password: passwords[role],
    database: 'payments',
  });
  await client.connect();
  return client;
}

/** Run `fn` in one transaction of `client` with `app.tenant_id` set, the way `Db.tenantTx` does. */
export async function inTenant<T>(
  client: Client,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn();
    await client.query('COMMIT'); // deferred constraint triggers fire here and may reject
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hold a row lock while `fn` launches work, so that every contender is already in flight (and a
 * read-then-write implementation has already read the old value) before the first write can land.
 * Also reports the peak number of runtime-role connections that held an open transaction meanwhile:
 * proof that the work really overlapped on separate connections.
 */
export async function withRowLocked<T>(
  admin: Client,
  lockSql: string,
  params: unknown[],
  launch: () => Promise<T>,
  holdMs = 400,
): Promise<{ result: T; peakOpenTransactions: number }> {
  const locker = await connectAs('postgres');
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = 'payments_app' AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`,
      );
      peak = Math.max(peak, rows[0].n as number);
      await sleep(5);
    }
  })();
  try {
    await locker.query('BEGIN');
    await locker.query(lockSql, params);
    const running = launch();
    await sleep(holdMs);
    await locker.query('COMMIT');
    const result = await running;
    return { result, peakOpenTransactions: peak };
  } finally {
    sampling = false;
    await sampler;
    await locker.query('ROLLBACK').catch(() => undefined);
    await locker.end();
  }
}
