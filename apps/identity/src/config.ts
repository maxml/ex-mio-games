import 'dotenv/config';
import { z } from 'zod';
import { BaseEnv, loadEnv } from '@ex-mio/service-kit';
import { SERVICE_NAMES } from '@ex-mio/contracts';

const ServiceSecrets = z
  .string()
  .min(2)
  .transform((raw, ctx) => {
    try {
      return z.record(z.enum(SERVICE_NAMES), z.string().min(16)).parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be JSON: {"engagement":"<secret>","payments":"<secret>"} with 16+ character secrets',
      });
      return z.NEVER;
    }
  });

const Env = BaseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4001),
  AMQP_URL: z.string().min(1),
  /** Tenants are `<slug>.<BASE_DOMAIN>`. */
  BASE_DOMAIN: z.string().min(3).default('mio.localhost'),
  /** The platform admin seeded at boot (idempotent). */
  PLATFORM_ADMIN_EMAIL: z.string().email(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(10),
  /** Key-encryption key for integration secrets and the signing keys at rest. */
  CREDENTIALS_KEK: z.string().min(16),
  /** Service name -> client secret, for the client-credentials registry (D-4). */
  SERVICE_CLIENT_SECRETS: ServiceSecrets,
  IDENTITY_PROVIDER: z.enum(['firebase-emulator', 'fake']).default('firebase-emulator'),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().min(1).default('firebase-auth:9099'),
  FIREBASE_PROJECT: z.string().min(1).default('demo-ex-mio'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  const devValues: Array<[string, string]> = [
    ['CREDENTIALS_KEK', env.CREDENTIALS_KEK],
    ['PLATFORM_ADMIN_PASSWORD', env.PLATFORM_ADMIN_PASSWORD],
  ];
  for (const [name, value] of devValues) {
    if (value.includes('dev-') || value.includes('-dev')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'a development value must not be used in production',
      });
    }
  }
  if (env.IDENTITY_PROVIDER === 'fake') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['IDENTITY_PROVIDER'],
      message: 'the fake provider must not be used in production',
    });
  }
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => loadEnv(Env, env);
