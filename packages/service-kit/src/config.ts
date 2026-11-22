import { z } from 'zod';

/** Env every service reads. A service extends this with its own keys. */
export const BaseEnv = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().min(1),
  AMQP_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
});

/**
 * Parse env with a schema and fail with a readable list of every problem.
 * Production extras (TLS on Redis, no placeholder secrets) belong in the
 * service's own schema `superRefine`.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
