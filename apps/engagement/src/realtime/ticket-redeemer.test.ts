import { INTERNAL_ROUTES } from '@ex-mio/contracts';
import { IdentityTicketRedeemer } from './ticket-redeemer';
import type { ServiceTokenSource } from '../integrations/identity-client';

/*
 * The redeem contract the gateway assumes (identity's side lands on int/all-fix, D-23):
 * POST /internal/v1/realtime-tickets/redeem, `{ ticket }`, service token aud=identity.
 * Mutation: treat 401 as a failure that is retried, or any non-ok as a principal.
 */

const T = '11111111-1111-4111-8111-111111111111';
const U = '33333333-3333-4333-8333-333333333333';
const tokens = { tokenFor: jest.fn(async () => 'svc-token') } as unknown as ServiceTokenSource;

const answer = (status: number, body: unknown = {}) =>
  jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('IdentityTicketRedeemer', () => {
  it('posts the ticket alone with the service token and returns the principal', async () => {
    const fetchImpl = answer(200, { sub: U, tid: T, roles: ['player'], sandbox: false });
    const r = new IdentityTicketRedeemer('http://identity.test/', tokens, { fetchImpl });
    expect(await r.redeem('tkt')).toEqual({ sub: U, tid: T, roles: ['player'], sandbox: false });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://identity.test${INTERNAL_ROUTES.realtimeTicketRedeem}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ticket: 'tkt' });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer svc-token');
  });

  it.each([400, 401, 403])('a %i answer is a refusal, not a principal', async (status) => {
    const r = new IdentityTicketRedeemer('http://i.test', tokens, {
      fetchImpl: answer(status, { code: 'REALTIME_TICKET_REPLAYED' }),
    });
    expect(await r.redeem('tkt')).toBeNull();
  });

  it('a 5xx or a malformed principal throws (the gateway then refuses the socket)', async () => {
    await expect(
      new IdentityTicketRedeemer('http://i.test', tokens, { fetchImpl: answer(503) }).redeem('t'),
    ).rejects.toThrow();
    await expect(
      new IdentityTicketRedeemer('http://i.test', tokens, {
        fetchImpl: answer(200, { sub: 'x' }),
      }).redeem('t'),
    ).rejects.toThrow();
  });
});
