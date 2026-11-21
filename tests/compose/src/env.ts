import { Client } from 'pg';

const port = (name: string, fallback: number) => process.env[name] ?? String(fallback);

/** Where the compose stack listens on the host. Override with the same variables compose uses. */
export const urls = {
  web: `http://localhost:${port('WEB_PORT', 3000)}`,
  identity: `http://localhost:${port('IDENTITY_PORT', 4001)}`,
  engagement: `http://localhost:${port('ENGAGEMENT_PORT', 4002)}`,
  payments: `http://localhost:${port('PAYMENTS_PORT', 4003)}`,
  casinoSim: `http://localhost:${port('CASINO_SIM_PORT', 4004)}`,
  amqp: `amqp://mio:mio-dev@localhost:${port('RABBITMQ_PORT', 55672)}`,
};

export const PLATFORM_TOKEN = 'dev-platform-token-0000';

/**
 * A pg client logged in as one of the per-service roles (or the admin, for catalog queries).
 * `database` defaults to the service's own database, or `postgres` for the admin; pass it to look
 * at a service's catalog as the admin.
 *
 * `engagement_app` (D-12) is the engagement RUNTIME role: not the owner, no DDL, only the grants of
 * docs/specs/engagement-ingest.md section 10. `engagement` is the owner that runs the migrations.
 * Both log in to the `engagement` database.
 */
export async function pgAs(
  role: 'identity' | 'engagement' | 'engagement_app' | 'payments' | 'postgres',
  database?: 'identity' | 'engagement' | 'payments' | 'postgres',
): Promise<Client> {
  const password =
    role === 'postgres'
      ? 'postgres-dev'
      : role === 'engagement_app'
        ? 'engagement-app-dev'
        : `${role}-dev`;
  const ownDb = role === 'engagement_app' ? 'engagement' : role;
  const client = new Client({
    host: 'localhost',
    port: Number(port('POSTGRES_PORT', 54329)),
    user: role,
    password,
    database: database ?? (role === 'postgres' ? 'postgres' : ownDb),
  });
  await client.connect();
  return client;
}

export async function eventually<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}
