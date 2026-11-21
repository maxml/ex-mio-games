import { Client } from 'pg';

// Shared by the `*.pgtest.ts` files. They need a Postgres with the payments migrations applied
// (the compose postgres, see docs/specs/payments.md section "How to run the tests").

const port = Number(process.env.POSTGRES_PORT ?? 54329);

/** `payments_app`: the runtime role (not owner, not superuser, NOBYPASSRLS).
 *  `payments`: the owner and migration role. `postgres`: superuser, used only to inspect or tamper. */
export type PgRole = 'payments_app' | 'payments' | 'postgres';

const passwords: Record<PgRole, string> = {
  payments_app: 'payments_app-dev',
  payments: 'payments-dev',
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
