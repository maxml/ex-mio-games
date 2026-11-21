import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw/server';
import { createHttpClient } from '../http';
import { fetchRealtimeTicket } from '../ws/client';
import { createHttpApi } from './http';
import { createHybridApi } from './hybrid';
import { createIsolatedMockApi } from './mock';

// W-9 (cancel carries an Idempotency-Key, the attempt carries the test card, one key per user action),
// W-11 (signup body), W-8 (deposit answer), D-10 (ticket through the BFF), and the hybrid's per-call mock.
// Mutation: drop the key header in `cancelPayment`, or mint a fresh key per `startPayment` call, and the key
// tests go red; route `startGoLive` to the real adapter in `createHybridApi` and the gap test goes red.

const api = () => createHttpApi(createHttpClient({ baseUrl: 'http://api.test' }));

describe('http operator calls', () => {
  it('W-9: cancel sends an Idempotency-Key and keeps it across a lost reply', async () => {
    const keys: Array<string | null> = [];
    let n = 0;
    server.use(
      http.post('*/api/operator/payments/:id/cancel', ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return n++ === 0
          ? HttpResponse.json({ message: 'x' }, { status: 503 })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const a = api();
    await expect(a.operator.cancelPayment('at-1')).rejects.toMatchObject({
      code: 'network-or-server',
    });
    await a.operator.cancelPayment('at-1');
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('W-9: startPayment sends the card number and a key; the retry after a lost reply reuses the key', async () => {
    const seen: Array<{ key: string | null; body: unknown }> = [];
    let n = 0;
    server.use(
      http.post('*/api/operator/payments', async ({ request }) => {
        seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        return n++ === 0
          ? HttpResponse.json({ message: 'x' }, { status: 502 })
          : HttpResponse.json(
              { id: 'a1', plan: 'growth', amount: 799, last4: '4242', status: 'processing' },
              { status: 201 },
            );
      }),
    );
    const a = api();
    await expect(
      a.operator.startPayment('growth', '4242', '4242424242424242'),
    ).rejects.toMatchObject({
      code: 'network-or-server',
    });
    await expect(
      a.operator.startPayment('growth', '4242', '4242424242424242'),
    ).resolves.toMatchObject({
      status: 'processing',
    });
    expect(seen[1]!.key).toBe(seen[0]!.key);
    expect(seen[0]!.body).toEqual({
      planId: 'growth',
      last4: '4242',
      cardNumber: '4242424242424242',
    });
  });

  it('W-11: signup sends the console fields', async () => {
    let body: unknown;
    server.use(
      http.post('*/api/operator/account', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 201 });
      }),
    );
    await api().operator.createAccount({
      companyName: 'Cherry Row Ltd',
      email: 'o@x.io',
      password: 'correct horse',
    });
    expect(body).toEqual({
      companyName: 'Cherry Row Ltd',
      email: 'o@x.io',
      password: 'correct horse',
    });
  });

  it('W-8: a deposit answers "accepted" with no granted count', async () => {
    server.use(http.post('*/api/sandbox/deposits', () => HttpResponse.json({ accepted: true })));
    await expect(api().player.simulateDeposit(40)).resolves.toEqual({ accepted: true });
  });
});

describe('D-10 realtime ticket', () => {
  it('is fetched through the BFF with the cookie; no ticket without a session', async () => {
    server.use(
      http.get('*/api/realtime/ticket', () => HttpResponse.json({ ticket: 't-1', expiresIn: 60 })),
    );
    await expect(fetchRealtimeTicket()).resolves.toBe('t-1');
    server.use(
      http.get('*/api/realtime/ticket', () =>
        HttpResponse.json({ message: 'no' }, { status: 401 }),
      ),
    );
    await expect(fetchRealtimeTicket()).resolves.toBeNull();
  });
});

describe('hybrid: the mock only where no service has an endpoint', () => {
  it('gap calls never reach the real adapter; real calls never reach the mock', async () => {
    let hits = 0;
    server.use(
      http.post('*/api/operator/go-live', () => {
        hits++;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post('*/api/player/spins', () =>
        HttpResponse.json({ id: 's1', index: 1, coins: 5 }, { status: 201 }),
      ),
    );
    const hybrid = createHybridApi(api(), createIsolatedMockApi());
    // go-live is a gap (W-14): the mock's own gate answers, no request goes out
    await expect(hybrid.operator.startGoLive()).rejects.toMatchObject({ code: 'forbidden' });
    expect(hits).toBe(0);
    // spin is real
    await expect(hybrid.player.spin()).resolves.toEqual({ id: 's1', index: 1, coins: 5 });
  });

  it('operator state before any session is the mock state; with a session the real fields win', async () => {
    const mock = createIsolatedMockApi();
    const base = await mock.operator.getState();
    server.use(
      http.get('*/api/operator/state', () =>
        HttpResponse.json({ message: 'sign in' }, { status: 401 }),
      ),
    );
    const hybrid = createHybridApi(api(), mock);
    await expect(hybrid.operator.getState()).resolves.toEqual(base);

    server.use(
      http.get('*/api/operator/state', () =>
        HttpResponse.json({ ...base, accountCreated: true, cardLast4: '4242', rulesSaved: true }),
      ),
    );
    const merged = await hybrid.operator.getState();
    expect(merged.cardLast4).toBe('4242');
    expect(merged.accountCreated).toBe(true);
    // a mock-owned field is not taken from the BFF
    expect(merged.rulesSaved).toBe(base.rulesSaved);
  });

  it('a real failure is not hidden by the mock', async () => {
    server.use(
      http.get('*/api/operator/state', () =>
        HttpResponse.json({ message: 'down' }, { status: 503 }),
      ),
    );
    const hybrid = createHybridApi(api(), createIsolatedMockApi());
    await expect(hybrid.operator.getState()).rejects.toMatchObject({ code: 'network-or-server' });
  });
});
