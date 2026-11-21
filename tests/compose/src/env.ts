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

/** A pg client logged in as one of the per-service roles (or the admin, for catalog queries). */
export async function pgAs(
  role: 'identity' | 'engagement' | 'payments' | 'postgres',
): Promise<Client> {
  const password = role === 'postgres' ? 'postgres-dev' : `${role}-dev`;
  const client = new Client({
    host: 'localhost',
    port: Number(port('POSTGRES_PORT', 54329)),
    user: role,
    password,
    database: role === 'postgres' ? 'postgres' : role,
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
