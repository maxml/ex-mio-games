import 'reflect-metadata';
import { ActingRequestAuditedV1, type EventEnvelope } from '@ex-mio/contracts';
import { createTestApp } from './testing/app';

/*
 * Fix round 2 re-review, item 6 (D-31 coordinator default): "acting staff are REFUSED on all
 * integration/config writes (PUT reward-api, PUT wheel, PUT rules), audited `refused`, the same in
 * identity and engagement". 6298275 pins the reward-api refusal at the SERVICE level only (ACT-1 calls
 * CredentialsService directly, so the audit decision is never looked at). These go through HTTP, the
 * guard and the audit interceptor, the way engagement's REVIEW-ACT-1 does.
 *
 * FR2-ACT-1 (green): an acting PUT of the reward API is 403 ACTING_FORBIDDEN and its FINAL audit
 *   event says `refused`. Mutation: drop the `subject.acting` check in putRewardApi -> red (the
 *   request reaches `authorize`, which admits an acting admin, and the PUT answers 200 `allowed`).
 * FR2-ACT-2 (RED at 6298275, owner decision): an acting session still ISSUES a casino integration
 *   credential (`POST /v1/credentials`, the same `credentials.rotate` permission as the reward-API
 *   PUT) and receives its api key and HMAC secret, audited `allowed`. With them the holder can sign
 *   launch tokens and ingest events as that casino. It is an integration write under D-31's "all",
 *   but not one of the three named routes, so it stays an owner question (FOLLOW-UP).
 */

const PW = 'correct horse battery';

async function world() {
  const ctx = await createTestApp({});
  const { kernel: k } = ctx;
  const a = await k.staff.signUpOperator({
    tenant_name: 'A',
    slug: 'a',
    email: 'boss@a.test',
    password: PW,
  });
  const platform = await k.tenants.platformTenant();
  await k.staff.createPlatformAdmin({ email: 'root@mio.test', password: PW });
  const root = (
    await k.sessions.login(platform.id, {
      email: 'root@mio.test',
      password: PW,
      audience: 'identity',
    })
  ).access_token;
  const acting = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/acting',
    headers: { authorization: `Bearer ${root}` },
    payload: { tenant_id: a.tenant.id, reason: 'fix round 2 ticket' },
  });
  expect(acting.statusCode).toBe(200);
  const token = (acting.json() as { access_token: string }).access_token;
  return { ...ctx, k, a, token };
}

type W = Awaited<ReturnType<typeof world>>;

async function finalAudit(w: W, route: string) {
  for (let i = 0; i < 100; i += 1) {
    const hit = w.k.outbox
      .events()
      .filter((e: EventEnvelope) => e.type === 'audit.acting_request')
      .map((e: EventEnvelope) => ActingRequestAuditedV1.parse(e.payload))
      .find((p) => p.route === route);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no final audit event for ${route}`);
}

describe('fix round 2: acting staff and integration writes in identity (D-31)', () => {
  it('FR2-ACT-1 an acting PUT of the reward API is refused and audited `refused`', async () => {
    const w = await world();
    // the integration exists, so the "nothing written" read below has something to read
    await w.k.credentials.issue(w.a.tenant.id, 'sim-casino', { environment: 'production' });
    try {
      const res = await w.app.inject({
        method: 'PUT',
        url: '/v1/operator/integrations/sim-casino/reward-api',
        headers: { authorization: `Bearer ${w.token}` },
        payload: { environment: 'production', base_url: 'https://rewards.casino.example/v1' },
      });
      expect({ status: res.statusCode, code: (res.json() as { code?: string }).code }).toEqual({
        status: 403,
        code: 'ACTING_FORBIDDEN',
      });
      expect(await finalAudit(w, 'PUT /v1/operator/integrations/:casino/reward-api')).toMatchObject(
        { decision: 'refused', status: 403 },
      );
      expect((await w.k.credentials.integration(w.a.tenant.id)).reward_api).toBeUndefined();
    } finally {
      await w.app.close();
    }
  });

  it('FR2-ACT-2 an acting session cannot issue a casino integration credential (owner decision)', async () => {
    const w = await world();
    try {
      const res = await w.app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { authorization: `Bearer ${w.token}` },
        payload: { platform: 'sim-casino', environment: 'production' },
      });
      expect({
        status: res.statusCode,
        secretReturned: 'hmac_secret' in (res.json() as object),
      }).toEqual({
        status: 403,
        secretReturned: false,
      });
      expect(await finalAudit(w, 'POST /v1/credentials')).toMatchObject({ decision: 'refused' });
    } finally {
      await w.app.close();
    }
  });
});
