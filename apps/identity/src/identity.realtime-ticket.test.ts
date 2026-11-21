import 'reflect-metadata';
import { decodePayload } from '@ex-mio/service-kit/testing';
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
