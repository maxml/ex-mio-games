import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4002),
  AMQP_URL: z.string().min(1),
  /** Dev stand-in for identity's integration credentials: JSON keyed by tenant slug. */
  INGEST_STATIC_TENANTS: z.string().optional(),
  /** Wheel seeds by version, JSON `{"1": "seed"}`. Required in production, never logged. */
  WHEEL_SEEDS: z.string().optional(),
  // Identity: JWKS, tenant status, the player mapping and this service's integration credentials.
  IDENTITY_URL: z.string().url(),
  // This service's client-credentials secret (D-4): it mints the service tokens for identity and
  // payments. No default: a secret never falls back to a value in the source.
  SERVICE_CLIENT_SECRET: z.string().min(16),
  // The payments reserve (redemption saga), called with a service token.
  PAYMENTS_URL: z.string().url().default('http://localhost:4003'),
  // Redemption sweeper period in ms; 0 turns it off.
  SWEEPER_INTERVAL_MS: z.coerce.number().int().nonnegative().default(5000),
}).superRefine((env, ctx) => {
  // Redis is optional; when configured in production it must use TLS.
  if (env.NODE_ENV === 'production' && env.REDIS_URL && !env.REDIS_URL.startsWith('rediss://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'production REDIS_URL must use rediss://',
    });
  }
  if (env.NODE_ENV === 'production' && env.INGEST_STATIC_TENANTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INGEST_STATIC_TENANTS'],
      message: 'INGEST_STATIC_TENANTS is a development stand-in: production reads identity',
    });
  }
  if (env.NODE_ENV === 'production' && !env.WHEEL_SEEDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WHEEL_SEEDS'],
      message: 'WHEEL_SEEDS is required in production',
    });
  }
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);
