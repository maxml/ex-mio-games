import 'reflect-metadata';
import { decodePayload, signLaunchToken } from '@ex-mio/service-kit/testing';
import { createTestApp } from './testing/app';

/*
 * Reviewer RED tests (identity epic review, coordinator decision D-22, with D-10):
 * `POST /v1/auth/realtime-ticket` is an identity route. It turns the caller's session into a
 * one-time socket ticket: `aud=realtime`, lifetime <= 60 s, usable once.
 *
 * Choke points:
 *  - issuing: the identity route (HTTP edge) and SessionsService;
 *  - single use: `SessionsService.redeemRealtimeTicket(ticket)`, the one place a realtime host
 *    turns a ticket into a principal. The name is the reviewer's proposal for the seam (no gateway
 *    exists yet, G-9); if the coordinator picks another transport (an internal route, a verifier in
 *    service-kit with a jti store), these tests move with it, the properties stay.
 *
 * The consumer already exists: the web BFF (`GET /api/realtime/ticket`) posts `{}` with the
 * player's engagement session, or the operator's identity token, and reads `{ ticket, expires_in }`.
 *
 * RED today: the route and the redeem seam do not exist.
 */

const PW = 'correct horse battery';

async function world() {
  const ctx = await createTestApp();
  const k = ctx.kernel;
  const a = await k.staff.signUpOperator({
    tenant_name: 'A',
    slug: 'aa',
    email: 'boss@a.test',
    password: PW,
  });
  const key = await k.credentials.issue(a.tenant.id, 'sim-casino');
  const session = await k.sessions.launchWithKey(key, { externalPlayerId: 'ext-1' });
  const operator = (
    await k.sessions.login(a.tenant.id, {
      email: 'boss@a.test',
      password: PW,
      audience: 'identity',
    })
  ).access_token;
  const ticket = (bearer: string | undefined, payload: unknown = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/realtime-ticket',
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      payload: payload as never,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions = k.sessions as any;
  return { ...ctx, k, a, session, operator, ticket, sessions };
}

type TicketClaims = {
  aud: string | string[];
  sub: string;
  tid: string;
  roles: string[];
  iat: number;
  exp: number;
  jti: string;
};

describe('RT-TICKET: one-time realtime ticket (D-10, D-22)', () => {
  // Mutation: no route, a ticket for another audience, or a lifetime above 60 s.
  it('RT-1 a player session gets a ticket with aud=realtime only, its own sub and tenant, and a lifetime <= 60 s', async () => {
    const w = await world();
    const res = await w.ticket(w.session.access_token);
    expect([200, 201]).toContain(res.statusCode);
    const body = res.json() as { ticket: string; expires_in: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.expires_in).toBeLessThanOrEqual(60);
    const claims = decodePayload(body.ticket) as TicketClaims;
    expect(([] as string[]).concat(claims.aud)).toEqual(['realtime']);
    expect(claims).toMatchObject({
      sub: w.session.user_id,
      tid: w.a.tenant.id,
      roles: ['player'],
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    expect(claims.jti.length).toBeGreaterThanOrEqual(8);
  });

  // The web BFF calls it with the operator's identity token when it has one.
  it("RT-1b an operator's identity token gets a ticket for its own tenant", async () => {
    const w = await world();
    const res = await w.ticket(w.operator);
    expect([200, 201]).toContain(res.statusCode);
    const claims = decodePayload((res.json() as { ticket: string }).ticket) as TicketClaims;
    expect(([] as string[]).concat(claims.aud)).toEqual(['realtime']);
    expect(claims.tid).toBe(w.a.tenant.id);
  });

  // Mutation: the route is @Public, or accepts a body that names an audience or a tenant.
  it('RT-2 no token is 401; a body naming another audience or a tenant is 400 VALIDATION_FAILED', async () => {
    const w = await world();
    expect((await w.ticket(undefined)).statusCode).toBe(401);
    for (const payload of [{ audience: 'engagement' }, { tenant_id: w.a.tenant.id }]) {
      const res = await w.ticket(w.session.access_token, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  // Mutation: the ticket carries engagement/payments/identity in aud (a 60 s bearer for the APIs).
  it('RT-3 a ticket is refused by the verifier of every non-realtime audience', async () => {
    const w = await world();
    const { ticket } = (await w.ticket(w.session.access_token)).json() as { ticket: string };
    expect(typeof ticket).toBe('string'); // not vacuous: a missing route yields no ticket
    await expect(w.k.verify(ticket, 'realtime')).resolves.toBeDefined();
    for (const audience of ['engagement', 'payments', 'identity', 'web']) {
      await expect(w.k.verify(ticket, audience)).rejects.toBeDefined();
    }
  });

  // Mutation: no jti store, or the store is checked after the principal is returned.
  it('RT-4 a ticket is redeemed once: the second use is refused', async () => {
    const w = await world();
    const { ticket } = (await w.ticket(w.session.access_token)).json() as { ticket: string };
    expect(typeof w.sessions.redeemRealtimeTicket).toBe('function');
    await expect(w.sessions.redeemRealtimeTicket(ticket)).resolves.toMatchObject({
      sub: w.session.user_id,
      tid: w.a.tenant.id,
    });
    await expect(w.sessions.redeemRealtimeTicket(ticket)).rejects.toMatchObject({
      code: 'REALTIME_TICKET_REPLAYED',
    });
  });

  // Mutation: redeem accepts any token with realtime in aud (the 15-minute player session would
  // then work as a socket ticket), or ignores expiry.
  it('RT-5 redeem refuses the long-lived player session and an expired ticket', async () => {
    const w = await world();
    expect(typeof w.sessions.redeemRealtimeTicket).toBe('function');
    await expect(w.sessions.redeemRealtimeTicket(w.session.access_token)).rejects.toBeDefined();
    const { ticket } = (await w.ticket(w.session.access_token)).json() as { ticket: string };
    w.k.advance(120);
    await expect(w.sessions.redeemRealtimeTicket(ticket)).rejects.toBeDefined();
  });
});

/*
 * int/all review, D-23: the realtime gateway redeems through an INTERNAL identity route with a
 * service token, allow-listed for the service that hosts the gateway. No gateway exists yet; the
 * host is taken to be engagement (it owns the pushed redemption status, overview §"websocket"). If
 * the owner picks another host, only the client name below changes; the properties stay.
 *
 * Contract (proposed by the reviewer, pinned in identity.contracts.test.ts):
 *   INTERNAL_ROUTES.realtimeTicketRedeem = '/internal/v1/realtime-tickets/redeem'
 *   POST, tenant-less (`@InternalTenantless`: the tenant is the ticket's own `tid`), body
 *   `{ ticket }` (strict), answer `RealtimeTicketRedeemResponse`; SERVICE_CALL_POLICY.engagement.identity
 *   lists `POST /internal/v1/realtime-tickets/redeem`, no other client does.
 *
 * RED today: the route does not exist (404).
 */
const REDEEM = '/internal/v1/realtime-tickets/redeem';
const SVC_SECRETS = {
  engagement: 'engagement-test-secret-0001',
  payments: 'payments-test-secret-00001',
};

async function gatewayWorld() {
  const ctx = await createTestApp({ serviceClients: SVC_SECRETS });
  const k = ctx.kernel;
  const a = await k.staff.signUpOperator({
    tenant_name: 'A',
    slug: 'aa',
    email: 'boss@a.test',
    password: PW,
  });
  const key = await k.credentials.issue(a.tenant.id, 'sim-casino');
  const session = await k.sessions.launchWithKey(key, { externalPlayerId: 'ext-1' });
  const operator = (
    await k.sessions.login(a.tenant.id, {
      email: 'boss@a.test',
      password: PW,
      audience: 'identity',
    })
  ).access_token;
  const serviceToken = async (who: keyof typeof SVC_SECRETS) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/service-token',
      payload: { client_id: who, client_secret: SVC_SECRETS[who], audience: 'identity' },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { access_token: string }).access_token;
  };
  const newTicket = async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/realtime-ticket',
      headers: { authorization: `Bearer ${session.access_token}` },
      payload: {},
    });
    return (res.json() as { ticket: string }).ticket;
  };
  const redeem = (bearer: string | undefined, payload: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: REDEEM,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      payload: payload as never,
    });
  return { ...ctx, k, a, session, operator, serviceToken, newTicket, redeem };
}

describe('RT-REDEEM: the gateway redeems a ticket over the internal identity route (D-23)', () => {
  // Mutation: no route; the route answers without recording the jti; it returns more than the principal.
  it('RT-6 the gateway host (svc:engagement) redeems a ticket once: 200 with the principal, then 401 REALTIME_TICKET_REPLAYED', async () => {
    const w = await gatewayWorld();
    const svc = await w.serviceToken('engagement');
    const ticket = await w.newTicket();
    const first = await w.redeem(svc, { ticket });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ sub: w.session.user_id, tid: w.a.tenant.id, roles: ['player'] });
    const second = await w.redeem(svc, { ticket });
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ code: 'REALTIME_TICKET_REPLAYED' });
  });

  // Mutation: the route is @Public or takes a user token; the allow-list check is skipped for it, or
  // lists payments. A refused call must not consume the ticket either.
  it('RT-7 only the allow-listed service may redeem: no token and user tokens are 401, svc:payments is 403; none of them consumes the ticket', async () => {
    const w = await gatewayWorld();
    const ticket = await w.newTicket();
    expect((await w.redeem(undefined, { ticket })).statusCode).toBe(401);
    expect((await w.redeem(w.session.access_token, { ticket })).statusCode).toBe(401);
    expect((await w.redeem(w.operator, { ticket })).statusCode).toBe(401);
    expect((await w.redeem(ticket, { ticket })).statusCode).toBe(401); // a ticket is not a bearer
    const byPayments = await w.redeem(await w.serviceToken('payments'), { ticket });
    expect(byPayments.statusCode).toBe(403);
    expect(byPayments.json()).toMatchObject({ code: 'SERVICE_CALL_FORBIDDEN' });
    // still unused: the gateway's own redeem is the first one
    expect((await w.redeem(await w.serviceToken('engagement'), { ticket })).statusCode).toBe(200);
  });

  // Mutation: the route accepts the 15-minute player session as a ticket, or reads extra body fields
  // (a tenant or a subject chosen by the caller).
  it('RT-8 the route refuses a session in place of a ticket (401 TOKEN_INVALID) and a body with any other field (400)', async () => {
    const w = await gatewayWorld();
    const svc = await w.serviceToken('engagement');
    const asTicket = await w.redeem(svc, { ticket: w.session.access_token });
    expect(asTicket.statusCode).toBe(401);
    expect(asTicket.json()).toMatchObject({ code: 'TOKEN_INVALID' });
    const ticket = await w.newTicket();
    for (const extra of [{ tenant_id: w.a.tenant.id }, { sub: w.session.user_id }]) {
      const res = await w.redeem(svc, { ticket, ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await w.redeem(svc, {})).statusCode).toBe(400);
    // the refused calls did not consume it
    expect((await w.redeem(svc, { ticket })).statusCode).toBe(200);
  });

  // Mutation: the redeem route ignores the tenant status (a suspended tenant's socket opens).
  it('RT-9 a ticket of a tenant suspended after issue is refused at redeem (403 TENANT_SUSPENDED)', async () => {
    const w = await gatewayWorld();
    const svc = await w.serviceToken('engagement');
    const ticket = await w.newTicket();
    await w.k.tenants.setStatus(w.a.tenant.id, 'suspended');
    const res = await w.redeem(svc, { ticket });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
  });

  // D-23: `realtime` appears only in a ticket; INV-LAUNCH-8/8b pin the minted sessions, this pins
  // the request bodies at the HTTP edge. Mutation: a controller parses login or launch with the
  // `Audience` enum (which has realtime) instead of `RequestedAudience`.
  it('RT-10 login and launch bodies asking for audience realtime are 400 VALIDATION_FAILED; the same bodies for engagement work', async () => {
    const w = await gatewayWorld();
    const login = (audience: string) =>
      w.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { host: 'aa.mio.test' },
        payload: { email: 'boss@a.test', password: PW, audience },
      });
    expect((await login('engagement')).statusCode).toBe(200);
    const badLogin = await login('realtime');
    expect(badLogin.statusCode).toBe(400);
    expect(badLogin.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const key = await w.k.credentials.issue(w.a.tenant.id, 'sim-casino');
    const launch = (audience: string) =>
      w.app.inject({
        method: 'POST',
        url: '/v1/auth/launch',
        payload: {
          token: signLaunchToken({
            keyId: key.key_id,
            secret: key.hmac_secret,
            now: w.k.now(),
            externalPlayerId: `ext-${audience}`,
          }),
          audience,
        },
      });
    const badLaunch = await launch('realtime');
    expect(badLaunch.statusCode).toBe(400);
    expect(badLaunch.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await launch('engagement')).statusCode).toBe(200);
  });
});
