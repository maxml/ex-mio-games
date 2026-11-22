import { HealthCheck } from '@ex-mio/contracts';
import { buildServer, signBody } from './server';

describe('casino-sim', () => {
  const app = buildServer({ keyA: 'ka', secretB: 'sb' });
  afterAll(() => app.close());

  it('health matches the shared contract', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz/ready' });
    expect(HealthCheck.safeParse(res.json()).success).toBe(true);
  });

  it('Casino A credits once per reference', async () => {
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/casino-a/v1/wallet/credit',
        headers: { 'x-api-key': 'ka' },
        payload: { player: 'p1', amount: 10, reference: 'r1' },
      });
    expect((await call()).json().balance).toBe(10);
    expect((await call()).json().balance).toBe(10);
  });

  it('Casino A refuses a wrong key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/casino-a/v1/wallet/credit',
      headers: { 'x-api-key': 'no' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('Casino B demands a valid signature and speaks cents', async () => {
    const body = JSON.stringify({ player_id: 'p1', amount_cents: 250, reference: 'r1' });
    const bad = await app.inject({
      method: 'POST',
      url: '/casino-b/api/transactions',
      headers: { 'content-type': 'application/json', 'x-signature': '00' },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/casino-b/api/transactions',
      headers: { 'content-type': 'application/json', 'x-signature': signBody('sb', body) },
      payload: body,
    });
    expect(ok.json()).toEqual({ result: { code: 0, balance_cents: 250 } });
  });

  it('fault injection returns a 500 on request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/casino-a/v1/wallet/credit',
      headers: { 'x-api-key': 'ka', 'x-fault': 'error' },
      payload: { player: 'p1', amount: 1, reference: 'r9' },
    });
    expect(res.statusCode).toBe(500);
  });
});
