import 'dotenv/config';
import { z } from 'zod';
import { corsAllowsAnyOrigin } from './cors';

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().optional(),
    // Custom auth secrets. The custom auth core (@ex-mio/auth/custom)
    // reads these from process.env directly; they are listed here for typing and
    // fail-fast DX. AUTH_SECRET signs local session/state tokens — the core
    // throws in production when it is missing or left at its placeholder. The
    // GOOGLE_* trio is only required for the Google OAuth flow.
    AUTH_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production' || databaseUrlUsesTls(cfg.DATABASE_URL)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        'Production DATABASE_URL must enable SSL/TLS (Mongo: mongodb+srv:// or tls=true; Postgres: sslmode=require/verify-ca/verify-full).',
    });
  })
  .superRefine((cfg, ctx) => {
    // CORS credentials are enabled (server.ts/io-adapter set `credentials: true`),
    // so a wildcard would be an allow-any-origin-with-credentials hole. Forbid it
    // in production whether it is a lone `*` OR a `*` hiding in a list (e.g.
    // `https://app.example.com,*`) — both expand to allow-any once the list is
    // split. `*` stays valid in dev only. Parsing goes through the shared helper
    // so the guard never drifts from how server.ts/io-adapter read the same value.
    if (cfg.NODE_ENV !== 'production' || !corsAllowsAnyOrigin(cfg.CORS_ORIGIN)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ORIGIN'],
      message:
        "CORS_ORIGIN must not allow any origin ('*', or a '*' inside the list) in production — credentials are enabled; set an explicit comma-separated allow-list.",
    });
  })
  .superRefine((cfg, ctx) => {
    // Redis is optional; when it is configured in production it must use TLS,
    // mirroring the DATABASE_URL guard. Skip entirely when REDIS_URL is unset.
    if (cfg.NODE_ENV !== 'production' || !cfg.REDIS_URL || redisUrlUsesTls(cfg.REDIS_URL)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'Production REDIS_URL must enable TLS (use rediss:// or add tls=true).',
    });
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}

function databaseUrlUsesTls(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'mongodb+srv:') return true;

    const tls = url.searchParams.get('tls') ?? url.searchParams.get('ssl');
    if (tls?.toLowerCase() === 'true') return true;

    const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
    return sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full';
  } catch {
    return false;
  }
}

function redisUrlUsesTls(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'rediss:') return true;

    const tls = url.searchParams.get('tls') ?? url.searchParams.get('ssl');
    return tls?.toLowerCase() === 'true';
  } catch {
    return false;
  }
}
