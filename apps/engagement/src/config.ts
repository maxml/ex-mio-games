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
}).superRefine((env, ctx) => {
  // Redis is optional; when configured in production it must use TLS.
  if (env.NODE_ENV === 'production' && env.REDIS_URL && !env.REDIS_URL.startsWith('rediss://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'production REDIS_URL must use rediss://',
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
