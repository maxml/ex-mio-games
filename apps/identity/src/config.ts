import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4001),
  AMQP_URL: z.string().min(1),
  // Guards the platform endpoints (tenant registry) until real operator login lands.
  PLATFORM_ADMIN_TOKEN: z.string().min(16),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.PLATFORM_ADMIN_TOKEN.startsWith('dev-')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLATFORM_ADMIN_TOKEN'],
      message: 'a development token must not be used in production',
    });
  }
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);
