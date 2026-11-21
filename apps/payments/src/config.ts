import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

// The webhook secret (`FAKE_PROVIDER_WEBHOOK_SECRET`) is read by `selectPaymentProvider`, which refuses
// to start a production process without one (D-20); there is no value in the source to fall back to.
const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4003),
  AMQP_URL: z.string().min(1),
  /** Identity: the source of the JWKS and the tenant status, for the one service-kit auth entry point (D-4). */
  IDENTITY_URL: z.string().url(),
  /** Seconds between two runs of the ledger jobs in the worker (reconciliation, usage report). 0 turns them off. */
  LEDGER_JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(3600),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);

/** Max connections of the runtime pool (`PG_POOL_MAX`, default 10). */
export function defaultPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PG_POOL_MAX ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}

/**
 * Salt of the monthly-active-player key. The key is a salted hash, so the usage tables hold no
 * player id. Development gets a fixed salt; production must set `USAGE_KEY_SALT`, otherwise metering
 * a player fails closed (it throws) rather than storing an unsalted or unstable key.
 */
export function usageKeySalt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const salt = env.USAGE_KEY_SALT;
  if (salt && salt.length >= 16) return salt;
  return env.NODE_ENV === 'production' ? undefined : 'dev-usage-key-salt-not-for-production';
}
