import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4002),
  AMQP_URL: z.string().min(1),
}).superRefine((env, ctx) => {
  // Redis is optional; when configured in production it must use TLS.
  if (env.NODE_ENV === 'production' && env.REDIS_URL && !env.REDIS_URL.startsWith('rediss://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'production REDIS_URL must use rediss://',
    });
  }
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);
