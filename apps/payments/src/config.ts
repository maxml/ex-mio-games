import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4003),
  AMQP_URL: z.string().min(1),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);
