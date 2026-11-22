import 'reflect-metadata';
import { runWithTenant } from '@ex-mio/tenancy';
import type { Db } from '@ex-mio/service-kit';
import { SpinService } from './spin.service';

/*
 * rc review (test owner), money path item 6: env-scoped spin credits.
 *
 * `spin()` reads the environment with `currentAuth()` (in the controller), which THROWS without an
 * auth context. `availableSpins()` reads it with `tryCurrentAuth()?.sandbox === true`, so a call that
 * has a tenant and a player but no auth context silently counts PRODUCTION credits. Over HTTP the
 * two contexts are set together by the service-kit interceptor, so this is latent; but the default
 * is the unsafe one, and it is the only env-scoped read that has it. Fail closed instead: no auth
 * context, no environment, no answer.
 *
 * Was red when written: INV-SPIN-ENV-NOAUTH.
 */

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const PLAYER = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';

describe('rc review: env-scoped credit reads never default to production', () => {
  it('INV-SPIN-ENV-NOAUTH availableSpins without an auth context refuses instead of counting production credits', async () => {
    const asked: Array<{ sandbox: boolean }> = [];
    const db = { tenantTx: <T>(fn: (tx: unknown) => Promise<T>) => fn({}) } as unknown as Db;
    const credits = {
      countAvailable: async (_tx: unknown, input: { sandbox: boolean }) => {
        asked.push({ sandbox: input.sandbox });
        return 7;
      },
    };
    const service = new SpinService(
      db,
      credits as never,
      {} as never,
      {} as never,
      { current: () => ({ version: 1, seed: 's' }) } as never,
    );
    const outcome = await runWithTenant({ tenantId: TENANT, principalId: PLAYER }, () =>
      service.availableSpins().then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
    );
    expect(asked).toEqual([]); // no environment was guessed
    expect(outcome.ok).toBe(false);
  });
});
