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
  /** Firebase Auth Emulator (already in the compose file); D-7 contract test talks to it directly. */
  firebaseAuth: `http://localhost:${port('FIREBASE_AUTH_PORT', 9099)}`,
};

/**
 * Dev defaults of the service-to-service client secrets (D-4). They are the values in
 * `.env.example` and `docker-compose.yml`: each caller reads its own as `SERVICE_CLIENT_SECRET`,
 * identity holds the registry as `SERVICE_CLIENT_SECRETS` (JSON, service name -> secret).
 */
export const serviceSecrets = {
  engagement: 'engagement-dev-secret-0000',
  payments: 'payments-dev-secret-00000',
};

export const PLATFORM_TOKEN = 'dev-platform-token-0000';

/**
 * The platform admin identity seeds from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` at boot
 * (idempotent). These are the dev defaults in `.env.example` and `docker-compose.yml`. The platform
 * tenant logs in on host `platform.mio.localhost`. Used by INV-STACK-8 (acting through the stack).
 */
export const platformAdmin = {
  email: 'root@mio.test',
  password: 'platform-dev-password-0000',
  host: 'platform.mio.localhost',
};

export const SERVICES = ['identity', 'engagement', 'payments'] as const;
export type Service = (typeof SERVICES)[number];

export type DbRole = `${Service}_app` | `${Service}_owner` | 'postgres';

/**
 * A pg client logged in as a per-service role: `<service>_app` (the runtime
 * role the service itself uses) or `<service>_owner` (the migration role), or
 * the admin for catalog queries. The service's database is the default.
 */
export async function pgAs(role: DbRole, database?: string): Promise<Client> {
  const password = role === 'postgres' ? 'postgres-dev' : `${role.replace('_', '-')}-dev`;
  const client = new Client({
    host: 'localhost',
    port: Number(port('POSTGRES_PORT', 54329)),
    user: role,
    password,
    database: database ?? (role === 'postgres' ? 'postgres' : role.replace(/_(app|owner)$/, '')),
  });
  await client.connect();
  return client;
}

/** Hits the RabbitMQ management API (port mapped by compose, same credentials as the broker). */
export async function rabbitApi(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = Buffer.from('mio:mio-dev').toString('base64');
  return fetch(`http://localhost:${port('RABBITMQ_MANAGEMENT_PORT', 15672)}/api${path}`, {
    ...init,
    headers: { authorization: `Basic ${auth}`, ...(init.headers ?? {}) },
  });
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
