import { createHmac, randomUUID } from 'node:crypto';
import { createTokenVerifier } from '@ex-mio/service-kit';
import type { Audience, EventEnvelope } from '@ex-mio/contracts';
import { FakeIdentityProvider } from '../services/fake-identity-provider';
import { subjectOf } from '../services/access.service';
import { generateSigningKey, type KeyGenerator } from '../services/sessions.service';
import { wireServices, type Services } from '../services/wire';
import { MemoryStore } from './memory-store';

export const KERNEL_BASE_DOMAIN = 'mio.test';
export const KERNEL_KEK = 'kernel-test-kek-0000000000000000';
export const KERNEL_START = 1_800_000_000;

// RSA generation is slow; the kernel hands out a few pre-generated pairs (kids stay unique per kernel).
const pool: Array<ReturnType<KeyGenerator>> = [];
const pooledKeys: KeyGenerator = (() => {
  let i = 0;
  return () => {
    const at = i++ % 3;
    pool[at] ??= generateSigningKey();
    return pool[at] as ReturnType<KeyGenerator>;
  };
})();

export interface KernelOptions {
  outboxFails?: boolean;
  providerDown?: boolean;
  providerClaims?: Record<string, unknown>;
  serviceSecrets?: Partial<Record<'identity' | 'engagement' | 'payments', string>>;
}

/**
 * The test kernel (spec section 7): the real services over in-memory repositories, the fake
 * provider, an in-memory outbox and audit, and a controllable clock. Nothing here is a parallel
 * implementation; `wireServices` is what production uses too.
 */
export async function buildKernel(opts: KernelOptions = {}) {
  const store = new MemoryStore();
  store.outboxFails = opts.outboxFails ?? false;
  const provider = new FakeIdentityProvider({
    ...(opts.providerDown ? { down: true } : {}),
    ...(opts.providerClaims ? { claims: opts.providerClaims } : {}),
  });
  let clock = KERNEL_START;
  const services: Services = wireServices({
    uow: store.uow(),
    repos: store.repos(),
    clock: { now: () => clock },
    provider,
    baseDomain: KERNEL_BASE_DOMAIN,
    kek: KERNEL_KEK,
    serviceSecrets: opts.serviceSecrets ?? {},
    keyGenerator: pooledKeys,
  });
  await services.sessions.init();

  /**
   * Test helper (X-3): sign a launch token with an issued key and exchange it, so a test can see
   * the player token a given credential yields. Not part of the production service.
   */
  const launchWithKey = async (
    key: { key_id: string; hmac_secret: string },
    input: { externalPlayerId: string; audience?: Audience },
  ) => {
    const live = await services.credentials.findLiveByKeyId(key.key_id);
    if (!live) throw new Error('launchWithKey: unknown or revoked key');
    const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = part({ alg: 'HS256', typ: 'JWT', kid: key.key_id });
    const body = part({
      pid: input.externalPlayerId,
      plat: live.row.platform,
      aud: 'mio-launch',
      iat: clock,
      exp: clock + 120,
      jti: randomUUID(),
    });
    const sig = createHmac('sha256', key.hmac_secret).update(`${head}.${body}`).digest('base64url');
    const token = `${head}.${body}.${sig}`;
    return services.launch.exchange({ token, audience: input.audience ?? 'engagement' });
  };

  return {
    ...services,
    sessions: Object.assign(services.sessions, { launchWithKey }),
    store,
    now: () => clock,
    advance: (seconds: number) => {
      clock += seconds;
    },
    sign: (claims: Record<string, unknown>) => services.sessions.sign(claims),
    /** The same verifier every service uses, over the live JWKS (a fresh cache per call). */
    verify: (token: string, audience: string) =>
      createTokenVerifier({
        audience,
        jwks: async () => services.sessions.jwks() as never,
        nowSeconds: () => clock,
      })(token),
    subjectOf,
    auditConsumer: { handle: (e: EventEnvelope) => services.audit.handle(e) },
    outbox: { events: (): EventEnvelope[] => [...store.outbox] },
    provider: {
      calls: provider.calls,
      subjectFor: (userId: string): string =>
        store.providerLinks.find((l) => l.user_id === userId)?.provider_uid ?? '',
    },
  };
}

export type Kernel = Awaited<ReturnType<typeof buildKernel>>;
export type { Audience };
