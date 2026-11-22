import 'reflect-metadata';
import { ActingRequestAuditedV1, uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { createTestApp } from './testing/app';

/*
 * rc review (test owner): what the D-24 fix moved.
 *
 * int/all-fix made the audit `decision` "did a guard refuse": the entry point marks the request when
 * the interceptor runs, so everything the handler answers is `allowed` with its real status. That is
 * right for engagement and payments, whose acting bans are guards (ActingBanGuard, ActingCoinGuard).
 * Identity has no such guard: its PermissionGuard only checks that a route declares a permission,
 * and the authorization itself is `AccessService.authorize` (and `assertMayStartActing`), INSIDE the
 * handler. So every authorization refusal identity makes for an acting session (ACTING_FORBIDDEN,
 * another tenant's object) is now written to the durable audit log as `allowed`.
 *
 * D-24: "the audit decision records the authorization outcome, not the HTTP outcome".
 *
 * Was red when written: INV-ID-AUD-2, INV-ID-AUD-3 (`allowed` with 403).
 * Green pins: INV-ID-AUD-1 (a 404 from the handler is `allowed` with status 404, D-24 example).
 * Mutation for INV-ID-AUD-1: `auditDecision` returns `status < 400 ? 'allowed' : 'refused'` -> red.
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
  const b = await k.staff.signUpOperator({
    tenant_name: 'B',
    slug: 'b',
    email: 'boss@b.test',
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
    payload: { tenant_id: a.tenant.id, reason: 'rc review ticket' },
  });
  expect(acting.statusCode).toBe(200);
  const token = (acting.json() as { access_token: string }).access_token;
  return { ...ctx, k, a, b, token };
}

type W = Awaited<ReturnType<typeof world>>;

/** The FINAL audit.acting_request event for `route` (finalize runs after the response is sent). */
async function finalAudit(
  w: W,
  route: string,
): Promise<ReturnType<typeof ActingRequestAuditedV1.parse>> {
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

describe('rc review: identity audit decision is the authorization outcome (D-24)', () => {
  it('INV-ID-AUD-1 a handler 404 for an allowed acting request is `allowed` with status 404', async () => {
    const w = await world();
    try {
      const res = await w.app.inject({
        method: 'GET',
        url: `/v1/players/${uuidv7()}`,
        headers: { authorization: `Bearer ${w.token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(await finalAudit(w, 'GET /v1/players/:userId')).toMatchObject({
        decision: 'allowed',
        status: 404,
      });
    } finally {
      await w.app.close();
    }
  });

  it('INV-ID-AUD-2 an acting session asking to start acting again is refused (ACTING_FORBIDDEN) and audited `refused`', async () => {
    const w = await world();
    try {
      const res = await w.app.inject({
        method: 'POST',
        url: '/v1/auth/acting',
        headers: { authorization: `Bearer ${w.token}` },
        payload: { tenant_id: w.b.tenant.id, reason: 'rc review ticket' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ACTING_FORBIDDEN' });
      expect(await finalAudit(w, 'POST /v1/auth/acting')).toMatchObject({
        decision: 'refused',
        status: 403,
      });
    } finally {
      await w.app.close();
    }
  });

  it("INV-ID-AUD-3 an acting session reading another tenant's object is refused and audited `refused`", async () => {
    const w = await world();
    try {
      const res = await w.app.inject({
        method: 'GET',
        url: `/v1/tenants/${w.b.tenant.id}`,
        headers: { authorization: `Bearer ${w.token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(await finalAudit(w, 'GET /v1/tenants/:id')).toMatchObject({
        decision: 'refused',
        status: 403,
      });
    } finally {
      await w.app.close();
    }
  });
});
