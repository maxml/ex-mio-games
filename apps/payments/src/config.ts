import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

/** Placeholder service tokens for local development only. Production gets none by default. */
const DEV_SERVICE_TOKENS = { engagement: 'engagement-dev-secret' };

const ServiceTokens = z
  .string()
  .optional()
  .transform((raw, ctx): Record<string, string> => {
    if (raw === undefined || raw === '') return {};
    try {
      return z.record(z.string().min(16)).parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SERVICE_TOKENS must be a JSON object of service name to a secret (16+ chars)',
      });
      return z.NEVER;
    }
  });

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4003),
  AMQP_URL: z.string().min(1),
  /** `{ "engagement": "<secret>" }`: who may call the internal coin commands (placeholder identity). */
  SERVICE_TOKENS: ServiceTokens,
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const config = loadEnv(Env, env);
  // A production process with no tokens refuses every coin command (fails closed); development
  // and tests get the placeholder so the stack works out of the box.
  if (config.NODE_ENV !== 'production' && Object.keys(config.SERVICE_TOKENS).length === 0) {
    return { ...config, SERVICE_TOKENS: { ...DEV_SERVICE_TOKENS } };
  }
  return config;
};

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
